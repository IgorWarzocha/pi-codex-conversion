import { summarizeShellCommand, type CommandSummary, type ShellAction } from "../shell/summary.ts";

export type ExecCommandStatus = "running" | "done";

export interface ExecCommandRenderInfo {
	hidden: boolean;
	status: ExecCommandStatus;
	actionGroups?: ShellAction[][];
}

interface ExecEntry {
	toolCallId: string;
	command: string;
	summary: CommandSummary;
	status: ExecCommandStatus;
	hidden: boolean;
	groupId?: number;
	invalidate?: () => void;
}

interface ExecGroup {
	id: number;
	entryIds: string[];
	visibleEntryId: string;
}

export interface ExecCommandTracker {
	getState(command: string): ExecCommandStatus;
	getRenderInfo(toolCallId: string | undefined, command: string): ExecCommandRenderInfo;
	registerRenderContext(toolCallId: string | undefined, invalidate: () => void): void;
	recordStart(toolCallId: string, command: string): void;
	recordPersistentSession(command: string): void;
	recordEnd(toolCallId: string): void;
	recordCommandFinished(command: string): void;
	resetExplorationGroup(): void;
	clear(): void;
}

export function createExecCommandTracker(): ExecCommandTracker {
	const commandByToolCallId = new Map<string, string>();
	const executionStateByCommand = new Map<string, ExecCommandStatus>();
	const persistentCommands = new Set<string>();
	const entriesByToolCallId = new Map<string, ExecEntry>();
	const groupsById = new Map<number, ExecGroup>();
	let activeExplorationGroupId: number | undefined;
	let nextGroupId = 1;

	function invalidateToolCall(toolCallId: string | undefined): void {
		if (!toolCallId) return;
		entriesByToolCallId.get(toolCallId)?.invalidate?.();
	}

	function findLatestEntryByCommand(command: string): ExecEntry | undefined {
		let latest: ExecEntry | undefined;
		for (const entry of entriesByToolCallId.values()) {
			if (entry.command !== command) continue;
			latest = entry;
		}
		return latest;
	}

	function getGroupForEntry(entry: ExecEntry | undefined): ExecGroup | undefined {
		if (!entry?.groupId) return undefined;
		return groupsById.get(entry.groupId);
	}

	function getVisibleEntry(group: ExecGroup | undefined): ExecEntry | undefined {
		if (!group) return undefined;
		return entriesByToolCallId.get(group.visibleEntryId);
	}

	return {
		getState(command) {
			return executionStateByCommand.get(command) ?? "running";
		},
		getRenderInfo(toolCallId, command) {
			if (!toolCallId) {
				return { hidden: false, status: executionStateByCommand.get(command) ?? "running" };
			}

			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) {
				return { hidden: false, status: executionStateByCommand.get(command) ?? "running" };
			}

			if (entry.hidden) {
				return { hidden: true, status: entry.status };
			}

			const group = getGroupForEntry(entry);
			if (!group) {
				return {
					hidden: false,
					status: entry.status,
					actionGroups: entry.summary.maskAsExplored ? [entry.summary.actions] : undefined,
				};
			}

			const entries = group.entryIds
				.map((groupEntryId) => entriesByToolCallId.get(groupEntryId))
				.filter((groupEntry): groupEntry is ExecEntry => Boolean(groupEntry));
			return {
				hidden: false,
				status: entries.some((groupEntry) => groupEntry.status === "running") ? "running" : "done",
				actionGroups: entries.map((groupEntry) => groupEntry.summary.actions),
			};
		},
		registerRenderContext(toolCallId, invalidate) {
			if (!toolCallId) return;
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			entry.invalidate = invalidate;
		},
		recordStart(toolCallId, command) {
			commandByToolCallId.set(toolCallId, command);
			executionStateByCommand.set(command, "running");

			const summary = summarizeShellCommand(command);
			const entry: ExecEntry = {
				toolCallId,
				command,
				summary,
				status: "running",
				hidden: false,
			};
			entriesByToolCallId.set(toolCallId, entry);

			if (!summary.maskAsExplored) {
				activeExplorationGroupId = undefined;
				return;
			}

			let group = activeExplorationGroupId ? groupsById.get(activeExplorationGroupId) : undefined;
			if (!group) {
				group = { id: nextGroupId++, entryIds: [toolCallId], visibleEntryId: toolCallId };
				groupsById.set(group.id, group);
				activeExplorationGroupId = group.id;
				entry.groupId = group.id;
				return;
			}

			const previousVisibleEntry = getVisibleEntry(group);
			if (previousVisibleEntry) {
				previousVisibleEntry.hidden = true;
				invalidateToolCall(previousVisibleEntry.toolCallId);
			}

			group.entryIds.push(toolCallId);
			group.visibleEntryId = toolCallId;
			entry.groupId = group.id;
		},
		recordPersistentSession(command) {
			persistentCommands.add(command);
			executionStateByCommand.set(command, "running");
			const entry = findLatestEntryByCommand(command);
			if (!entry) return;
			entry.status = "running";
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		recordEnd(toolCallId) {
			const command = commandByToolCallId.get(toolCallId);
			if (!command) return;
			const entry = entriesByToolCallId.get(toolCallId);
			// Pi renderers do not currently receive toolCallId, so we track the
			// last-known state per command string for compact Exploring/Explored UI.
			if (!persistentCommands.has(command)) {
				executionStateByCommand.set(command, "done");
				if (entry) {
					entry.status = "done";
				}
			}
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? toolCallId);
			commandByToolCallId.delete(toolCallId);
		},
		recordCommandFinished(command) {
			persistentCommands.delete(command);
			executionStateByCommand.set(command, "done");
			const entry = findLatestEntryByCommand(command);
			if (!entry) return;
			entry.status = "done";
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		resetExplorationGroup() {
			activeExplorationGroupId = undefined;
		},
		clear() {
			commandByToolCallId.clear();
			executionStateByCommand.clear();
			persistentCommands.clear();
			entriesByToolCallId.clear();
			groupsById.clear();
			activeExplorationGroupId = undefined;
			nextGroupId = 1;
		},
	};
}
