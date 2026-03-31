import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executePatch } from "../src/patch/core.ts";
import { ExecutePatchError } from "../src/patch/types.ts";

test("executePatch updates, adds, and moves files inside cwd", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "alpha.txt"), "old line\nkeep line\n", "utf8");
		const result = executePatch({
			cwd,
			patchText: `*** Begin Patch
*** Update File: alpha.txt
*** Move to: moved/alpha.txt
@@
-old line
+new line
 keep line
*** Add File: beta.txt
+hello beta
*** End Patch`,
		});

		assert.deepEqual(result.changedFiles.sort(), ["alpha.txt", "beta.txt", "moved/alpha.txt"].sort());
		assert.deepEqual(result.createdFiles.sort(), ["beta.txt", "moved/alpha.txt"].sort());
		assert.deepEqual(result.deletedFiles, ["alpha.txt"]);
		assert.deepEqual(result.movedFiles, ["alpha.txt -> moved/alpha.txt"]);
		assert.equal(readFileSync(join(cwd, "moved/alpha.txt"), "utf8"), "new line\nkeep line\n");
		assert.equal(readFileSync(join(cwd, "beta.txt"), "utf8"), "hello beta\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch rejects paths that escape cwd", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		assert.throws(
			() =>
				executePatch({
					cwd,
					patchText: `*** Begin Patch
*** Add File: ../escape.txt
+nope
*** End Patch`,
				}),
			/path escapes working directory/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch allows absolute paths", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	const absolutePath = join(cwd, "absolute.txt");
	try {
		const result = executePatch({
			cwd,
			patchText: `*** Begin Patch
*** Add File: ${absolutePath}
+hello absolute
*** End Patch`,
		});

		assert.deepEqual(result.changedFiles, [absolutePath]);
		assert.deepEqual(result.createdFiles, [absolutePath]);
		assert.equal(readFileSync(absolutePath, "utf8"), "hello absolute\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch rejects empty patches", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		assert.throws(
			() =>
				executePatch({
					cwd,
					patchText: `*** Begin Patch
*** End Patch`,
				}),
			/no files were modified/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch add overwrites an existing file", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "duplicate.txt"), "old content\n", "utf8");

		const result = executePatch({
			cwd,
			patchText: `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** End Patch`,
		});

		assert.deepEqual(result.changedFiles, ["duplicate.txt"]);
		assert.deepEqual(result.createdFiles, []);
		assert.equal(readFileSync(join(cwd, "duplicate.txt"), "utf8"), "new content\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch move overwrites an existing destination", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		mkdirSync(join(cwd, "old"), { recursive: true });
		mkdirSync(join(cwd, "renamed/dir"), { recursive: true });
		writeFileSync(join(cwd, "old/name.txt"), "from\n", "utf8");
		writeFileSync(join(cwd, "renamed/dir/name.txt"), "existing\n", "utf8");

		const result = executePatch({
			cwd,
			patchText: `*** Begin Patch
*** Update File: old/name.txt
*** Move to: renamed/dir/name.txt
@@
-from
+new
*** End Patch`,
		});

		assert.deepEqual(result.changedFiles.sort(), ["old/name.txt", "renamed/dir/name.txt"].sort());
		assert.deepEqual(result.createdFiles, []);
		assert.deepEqual(result.deletedFiles, ["old/name.txt"]);
		assert.deepEqual(result.movedFiles, ["old/name.txt -> renamed/dir/name.txt"]);
		assert.equal(readFileSync(join(cwd, "renamed/dir/name.txt"), "utf8"), "new\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch update appends a trailing newline", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "no-newline.txt"), "no newline at end", "utf8");

		executePatch({
			cwd,
			patchText: `*** Begin Patch
*** Update File: no-newline.txt
@@
-no newline at end
+first line
+second line
*** End Patch`,
		});

		assert.equal(readFileSync(join(cwd, "no-newline.txt"), "utf8"), "first line\nsecond line\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch leaves earlier changes applied when a later hunk fails", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		let error: unknown;
		try {
			executePatch({
				cwd,
				patchText: `*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
			});
		} catch (caught) {
			error = caught;
		}

		assert.ok(error instanceof ExecutePatchError);
		assert.match(error.message, /file not found|missing file/i);
		assert.deepEqual(error.result.changedFiles, ["created.txt"]);
		assert.deepEqual(error.result.createdFiles, ["created.txt"]);
		assert.equal(error.failedAction?.path, "missing.txt");

		assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "hello\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch rejects an empty update hunk", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		writeFileSync(join(cwd, "foo.txt"), "hello\n", "utf8");
		assert.throws(
			() =>
				executePatch({
					cwd,
					patchText: `*** Begin Patch
*** Update File: foo.txt
*** End Patch`,
				}),
			/empty/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("executePatch rejects invalid hunk headers", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-codex-conversion-"));
	try {
		assert.throws(
			() =>
				executePatch({
					cwd,
					patchText: `*** Begin Patch
*** Frobnicate File: foo.txt
*** End Patch`,
				}),
			/not a valid hunk header|unknown line/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
