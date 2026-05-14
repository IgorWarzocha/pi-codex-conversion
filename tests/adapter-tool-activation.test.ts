import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools } from "../src/index.ts";

test("mergeAdapterTools replaces Pi core tools but preserves unrelated active tools", () => {
	assert.deepEqual(
		mergeAdapterTools(["read", "bash", "edit", "write", "parallel", "custom_search"], ["exec_command", "write_stdin", "apply_patch"]),
		["exec_command", "write_stdin", "apply_patch", "parallel", "custom_search"],
	);
});

test("restoreTools restores previous tools and keeps custom tools added while adapter mode was enabled", () => {
	assert.deepEqual(
		restoreTools(["read", "bash", "edit", "write", "parallel"], ["exec_command", "write_stdin", "apply_patch", "parallel", "custom_search"]),
		["read", "bash", "edit", "write", "parallel", "custom_search"],
	);
});

test("restoreTools strips adapter tools from mixed startup state while keeping unrelated tools", () => {
	assert.deepEqual(
		restoreTools(["read", "bash", "edit", "write"], ["read", "bash", "edit", "write", "apply_patch", "exec_command", "write_stdin", "web_search", "image_generation", "parallel"]),
		["read", "bash", "edit", "write", "parallel"],
	);
});

test("restoreTools strips adapter tools from the preserved previous tool set", () => {
	assert.deepEqual(
		restoreTools(
			["read", "bash", "edit", "write", "exec_command", "write_stdin", "apply_patch"],
			["read", "bash", "edit", "write", "exec_command", "write_stdin", "apply_patch"],
		),
		["read", "bash", "edit", "write"],
	);
});

test("stripAdapterTools removes every adapter-owned tool", () => {
	assert.deepEqual(
		stripAdapterTools(["read", "exec_command", "write_stdin", "apply_patch", "web_search", "image_generation", "view_image", "parallel"]),
		["read", "parallel"],
	);
});

test("stripAdapterTools can preserve web_search when native web search is not adapter-owned", () => {
	assert.deepEqual(
		stripAdapterTools(
			["read", "exec_command", "write_stdin", "apply_patch", "web_search", "image_generation", "view_image", "parallel"],
			["exec_command", "write_stdin", "apply_patch", "image_generation", "view_image"],
		),
		["read", "web_search", "parallel"],
	);
});

test("mergeAdapterTools preserves external web_search when native web search is disabled", () => {
	assert.deepEqual(
		mergeAdapterTools(
			["read", "bash", "edit", "write", "web_search", "parallel"],
			["exec_command", "write_stdin", "apply_patch"],
			["exec_command", "write_stdin", "apply_patch", "image_generation", "view_image"],
		),
		["exec_command", "write_stdin", "apply_patch", "web_search", "parallel"],
	);
});

test("getCodexSkillPaths discovers existing global and ancestor project Codex skill directories", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-skills-"));
	try {
		const home = join(root, "home");
		const repo = join(root, "workspace");
		const cwd = join(repo, "packages", "app");
		const globalSkills = join(home, ".agents", "skills");
		const repoSkills = join(repo, ".agents", "skills");
		const nestedSkills = join(cwd, ".agents", "skills");
		mkdirSync(globalSkills, { recursive: true });
		mkdirSync(repoSkills, { recursive: true });
		mkdirSync(nestedSkills, { recursive: true });

		assert.deepEqual(getCodexSkillPaths(cwd, home), [globalSkills, nestedSkills, repoSkills]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
