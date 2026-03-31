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

function renderComponentText(component: { render(width: number): string[] } | undefined): string {
	assert.ok(component);
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

test("exec_command renderResult returns an empty component for collapsed or partial states", () => {
	let tool:
		| {
				renderResult?: (
					result: { content: Array<{ type: string; text?: string }>; details?: unknown },
					options: { expanded: boolean; isPartial: boolean },
					theme: ReturnType<typeof createTheme>,
				) => { render(width: number): string[] } | undefined;
		  }
		| undefined;

	const pi = {
		registerTool(definition: typeof tool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;

	registerExecCommandTool(pi, createExecCommandTracker(), createExecSessionManager());
	assert.ok(tool?.renderResult);

	const theme = createTheme();
	const result = { content: [{ type: "text", text: "hello" }] };

	assert.equal(renderComponentText(tool.renderResult(result, { expanded: false, isPartial: false }, theme)), "");
	assert.equal(renderComponentText(tool.renderResult(result, { expanded: true, isPartial: true }, theme)), "");
});
