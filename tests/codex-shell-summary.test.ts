import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShellCommand } from "../src/shell/summary.ts";

test("classifies simple file reads as explored reads", () => {
	const summary = summarizeShellCommand("cat README.md");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [{ kind: "read", command: "cat README.md", name: "README.md", path: "README.md" }]);
});

test("tracks cd prefixes for subsequent read commands", () => {
	const summary = summarizeShellCommand("cd src && sed -n '1,20p' index.ts");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [{ kind: "read", command: "sed -n 1,20p index.ts", name: "index.ts", path: "src/index.ts" }]);
});

test("ignores printf separators between semicolon-delimited reads", () => {
	const summary = summarizeShellCommand(
		"cd vendor/toon; sed -n '1,260p' packages/toon/package.json; printf '\n---README---\n'; sed -n '1,260p' packages/toon/README.md",
	);
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/package.json",
			name: "package.json",
			path: "vendor/toon/packages/toon/package.json",
		},
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/README.md",
			name: "README.md",
			path: "vendor/toon/packages/toon/README.md",
		},
	]);
});

test("ignores printf separators between connector-delimited reads", () => {
	const summary = summarizeShellCommand(
		"cd vendor/toon && sed -n '1,260p' packages/toon/src/index.ts && printf '\n---TYPES---\n' && sed -n '1,260p' packages/toon/src/types.ts",
	);
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/src/index.ts",
			name: "index.ts",
			path: "vendor/toon/packages/toon/src/index.ts",
		},
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/src/types.ts",
			name: "types.ts",
			path: "vendor/toon/packages/toon/src/types.ts",
		},
	]);
});

test("classifies awk with a file operand as a read", () => {
	const summary = summarizeShellCommand("awk '{print $1}' Cargo.toml");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "awk {print $1} Cargo.toml",
			name: "Cargo.toml",
			path: "Cargo.toml",
		},
	]);
});

test("classifies python file-walk scripts as explored listing", () => {
	const py = summarizeShellCommand(`python -c "import os; print(os.listdir('.'))"`);
	assert.equal(py.maskAsExplored, true);
	assert.deepEqual(py.actions, [{ kind: "list", command: "python -c import os; print(os.listdir('.'))" }]);

	const py3 = summarizeShellCommand(`python3 -c "import glob; print(glob.glob('*.rs'))"`);
	assert.equal(py3.maskAsExplored, true);
	assert.deepEqual(py3.actions, [{ kind: "list", command: "python3 -c import glob; print(glob.glob('*.rs'))" }]);
});

test("keeps non-file-walking python scripts as raw runs", () => {
	const summary = summarizeShellCommand(`python -c "print('hello')"`);
	assert.equal(summary.maskAsExplored, false);
	assert.deepEqual(summary.actions, [{ kind: "run", command: `python -c "print('hello')"` }]);
});

test("drops formatting helpers after search and list commands", () => {
	const search = summarizeShellCommand("rg -n foo src | wc -l");
	assert.equal(search.maskAsExplored, true);
	assert.deepEqual(search.actions, [{ kind: "search", command: "rg -n foo src", query: "foo", path: "src" }]);

	const list = summarizeShellCommand("rg --files | xargs echo");
	assert.equal(list.maskAsExplored, true);
	assert.deepEqual(list.actions, [{ kind: "list", command: "rg --files", path: undefined }]);
});

test("keeps mutating xargs pipelines as raw runs", () => {
	const summary = summarizeShellCommand("rg -l foo src | xargs perl -pi -e 's/foo/bar/g'");
	assert.equal(summary.maskAsExplored, false);
	assert.deepEqual(summary.actions, [{ kind: "run", command: "rg -l foo src | xargs perl -pi -e 's/foo/bar/g'" }]);
});

test("classifies ripgrep searches separately from command runs", () => {
	const search = summarizeShellCommand("rg -n adapter pi-codex-conversion");
	assert.equal(search.maskAsExplored, true);
	assert.deepEqual(search.actions, [{ kind: "search", command: "rg -n adapter pi-codex-conversion", query: "adapter", path: "pi-codex-conversion" }]);

	const run = summarizeShellCommand("npm test");
	assert.equal(run.maskAsExplored, false);
	assert.deepEqual(run.actions, [{ kind: "run", command: "npm test" }]);
});
