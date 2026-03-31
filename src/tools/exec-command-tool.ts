import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { renderExecCommandCall } from "./codex-rendering.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.String({ description: "Shell command to execute." }),
	workdir: Type.Optional(Type.String({ description: "Optional working directory; defaults to the current turn cwd." })),
	shell: Type.Optional(Type.String({ description: "Optional shell binary; defaults to the user's shell." })),
	tty: Type.Optional(
		Type.Boolean({
			description: "Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.",
		}),
	),
	yield_time_ms: Type.Optional(Type.Number({ description: "How long to wait in milliseconds for output before yielding." })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Maximum number of tokens to return. Excess output will be truncated." })),
	login: Type.Optional(Type.Boolean({ description: "Whether to run the shell with -l/-i semantics. Defaults to true." })),
});

interface ExecCommandParams {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
	login?: boolean;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") {
		throw new Error("exec_command requires an object parameter");
	}

	const cmd = "cmd" in params ? params.cmd : undefined;
	if (typeof cmd !== "string") {
		throw new Error("exec_command requires a string 'cmd' parameter");
	}

	return {
		cmd,
		workdir: "workdir" in params && typeof params.workdir === "string" ? params.workdir : undefined,
		shell: "shell" in params && typeof params.shell === "string" ? params.shell : undefined,
		tty: "tty" in params && typeof params.tty === "boolean" ? params.tty : undefined,
		yield_time_ms: "yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined,
		max_output_tokens:
			"max_output_tokens" in params && typeof params.max_output_tokens === "number" ? params.max_output_tokens : undefined,
		login: "login" in params && typeof params.login === "boolean" ? params.login : undefined,
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyToolResult(): Text {
	return new Text("", 0, 0);
}

export function registerExecCommandTool(pi: ExtensionAPI, tracker: ExecCommandTracker, sessions: ExecSessionManager): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
		promptSnippet: "Run a command.",
		promptGuidelines: [
			"Use exec_command for search, listing files, and local text-file reads.",
			"Prefer rg or rg --files when possible.",
			"Keep tty disabled unless the command truly needs interactive terminal behavior.",
		],
		parameters: EXEC_COMMAND_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("exec_command aborted");
			}
			const typedParams = parseExecCommandParams(params);
			const result = await sessions.exec(typedParams, ctx.cwd, signal);
			if (result.session_id !== undefined) {
				tracker.recordPersistentSession(typedParams.cmd);
			}
			return {
				content: [{ type: "text", text: formatUnifiedExecResult(result, typedParams.cmd) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const command = typeof args.cmd === "string" ? args.cmd : "";
			return new Text(renderExecCommandCall(command, tracker.getState(command), theme), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial || !expanded) {
				return createEmptyToolResult();
			}

			const details = isUnifiedExecResult(result.details) ? result.details : undefined;
			const content = result.content.find((item) => item.type === "text");
			const output = details?.output ?? (content?.type === "text" ? content.text : "");
			let text = theme.fg("dim", output || "(no output)");
			if (details?.session_id !== undefined) {
				text += `\n${theme.fg("accent", `Session ${details.session_id} still running`)}`;
			}
			if (details?.exit_code !== undefined) {
				text += `\n${theme.fg("muted", `Exit code: ${details.exit_code}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
