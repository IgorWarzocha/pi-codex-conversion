import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { formatApplyPatchCall, formatApplyPatchSummary, renderApplyPatchCall } from "../src/tools/apply-patch-rendering.ts";

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function trimLineEnds(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

initTheme("dark", false);

test("formatApplyPatchCall matches Codex add rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		const rendered = formatApplyPatchCall(
			`*** Begin Patch
*** Add File: foo.txt
+hello
+world
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Added foo.txt (+2 -0)\n    1 +hello\n    2 +world");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchCall matches Codex update rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "example.txt"), "line one\nline two\nline three\n", "utf8");

		const rendered = formatApplyPatchCall(
			`*** Begin Patch
*** Update File: example.txt
@@
 line one
-line two
+line two changed
 line three
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Edited example.txt (+1 -1)\n    1  line one\n    2 -line two\n    2 +line two changed\n    3  line three");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchCall matches Codex multi-file rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "a.txt"), "one\n", "utf8");

		const rendered = formatApplyPatchCall(
			`*** Begin Patch
*** Update File: a.txt
@@
-one
+one changed
*** Add File: b.txt
+new
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Edited 2 files (+2 -1)\n  └ a.txt (+1 -1)\n    1 -one\n    1 +one changed\n\n  └ b.txt (+1 -0)\n    1 +new");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchCall matches Codex delete rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "tmp_delete_example.txt"), "first\nsecond\nthird\n", "utf8");

		const rendered = formatApplyPatchCall(
			`*** Begin Patch
*** Delete File: tmp_delete_example.txt
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Deleted tmp_delete_example.txt (+0 -3)\n    1 -first\n    2 -second\n    3 -third");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchCall matches Codex rename rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "old_name.rs"), "A\nB\nC\n", "utf8");

		const rendered = formatApplyPatchCall(
			`*** Begin Patch
*** Update File: old_name.rs
*** Move to: new_name.rs
@@
 A
-B
+B changed
 C
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Edited old_name.rs → new_name.rs (+1 -1)\n    1  A\n    2 -B\n    2 +B changed\n    3  C");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchSummary returns a collapsed summary for single-file edits", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "example.txt"), "line one\nline two\nline three\n", "utf8");

		const rendered = formatApplyPatchSummary(
			`*** Begin Patch
*** Update File: example.txt
@@
 line one
-line two
+line two changed
 line three
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Edited example.txt (+1 -1)");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("formatApplyPatchSummary returns a collapsed summary for multi-file edits", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "a.txt"), "one\n", "utf8");

		const rendered = formatApplyPatchSummary(
			`*** Begin Patch
*** Update File: a.txt
@@
-one
+one changed
*** Add File: b.txt
+new
*** End Patch`,
			cwd,
		);

		assert.equal(rendered, "• Edited 2 files (+2 -1)\n  └ a.txt (+1 -1)\n    b.txt (+1 -0)");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("renderApplyPatchCall uses Pi diff coloring while preserving Codex layout", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "example.txt"), "line one\nline two\nline three\n", "utf8");

		const rendered = renderApplyPatchCall(
			`*** Begin Patch
*** Update File: example.txt
@@
 line one
-line two
+line two changed
 line three
*** End Patch`,
			cwd,
		);

		assert.notEqual(rendered, stripAnsi(rendered));
		assert.equal(
			trimLineEnds(stripAnsi(rendered)),
			"• Edited example.txt (+1 -1)\n     1 line one\n    -2 line two\n    +2 line two changed\n     3 line three",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
