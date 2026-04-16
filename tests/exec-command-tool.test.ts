import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createExecCommandTracker } from "../src/tools/exec-command-state.ts";
import { registerExecCommandTool } from "../src/tools/exec-command-tool.ts";
import { createExecSessionManager } from "../src/tools/exec-session-manager.ts";

function createTheme() {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function trimRenderedLines(lines: string[]): string {
	return lines.map((line) => line.trimEnd()).join("\n");
}

function createRegisteredTool() {
	let tool: {
		renderCall?: (args: { cmd?: string }, theme: ReturnType<typeof createTheme>, context?: { toolCallId?: string; invalidate?: () => void }) => {
			render(width: number): string[];
		};
		prepareArguments?: (args: unknown) => Record<string, unknown>;
		renderResult?: (
			result: { content: Array<{ type: string; text?: string }>; details?: unknown },
			options: { expanded: boolean; isPartial: boolean },
			theme: ReturnType<typeof createTheme>,
			context?: { toolCallId?: string },
		) => { render(width: number): string[] };
	} | undefined;
	const pi = {
		registerTool(definition: typeof tool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		getTool() {
			assert.ok(tool);
			return tool;
		},
	};
}

test("exec_command prepareArguments normalizes common command aliases", () => {
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerExecCommandTool(pi, tracker, sessions);

	try {
		assert.deepEqual(getTool().prepareArguments?.({ command: "pwd", cwd: "/tmp" }), {
			cmd: "pwd",
			command: "pwd",
			cwd: "/tmp",
			workdir: "/tmp",
		});
	} finally {
		sessions.shutdown();
	}
});

test("exec_command prepareArguments preserves invalid optional field types for validation", () => {
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerExecCommandTool(pi, tracker, sessions);

	try {
		assert.deepEqual(getTool().prepareArguments?.({ cmd: "ls", tty: "true", yield_time_ms: "1000" }), {
			cmd: "ls",
			tty: "true",
			yield_time_ms: "1000",
		});
	} finally {
		sessions.shutdown();
	}
});

test("exec_command renderResult returns an empty component for collapsed or partial states", () => {
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerExecCommandTool(pi, tracker, sessions);
	const theme = createTheme();

	try {
		const collapsed = getTool().renderResult?.(
			{
				content: [{ type: "text", text: "ignored" }],
			},
			{ expanded: false, isPartial: false },
			theme,
		);
		assert.ok(collapsed);
		assert.deepEqual(collapsed.render(120), []);

		const partial = getTool().renderResult?.(
			{
				content: [{ type: "text", text: "ignored" }],
			},
			{ expanded: true, isPartial: true },
			theme,
		);
		assert.ok(partial);
		assert.deepEqual(partial.render(120), []);
	} finally {
		sessions.shutdown();
	}
});

test("exec_command renderCall groups consecutive read-only execs when toolCallId context is available", () => {
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerExecCommandTool(pi, tracker, sessions);
	const theme = createTheme();

	try {
		tracker.recordStart("call-1", "cat alpha.ts");
		const first = getTool().renderCall?.({ cmd: "cat alpha.ts" }, theme, { toolCallId: "call-1", invalidate: () => {} });
		assert.ok(first);
		assert.equal(trimRenderedLines(first.render(120)), "• Exploring\n  └ Read alpha.ts");

		tracker.recordStart("call-2", "cat beta.ts");
		const hidden = getTool().renderCall?.({ cmd: "cat alpha.ts" }, theme, { toolCallId: "call-1", invalidate: () => {} });
		assert.ok(hidden);
		assert.deepEqual(hidden.render(120), []);

		const grouped = getTool().renderCall?.({ cmd: "cat beta.ts" }, theme, { toolCallId: "call-2", invalidate: () => {} });
		assert.ok(grouped);
		assert.equal(trimRenderedLines(grouped.render(120)), "• Exploring\n  └ Read alpha.ts, beta.ts");
	} finally {
		sessions.shutdown();
	}
});
