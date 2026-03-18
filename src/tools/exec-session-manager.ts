import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import * as pty from "node-pty";

export interface UnifiedExecResult {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	session_id?: number;
	original_token_count?: number;
}

export interface ExecCommandInput {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
	login?: boolean;
}

export interface WriteStdinInput {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

interface BaseExecSession {
	id: number;
	command: string;
	buffer: string;
	emittedBuffer: string;
	exitCode: number | null | undefined;
	listeners: Set<() => void>;
	interactive: boolean;
}

interface PipeExecSession extends BaseExecSession {
	kind: "pipe";
	child: ChildProcessByStdio<null, Readable, Readable>;
}

interface PtyExecSession extends BaseExecSession {
	kind: "pty";
	child: pty.IPty;
	terminalCommitted: string;
	terminalLine: string[];
	terminalCursor: number;
}

type ExecSession = PipeExecSession | PtyExecSession;

export interface ExecSessionManager {
	exec(input: ExecCommandInput, cwd: string, signal?: AbortSignal): Promise<UnifiedExecResult>;
	write(input: WriteStdinInput): Promise<UnifiedExecResult>;
	hasSession(sessionId: number): boolean;
	getSessionCommand(sessionId: number): string | undefined;
	onSessionExit(listener: (sessionId: number, command: string) => void): () => void;
	shutdown(): void;
}

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const MAX_COMMAND_HISTORY = 256;

function resolveWorkdir(baseCwd: string, workdir?: string): string {
	if (!workdir) return baseCwd;
	return resolve(baseCwd, workdir);
}

function resolveShell(shell?: string): string {
	return shell || process.env.SHELL || "/bin/bash";
}

function clampYieldTime(yieldTimeMs: number | undefined, fallback: number): number {
	const value = yieldTimeMs ?? fallback;
	return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, value));
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
	return Math.max(256, maxOutputTokens * 4);
}

function stripTerminalControlSequences(text: string, preserveCsi = false): string {
	const withoutOscAndDcs = text
		.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B[P_X^][\s\S]*?\u001B\\/g, "");
	if (preserveCsi) {
		return withoutOscAndDcs;
	}
	return withoutOscAndDcs.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001B[@-_]/g, "");
}

function sanitizeBinaryOutput(text: string, preserveBackspace = false): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (preserveBackspace && code === 0x08) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

