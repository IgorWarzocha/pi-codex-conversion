import { summarizeShellCommand, type ShellAction } from "../shell/summary.ts";
import type { ExecCommandStatus } from "./exec-command-state.ts";

export interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

export function renderExecCommandCall(command: string, state: ExecCommandStatus, theme: RenderTheme): string {
	const summary = summarizeShellCommand(command);
	return summary.maskAsExplored ? renderExplorationText(summary.actions, state, theme) : renderCommandText(command, state, theme);
}

export function renderWriteStdinCall(
	sessionId: number | string,
	input: string | undefined,
	command: string | undefined,
	theme: RenderTheme,
): string {
	const interacted = typeof input === "string" && input.length > 0;
	const marker = interacted ? "↳ " : "• ";
	const title = interacted ? "Interacted with background terminal" : "Waited for background terminal";
	let text = `${theme.fg("dim", marker)}${theme.bold(title)}`;
	const commandPreview = formatCommandPreview(command);
	if (commandPreview) {
		text += `${theme.fg("dim", " · ")}${theme.fg("muted", commandPreview)}`;
	}
	// Keep the session fallback only when we do not have a stable command display.
	if (!commandPreview) {
		text += `${theme.fg("dim", " ")}${theme.fg("muted", `#${sessionId}`)}`;
	}
	return text;
}

function renderExplorationText(actions: ShellAction[], state: ExecCommandStatus, theme: RenderTheme): string {
	const header = state === "running" ? "Exploring" : "Explored";
	let text = `${theme.fg("dim", "•")} ${theme.bold(header)}`;

	for (const [index, line] of coalesceReads(actions).map(formatActionLine).entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		text += `\n${theme.fg("dim", prefix)}${theme.fg("accent", line.title)} ${theme.fg("muted", line.body)}`;
	}

	return text;
}

function renderCommandText(command: string, state: ExecCommandStatus, theme: RenderTheme): string {
	const verb = state === "running" ? "Running" : "Ran";
	let text = `${theme.fg("dim", "•")} ${theme.bold(verb)}`;
	text += `\n${theme.fg("dim", "  └ ")}${theme.fg("accent", shortenCommand(command))}`;
	return text;
}

function shortenCommand(command: string, max = 100): string {
	const trimmed = command.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 3)}...`;
}

function formatCommandPreview(command: string | undefined): string | undefined {
	if (!command) return undefined;
	const singleLine = command.replace(/\s+/g, " ").trim();
	if (singleLine.length === 0) return undefined;
	return shortenCommand(singleLine, 80);
}

function formatActionLine(action: ShellAction): { title: string; body: string } {
	if (action.kind === "read") {
		return { title: "Read", body: action.name };
	}
	if (action.kind === "list") {
		return { title: "List", body: action.path ?? action.command };
	}
	if (action.kind === "search") {
		if (action.query && action.path) {
			return { title: "Search", body: `${action.query} in ${action.path}` };
		}
		if (action.query) {
			return { title: "Search", body: action.query };
		}
		return { title: "Search", body: action.command };
	}
	return { title: "Run", body: action.command };
}

function coalesceReads(actions: ShellAction[]): ShellAction[] {
	if (!actions.every((action) => action.kind !== "run")) return actions;
	const reads = actions.filter((action): action is Extract<ShellAction, { kind: "read" }> => action.kind === "read");
	if (reads.length !== actions.length) {
		return actions;
	}

	const names = [...new Set(reads.map((action) => action.name))];
	return [{ kind: "read", command: reads.map((action) => action.command).join(" && "), name: names.join(", "), path: reads[0].path }];
}
