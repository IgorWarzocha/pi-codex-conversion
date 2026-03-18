import { isSmallFormattingCommand, parseShellPart, nextCwd } from "./parse.ts";
import { joinCommandTokens, splitOnConnectors, normalizeTokens, shellSplit } from "./tokenize.ts";
import type { CommandSummary, ShellAction } from "./types.ts";

export type { CommandSummary, ShellAction } from "./types.ts";

// The adapter only masks commands when every parsed segment still looks like
// repository exploration. The moment we see an actual side-effectful run, we
// fall back to raw command rendering so the UI does not hide meaningful work.
export function summarizeShellCommand(command: string): CommandSummary {
	const rawTokens = shellSplit(command);
	const normalized = normalizeTokens(rawTokens);
	const parts = splitOnConnectors(normalized);
	const fallback = runSummary(command, rawTokens, normalized);

	const effectiveParts = parts.length > 1 ? parts.filter((part) => !isSmallFormattingCommand(part)) : parts;

	if (effectiveParts.length === 0) {
		return fallback;
	}

	const actions: ShellAction[] = [];
	let cwd: string | undefined;

	for (const part of effectiveParts) {
		if (part.length === 0) continue;

		cwd = nextCwd(cwd, part);
		const parsed = parseShellPart(part, cwd);
		if (parsed === null) continue;
		if (parsed.kind === "run") {
			return fallback;
		}
		actions.push(parsed);
	}

	const deduped = dedupeActions(actions);
	if (deduped.length === 0) {
		return fallback;
	}

	return {
		maskAsExplored: deduped.every((action) => action.kind !== "run"),
		actions: deduped,
	};
}

function runSummary(command: string, rawTokens: string[], normalizedTokens: string[]): CommandSummary {
	const display = extractWrappedShellScript(rawTokens) ?? extractPowerShellScript(rawTokens) ?? formatCommand(normalizedTokens) ?? (command.trim() || command);
	return {
		maskAsExplored: false,
		actions: [{ kind: "run", command: display }],
	};
}

function formatCommand(tokens: string[]): string | undefined {
	return tokens.length > 0 ? joinCommandTokens(tokens) : undefined;
}

function extractPowerShellScript(tokens: string[]): string | undefined {
	if (tokens.length < 3) return undefined;
	const shell = tokens[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (shell !== "powershell" && shell !== "powershell.exe" && shell !== "pwsh" && shell !== "pwsh.exe") {
		return undefined;
	}
	for (let index = 1; index + 1 < tokens.length; index++) {
		const flag = tokens[index]?.toLowerCase();
		if (flag !== "-nologo" && flag !== "-noprofile" && flag !== "-command" && flag !== "-c") {
			return undefined;
		}
		if (flag === "-command" || flag === "-c") {
			return tokens[index + 1];
		}
	}
	return undefined;
}

function extractWrappedShellScript(tokens: string[]): string | undefined {
	if (tokens.length !== 3) return undefined;
	const shell = tokens[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (shell !== "bash" && shell !== "zsh" && shell !== "sh") return undefined;
	if (tokens[1] !== "-c" && tokens[1] !== "-lc") return undefined;
	return tokens[2];
}

function dedupeActions(actions: ShellAction[]): ShellAction[] {
	const deduped: ShellAction[] = [];
	for (const action of actions) {
		const previous = deduped[deduped.length - 1];
		if (previous && JSON.stringify(previous) === JSON.stringify(action)) {
			continue;
		}
		deduped.push(action);
	}
	return deduped;
}
