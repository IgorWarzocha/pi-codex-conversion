import { isSmallFormattingCommand, parseShellPart, nextCwd } from "./parse.ts";
import { splitOnConnectors, normalizeTokens, shellSplit } from "./tokenize.ts";
import type { CommandSummary, ShellAction } from "./types.ts";

export type { CommandSummary, ShellAction } from "./types.ts";

// The adapter only masks commands when every parsed segment still looks like
// repository exploration. The moment we see an actual side-effectful run, we
// fall back to raw command rendering so the UI does not hide meaningful work.
export function summarizeShellCommand(command: string): CommandSummary {
	const normalized = normalizeTokens(shellSplit(command));
	const parts = splitOnConnectors(normalized);
	const fallback = runSummary(command);

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

function runSummary(command: string): CommandSummary {
	return {
		maskAsExplored: false,
		actions: [{ kind: "run", command: command.trim() || command }],
	};
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
