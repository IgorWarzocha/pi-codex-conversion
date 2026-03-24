import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearApplyPatchRenderState, registerApplyPatchTool } from "../src/tools/apply-patch-tool.ts";

function createTheme() {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderComponentText(component: { render(width: number): string[] } | undefined): string {
	assert.ok(component);
	return stripAnsi(
		component
			.render(120)
			.map((line) => line.trimEnd())
			.join("\n")
			.trim(),
	);
}

function createRegisteredTool() {
	let tool:
		| {
				execute?: (
					toolCallId: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
					onUpdate?: unknown,
					ctx?: { cwd: string },
				) => Promise<unknown>;
				renderCall?: (
					args: { input?: string },
					theme: ReturnType<typeof createTheme>,
					context?: { toolCallId?: string; expanded?: boolean; cwd?: string; argsComplete?: boolean },
				) => { render(width: number): string[] };
		  }
		| undefined;
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

test("apply_patch renderCall preserves deleted previews after execution removes the file", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();

	try {
		writeFileSync(join(cwd, "delete-me.txt"), "first\nsecond\n", "utf8");
		const patch = `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`;

		await getTool().execute?.("call-delete", { input: patch }, undefined, undefined, { cwd });
		await assert.rejects(readFile(join(cwd, "delete-me.txt"), "utf8"));

		const rendered = renderComponentText(
			getTool().renderCall?.({ input: patch }, theme, { toolCallId: "call-delete", expanded: true }),
		);

		assert.match(rendered, /Deleted delete-me\.txt \(\+0 -2\)/);
		assert.match(rendered, /-first/);
		assert.match(rendered, /-second/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});
