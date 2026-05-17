import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexRequestParams } from "../src/adapter/config.ts";
import { buildStatusText } from "../src/adapter/tool-set.ts";
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

test("buildStatusText includes verbosity plus enabled web search and fast flags", () => {
	assert.equal(
		buildStatusText({ verbosity: "medium", webSearch: true, imageGeneration: true, fast: true, useOnAllModels: true }),
		"\u001b[38;2;0;76;255mCodex adapter\u001b[0m V: mid • all models • web search • image gen • fast",
	);
	assert.equal(
		buildStatusText({ verbosity: "low", webSearch: false, imageGeneration: false, fast: false, useOnAllModels: false }),
		"\u001b[38;2;0;76;255mCodex adapter\u001b[0m V: low",
	);
	assert.equal(
		buildStatusText({ webSearch: false, imageGeneration: false, fast: false, useOnAllModels: true }),
		"\u001b[38;2;0;76;255mCodex adapter\u001b[0m • all models",
	);
});

test("applyCodexRequestParams patches verbosity and priority service tier", () => {
	assert.deepEqual(
		applyCodexRequestParams({ input: "hello", text: { format: { type: "text" } } }, { fast: true, imageGeneration: true, useOnAllModels: false, webSearch: true, verbosity: "high" }),
		{
			input: "hello",
			service_tier: "priority",
			text: { format: { type: "text" }, verbosity: "high" },
		},
	);
});

test("applyCodexRequestParams can apply verbosity without priority service tier", () => {
	assert.deepEqual(
		applyCodexRequestParams(
			{ input: "hello" },
			{ fast: true, imageGeneration: true, useOnAllModels: true, webSearch: true, verbosity: "medium" },
			{ serviceTier: false, verbosity: true },
		),
		{ input: "hello", text: { verbosity: "medium" } },
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
