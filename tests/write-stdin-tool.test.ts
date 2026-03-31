import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createExecSessionManager } from "../src/tools/exec-session-manager.ts";
import { formatUnifiedExecResult } from "../src/tools/unified-exec-format.ts";
import { registerWriteStdinTool } from "../src/tools/write-stdin-tool.ts";

function createFastTestExecSessionManager() {
	return createExecSessionManager({ minEmptyWriteYieldTimeMs: 50 });
}

function createTheme() {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function renderComponentText(component: { render(width: number): string[] } | undefined): string {
	assert.ok(component);
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function createRegisteredTool() {
	let tool: {
		renderCall?: (args: Record<string, unknown>, theme: ReturnType<typeof createTheme>) => { render(width: number): string[] };
		renderResult?: (
			result: { content: Array<{ type: string; text?: string }>; details?: unknown },
			options: { expanded: boolean; isPartial: boolean },
			theme: ReturnType<typeof createTheme>,
		) => { render(width: number): string[] } | undefined;
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

test("write_stdin renderCall stays stable after the backing session exits", async () => {
	const sessions = createFastTestExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerWriteStdinTool(pi, sessions);
	const theme = createTheme();

	try {
		const started = await sessions.exec(
			{
				cmd: "read line",
				shell: "/bin/bash",
				login: false,
				tty: true,
				yield_time_ms: 50,
			},
			process.cwd(),
		);

		assert.equal(typeof started.session_id, "number");
		const args = { session_id: started.session_id!, chars: "" };
		const beforeExit = renderComponentText(getTool().renderCall?.(args, theme));

		let result = await sessions.write({ session_id: started.session_id!, chars: "hello\n", yield_time_ms: 50 });
		for (let attempt = 0; attempt < 5 && result.session_id !== undefined; attempt++) {
			result = await sessions.write({ session_id: started.session_id!, yield_time_ms: 50 });
		}

		assert.equal(result.exit_code, 0);
		assert.equal(sessions.hasSession(started.session_id!), false);

		const afterExit = renderComponentText(getTool().renderCall?.(args, theme));
		assert.equal(afterExit, beforeExit);
		assert.equal(afterExit, "• Waited for background terminal · read line");
	} finally {
		sessions.shutdown();
	}
});

test("write_stdin renderResult returns an empty component for collapsed or partial states", () => {
	const sessions = createFastTestExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerWriteStdinTool(pi, sessions);
	const theme = createTheme();

	try {
		const result = {
			content: [{ type: "text", text: "ignored" }],
		};

		assert.equal(renderComponentText(getTool().renderResult?.(result, { expanded: false, isPartial: false }, theme)), "");
		assert.equal(renderComponentText(getTool().renderResult?.(result, { expanded: true, isPartial: true }, theme)), "");
	} finally {
		sessions.shutdown();
	}
});

test("write_stdin renderResult falls back to the Output section of formatted transcripts when details are unavailable", () => {
	const sessions = createFastTestExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerWriteStdinTool(pi, sessions);
	const theme = createTheme();

	try {
		const transcript = formatUnifiedExecResult(
			{
				chunk_id: "abc123",
				wall_time_seconds: 0.25,
				output: "replayed output",
				exit_code: 0,
			},
			"printf hello",
		);
		const rendered = renderComponentText(
			getTool().renderResult?.(
				{
					content: [{ type: "text", text: transcript }],
				},
				{ expanded: true, isPartial: false },
				theme,
			),
		);

		assert.equal(rendered, "replayed output\nExit code: 0");
	} finally {
		sessions.shutdown();
	}
});

test("write_stdin renderResult falls back to running-session state from formatted transcripts", () => {
	const sessions = createFastTestExecSessionManager();
	const { pi, getTool } = createRegisteredTool();
	registerWriteStdinTool(pi, sessions);
	const theme = createTheme();

	try {
		const transcript = formatUnifiedExecResult(
			{
				chunk_id: "abc123",
				wall_time_seconds: 0.25,
				output: "ready",
				session_id: 7,
			},
			"printf ready",
		);
		const rendered = renderComponentText(
			getTool().renderResult?.(
				{
					content: [{ type: "text", text: transcript }],
				},
				{ expanded: true, isPartial: false },
				theme,
			),
		);

		assert.equal(rendered, "ready\nSession 7 still running");
	} finally {
		sessions.shutdown();
	}
});
