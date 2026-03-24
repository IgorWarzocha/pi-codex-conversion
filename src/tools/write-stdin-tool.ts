import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Text } from "@mariozechner/pi-tui";
import { renderWriteStdinCall } from "./codex-rendering.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const WRITE_STDIN_PARAMETERS = Type.Object({
	session_id: Type.Number({ description: "Identifier of the running unified exec session." }),
	chars: Type.Optional(Type.String({ description: "Bytes to write to stdin. May be empty to poll." })),
	yield_time_ms: Type.Optional(Type.Number({ description: "How long to wait (in milliseconds) for output before yielding." })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Maximum number of tokens to return. Excess output will be truncated." })),
});

interface WriteStdinParams {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

interface FormattedExecTranscript {
	output: string;
	sessionId?: number;
	exitCode?: number;
}

function parseFormattedExecTranscript(text: string): FormattedExecTranscript {
	const marker = "\nOutput:\n";
	const markerIndex = text.indexOf(marker);
	const output = markerIndex !== -1 ? text.slice(markerIndex + marker.length) : text;
	const sessionMatch = text.match(/Process running with session ID (\d+)/);
	const exitCodeMatch = text.match(/Process exited with code (-?\d+)/);
	return {
		output,
		sessionId: sessionMatch ? Number(sessionMatch[1]) : undefined,
		exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : undefined,
	};
}

function renderTerminalText(text: string): string {
	let committed = "";
	let line: string[] = [];
	let cursor = 0;

	for (const char of text) {
		switch (char) {
			case "\r":
				cursor = 0;
				break;
			case "\n":
				committed += `${line.join("")}\n`;
				line = [];
				cursor = 0;
				break;
			case "\b":
				cursor = Math.max(0, cursor - 1);
				break;
			default:
				if (cursor > line.length) {
					line.push(...Array.from({ length: cursor - line.length }, () => " "));
				}
				line[cursor] = char;
				cursor += 1;
				break;
		}
	}

	return committed + line.join("");
}

function getResultState(result: { details?: unknown; content: Array<{ type: string; text?: string }> }): FormattedExecTranscript {
	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	const content = result.content.find((item) => item.type === "text");
	if (details) {
		return {
			output: details.output,
			sessionId: details.session_id,
			exitCode: details.exit_code,
		};
	}
	if (content?.type === "text") {
		return parseFormattedExecTranscript(content.text ?? "");
	}
	return { output: "" };
}

function parseWriteStdinParams(params: unknown): WriteStdinParams {
	if (!params || typeof params !== "object" || !("session_id" in params) || typeof params.session_id !== "number") {
		throw new Error("write_stdin requires numeric 'session_id'");
	}
	const chars = "chars" in params && typeof params.chars === "string" ? params.chars : undefined;
	const yield_time_ms = "yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined;
	const max_output_tokens =
		"max_output_tokens" in params && typeof params.max_output_tokens === "number" ? params.max_output_tokens : undefined;
	return { session_id: params.session_id, chars, yield_time_ms, max_output_tokens };
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyResultComponent(): Container {
	return new Container();
}

export function registerWriteStdinTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description: "Writes characters to an existing unified exec session and returns recent output.",
		promptSnippet: "Write to an exec session.",
		parameters: WRITE_STDIN_PARAMETERS,
		async execute(_toolCallId, params) {
			const typed = parseWriteStdinParams(params);
			const command = sessions.getSessionCommand(typed.session_id);
			let result: UnifiedExecResult;
			try {
				result = await sessions.write(typed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`write_stdin failed: ${message}`);
			}
			return {
				content: [{ type: "text", text: formatUnifiedExecResult(result, command) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const sessionId = typeof args.session_id === "number" ? args.session_id : "?";
			const input = typeof args.chars === "string" ? args.chars : undefined;
			const command = typeof sessionId === "number" ? sessions.getSessionCommand(sessionId) : undefined;
			return new Text(renderWriteStdinCall(sessionId, input, command, theme), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial || !expanded) return createEmptyResultComponent();
			const state = getResultState(result);
			const output = renderTerminalText(state.output);
			let text = theme.fg("dim", output || "(no output)");
			if (state.sessionId !== undefined) {
				text += `\n${theme.fg("accent", `Session ${state.sessionId} still running`)}`;
			}
			if (state.exitCode !== undefined) {
				text += `\n${theme.fg("muted", `Exit code: ${state.exitCode}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
