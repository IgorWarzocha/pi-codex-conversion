import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { patchFsOps } from "../src/patch/core.ts";
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
				renderResult?: (
					result: { content: Array<{ type: string; text?: string }>; details?: unknown },
					options: { expanded: boolean; isPartial: boolean },
					theme: ReturnType<typeof createTheme>,
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

test("apply_patch renderCall shows partial failure inline after some hunks already applied", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();

	try {
		const patch = `*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;
		const tool = getTool();
		const execute = tool.execute;
		const renderCall = tool.renderCall;
		assert.ok(execute);
		assert.ok(renderCall);

		const result = (await execute("call-partial-failure", { input: patch }, undefined, undefined, { cwd })) as {
			content: Array<{ type: string; text?: string }>;
			details?: unknown;
		};
		assert.equal(result.content[0]?.type, "text");
		assert.match(result.content[0]?.text ?? "", /partially failed/i);

		const collapsed = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-partial-failure", expanded: false }),
		);
		const expanded = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-partial-failure", expanded: true }),
		);

		assert.match(collapsed, /^• Edit partially failed 2 files \(\+2 -1\)/);
		assert.match(collapsed, /missing\.txt failed \(\+1 -1\)/);
		assert.match(expanded, /^• Edit partially failed 2 files \(\+2 -1\)/);
		assert.match(expanded, /created\.txt \(\+1 -0\)/);
		assert.match(expanded, /missing\.txt failed \(\+1 -1\)/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("apply_patch renderCall marks failed absolute-path entries inline using display paths", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();

	try {
		const createdPath = join(cwd, "created.txt");
		const missingPath = join(cwd, "missing.txt");
		const patch = `*** Begin Patch
*** Add File: ${createdPath}
+hello
*** Update File: ${missingPath}
@@
-old
+new
*** End Patch`;
		const tool = getTool();
		const execute = tool.execute;
		const renderCall = tool.renderCall;
		assert.ok(execute);
		assert.ok(renderCall);

		const result = (await execute("call-absolute-partial-failure", { input: patch }, undefined, undefined, { cwd })) as {
			content: Array<{ type: string; text?: string }>;
		};
		assert.match(result.content[0]?.text ?? "", /while patching missing\.txt/);

		const collapsed = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-absolute-partial-failure", expanded: false, cwd }),
		);

		assert.match(collapsed, /^• Edit partially failed 2 files \(\+2 -1\)/);
		assert.match(collapsed, /missing\.txt failed \(\+1 -1\)/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("apply_patch renderCall only marks the exact failed entry inline", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();

	try {
		const patch = `*** Begin Patch
*** Add File: foo.txt.bak
+ok
*** Update File: foo.txt
@@
-old
+new
*** End Patch`;
		const tool = getTool();
		const execute = tool.execute;
		const renderCall = tool.renderCall;
		assert.ok(execute);
		assert.ok(renderCall);

		await execute("call-substring-partial-failure", { input: patch }, undefined, undefined, { cwd });

		const collapsed = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-substring-partial-failure", expanded: false, cwd }),
		);

		assert.match(collapsed, /foo\.txt failed \(\+1 -1\)/);
		assert.doesNotMatch(collapsed, /foo\.txt failed\.bak/);
		assert.match(collapsed, /foo\.txt\.bak \(\+1 -0\)/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("apply_patch renderCall preserves the original preview for partial failures", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();

	try {
		writeFileSync(join(cwd, "delete-me.txt"), "first\nsecond\n", "utf8");
		const patch = `*** Begin Patch
*** Delete File: delete-me.txt
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;
		const tool = getTool();
		const execute = tool.execute;
		const renderCall = tool.renderCall;
		assert.ok(execute);
		assert.ok(renderCall);

		await execute("call-preview-partial-failure", { input: patch }, undefined, undefined, { cwd });

		const expanded = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-preview-partial-failure", expanded: true, cwd }),
		);

		assert.match(expanded, /delete-me\.txt \(\+0 -2\)/);
		assert.match(expanded, /-first/);
		assert.match(expanded, /-second/);
		assert.match(expanded, /missing\.txt failed \(\+1 -1\)/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("apply_patch renderCall marks single-file partial failures after warning styling", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const sourcePath = join(cwd, "source.txt");
	const { pi, getTool } = createRegisteredTool();
	registerApplyPatchTool(pi);
	const theme = createTheme();
	const originalUnlinkSync = patchFsOps.unlinkSync;

	try {
		writeFileSync(sourcePath, "from\n", "utf8");
		patchFsOps.unlinkSync = (path) => {
			if (String(path) === sourcePath) {
				throw new Error("mock unlink failure");
			}
			return originalUnlinkSync(path);
		};
		const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved/source.txt
@@
-from
+to
*** End Patch`;
		const tool = getTool();
		const execute = tool.execute;
		const renderCall = tool.renderCall;
		assert.ok(execute);
		assert.ok(renderCall);

		try {
			await execute("call-single-file-partial-failure", { input: patch }, undefined, undefined, { cwd });
		} finally {
			patchFsOps.unlinkSync = originalUnlinkSync;
		}

		const collapsed = renderComponentText(
			renderCall({ input: patch }, theme, { toolCallId: "call-single-file-partial-failure", expanded: false, cwd }),
		);

		assert.match(collapsed, /^• Edit partially failed source\.txt → moved\/source\.txt failed \(\+1 -1\)/);
	} finally {
		clearApplyPatchRenderState();
		await rm(cwd, { recursive: true, force: true });
	}
});