function normalizePipeOutput(text: string): string {
	return sanitizeBinaryOutput(stripTerminalControlSequences(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function writeTerminalChar(session: PtyExecSession, char: string): void {
	if (session.terminalCursor > session.terminalLine.length) {
		session.terminalLine.push(...Array.from({ length: session.terminalCursor - session.terminalLine.length }, () => " "));
	}
	session.terminalLine[session.terminalCursor] = char;
	session.terminalCursor += 1;
}

function applyTerminalOutput(session: PtyExecSession, text: string): string {
	const sanitized = stripTerminalControlSequences(text, true);
	if (sanitized.length === 0) {
		return session.terminalCommitted + session.terminalLine.join("");
	}

	for (let index = 0; index < sanitized.length; index += 1) {
		const char = sanitized[index]!;
		if (char === "\u001b") {
			if (sanitized[index + 1] === "[") {
				let sequenceEnd = index + 2;
				while (sequenceEnd < sanitized.length) {
					const code = sanitized.charCodeAt(sequenceEnd);
					if (code >= 0x40 && code <= 0x7e) {
						break;
					}
					sequenceEnd += 1;
				}
				if (sequenceEnd >= sanitized.length) {
					break;
				}
				const params = sanitized.slice(index + 2, sequenceEnd);
				const finalByte = sanitized[sequenceEnd];
				if (finalByte === "K") {
					const mode = Number(params || "0");
					if (mode === 0) {
						session.terminalLine = session.terminalLine.slice(0, session.terminalCursor);
					} else if (mode === 1) {
						session.terminalLine = [
							...Array.from({ length: Math.min(session.terminalCursor, session.terminalLine.length) }, () => " "),
							...session.terminalLine.slice(session.terminalCursor),
						];
					} else if (mode === 2) {
						session.terminalLine = [];
					}
				}
				index = sequenceEnd;
				continue;
			}

			const next = sanitized[index + 1];
			if (next && /[()*+,\-./]/.test(next) && index + 2 < sanitized.length) {
				index += 2;
				continue;
			}
			if (next) {
				index += 1;
			}
			continue;
		}

		const code = char.codePointAt(0);
		if (code !== undefined && code <= 0x1f && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") {
			continue;
		}

		switch (char) {
			case "\r":
				session.terminalCursor = 0;
				break;
			case "\n":
				session.terminalCommitted += `${session.terminalLine.join("")}\n`;
				session.terminalLine = [];
				session.terminalCursor = 0;
				break;
			case "\b":
				session.terminalCursor = Math.max(0, session.terminalCursor - 1);
				break;
			default:
				writeTerminalChar(session, char);
				break;
		}
	}

	return session.terminalCommitted + session.terminalLine.join("");
}

function computePtyDelta(previous: string, current: string): string {
	if (current.startsWith(previous)) {
		return current.slice(previous.length);
	}

	const lineStart = previous.lastIndexOf("\n") + 1;
	const stablePrefix = previous.slice(0, lineStart);
	if (current.startsWith(stablePrefix)) {
		return `\r${current.slice(lineStart)}`;
	}

	return current;
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function consumeOutput(session: ExecSession, maxOutputTokens?: number): { output: string; original_token_count?: number } {
	const text =
		session.kind === "pty" ? computePtyDelta(session.emittedBuffer, session.buffer) : session.buffer.slice(session.emittedBuffer.length);
	session.emittedBuffer = session.buffer;
	if (text.length === 0) {
		return { output: "" };
	}

	const maxChars = maxCharsForTokens(maxOutputTokens);
	const originalTokenCount = Math.ceil(text.length / 4);
	if (text.length <= maxChars) {
		return { output: text, original_token_count: originalTokenCount };
	}

	return {
		output: text.slice(-maxChars),
		original_token_count: originalTokenCount,
	};
}

function registerAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): () => void {
	if (!signal) {
		return () => {};
	}

	if (signal.aborted) {
		onAbort();
		return () => {};
	}

	const abortListener = () => onAbort();
	signal.addEventListener("abort", abortListener, { once: true });
	return () => signal.removeEventListener("abort", abortListener);
}

export function createExecSessionManager(): ExecSessionManager {
	let nextSessionId = 1;
	const sessions = new Map<number, ExecSession>();
	const commandHistory = new Map<number, string>();
	const exitListeners = new Set<(sessionId: number, command: string) => void>();

	function rememberCommand(sessionId: number, command: string): void {
		commandHistory.set(sessionId, command);
		if (commandHistory.size <= MAX_COMMAND_HISTORY) {
			return;
		}
		const oldest = commandHistory.keys().next().value;
		if (oldest !== undefined) {
			commandHistory.delete(oldest);
		}
	}

	function notify(session: ExecSession): void {
		for (const listener of session.listeners) {
			listener();
		}
	}

	function finalizeSession(session: ExecSession): void {
		for (const listener of exitListeners) {
			listener(session.id, session.command);
		}
		notify(session);
	}

	function appendOutput(session: ExecSession, text: string): void {
		if (text.length === 0) return;
		session.buffer =
			session.kind === "pty" ? applyTerminalOutput(session, text) : `${session.buffer}${normalizePipeOutput(text)}`;
		notify(session);
	}

	function waitForExitOrTimeout(session: ExecSession, yieldTimeMs: number): Promise<number> {
		if (session.exitCode !== undefined && session.exitCode !== null) {
			return Promise.resolve(0);
		}

		const startedAt = Date.now();
		return new Promise((resolvePromise) => {
			const onWake = () => {
				if (session.exitCode === undefined || session.exitCode === null) {
					return;
				}
				cleanup();
				resolvePromise(Date.now() - startedAt);
			};
			const timeout = setTimeout(() => {
				cleanup();
				resolvePromise(Date.now() - startedAt);
			}, yieldTimeMs);
			const cleanup = () => {
				clearTimeout(timeout);
				session.listeners.delete(onWake);
			};
			session.listeners.add(onWake);
		});
	}

	function makeResult(session: ExecSession, waitMs: number, maxOutputTokens?: number): UnifiedExecResult {
		const consumed = consumeOutput(session, maxOutputTokens);
		const result: UnifiedExecResult = {
			chunk_id: generateChunkId(),
			wall_time_seconds: waitMs / 1000,
			output: consumed.output,
		};
		if (consumed.original_token_count !== undefined) {
			result.original_token_count = consumed.original_token_count;
		}
		if (session.exitCode === undefined || session.exitCode === null) {
			result.session_id = session.id;
		} else {
			result.exit_code = session.exitCode;
			if (session.emittedBuffer === session.buffer) {
				sessions.delete(session.id);
			}
		}
		return result;
	}

	function createPipeSession(input: ExecCommandInput, workdir: string, shell: string, signal?: AbortSignal): PipeExecSession {
		const login = input.login ?? true;
		const shellArgs = login ? ["-lc", input.cmd] : ["-c", input.cmd];
		const child = spawn(shell, shellArgs, {
			cwd: workdir,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		const session: PipeExecSession = {
			kind: "pipe",
			id: nextSessionId++,
			command: input.cmd,
			child,
			buffer: "",
			emittedBuffer: "",
			exitCode: undefined,
			listeners: new Set(),
			interactive: false,
		};

		child.stdout.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.stderr.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.on("close", (code) => {
			session.exitCode = code ?? 0;
			finalizeSession(session);
		});
		child.on("error", (error) => {
			appendOutput(session, `${error.message}\n`);
			session.exitCode = 1;
			finalizeSession(session);
		});

		registerAbortHandler(signal, () => {
			if (session.exitCode === undefined) {
				child.kill("SIGTERM");
			}
		});

		return session;
	}

	function createPtySession(input: ExecCommandInput, workdir: string, shell: string, signal?: AbortSignal): PtyExecSession {
		const login = input.login ?? true;
		const shellArgs = login ? ["-lc", input.cmd] : ["-c", input.cmd];
		const child = pty.spawn(shell, shellArgs, {
			cwd: workdir,
			env: process.env,
			name: process.env.TERM || "xterm-256color",
			cols: 80,
			rows: 24,
		});

		const session: PtyExecSession = {
			kind: "pty",
			id: nextSessionId++,
			command: input.cmd,
			child,
			buffer: "",
			emittedBuffer: "",
			exitCode: undefined,
			listeners: new Set(),
			interactive: true,
			terminalCommitted: "",
			terminalLine: [],
			terminalCursor: 0,
		};

		child.onData((data) => {
			appendOutput(session, data);
		});
		child.onExit(({ exitCode }) => {
			session.exitCode = exitCode ?? 0;
			finalizeSession(session);
		});

		registerAbortHandler(signal, () => {
			if (session.exitCode === undefined) {
				child.kill();
			}
		});

		return session;
	}

	return {
		exec: async (input, cwd, signal) => {
			const shell = resolveShell(input.shell);
			const workdir = resolveWorkdir(cwd, input.workdir);
			const session = input.tty
				? createPtySession(input, workdir, shell, signal)
				: createPipeSession(input, workdir, shell, signal);
			sessions.set(session.id, session);
			rememberCommand(session.id, session.command);

			const waitedMs = await waitForExitOrTimeout(session, clampYieldTime(input.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS));
			return makeResult(session, waitedMs, input.max_output_tokens);
		},
		write: async (input) => {
			const session = sessions.get(input.session_id);
			if (!session) {
				throw new Error(`Unknown process id ${input.session_id}`);
			}
			if (input.chars && input.chars.length > 0) {
				if (!session.interactive) {
					throw new Error("stdin is closed for this session; rerun exec_command with tty=true to keep stdin open");
				}
				if (session.kind === "pty") {
					session.child.write(input.chars);
				}
			}
			const waitedMs =
				session.exitCode === undefined
					? await waitForExitOrTimeout(session, clampYieldTime(input.yield_time_ms, DEFAULT_WRITE_YIELD_TIME_MS))
					: 0;
			return makeResult(session, waitedMs, input.max_output_tokens);
		},
		hasSession: (sessionId) => sessions.has(sessionId),
		getSessionCommand: (sessionId) => sessions.get(sessionId)?.command ?? commandHistory.get(sessionId),
		onSessionExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		shutdown: () => {
			for (const session of sessions.values()) {
				if (session.exitCode !== undefined) {
					continue;
				}
				if (session.kind === "pty") {
					session.child.kill();
				} else {
					session.child.kill("SIGTERM");
				}
			}
			sessions.clear();
			commandHistory.clear();
		},
	};
}
