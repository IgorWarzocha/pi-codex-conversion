import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_CONVERSION_CONFIG, applyCodexRequestParams, getCodexConversionConfigPath, writeCodexConversionConfig } from "../src/adapter/config.ts";
import { syncAdapter } from "../src/adapter/activation.ts";
import type { AdapterState } from "../src/adapter/state.ts";
import { buildStatusText } from "../src/adapter/tool-set.ts";
import { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools } from "../src/index.ts";

function createToolHarness(activeTools: string[]) {
	return {
		getActiveTools: () => activeTools,
		setActiveTools: (nextTools: string[]) => {
			activeTools = nextTools;
		},
		activeTools: () => activeTools,
	};
}

function createAdapterState(overrides: Partial<AdapterState["config"]> = {}): AdapterState {
	return {
		enabled: false,
		cwd: process.cwd(),
		promptSkills: [],
		config: { ...DEFAULT_CODEX_CONVERSION_CONFIG, imageGeneration: false, webSearch: false, ...overrides },
	};
}

function createContext(model: { provider: string; api: string; id: string }) {
	return {
		hasUI: false,
		model,
		ui: { setStatus: () => undefined },
	};
}

test("mergeAdapterTools replaces Pi core tools but preserves unrelated active tools", () => {
	assert.deepEqual(
		mergeAdapterTools(["read", "bash", "edit", "write", "parallel", "custom_search"], ["exec_command", "write_stdin", "apply_patch"]),
		["exec_command", "write_stdin", "apply_patch", "parallel", "custom_search"],
	);
});

test("mergeAdapterTools preserves optional tool names that are not adapter-owned", () => {
	assert.deepEqual(
		mergeAdapterTools(["read", "web_search", "image_generation", "parallel"], ["exec_command", "write_stdin", "apply_patch"]),
		["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation", "parallel"],
	);
});

test("mergeAdapterTools strips optional tool names when they are adapter-owned", () => {
	assert.deepEqual(
		mergeAdapterTools(
			["read", "web_search", "image_generation", "parallel"],
			["exec_command", "write_stdin", "apply_patch"],
			["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation"],
		),
		["exec_command", "write_stdin", "apply_patch", "parallel"],
	);
});

test("syncAdapter preserves disabled optional tools across repeated syncs", () => {
	const pi = createToolHarness(["read", "web_search", "image_generation", "parallel"]);
	const ctx = createContext({ provider: "openai", api: "openai-responses", id: "gpt-5" });
	const state = createAdapterState({ webSearch: false, imageGeneration: false });

	syncAdapter(pi as never, ctx as never, state);
	syncAdapter(pi as never, ctx as never, state);

	assert.deepEqual(pi.activeTools(), ["exec_command", "write_stdin", "apply_patch", "web_search", "image_generation", "parallel"]);
});

test("syncAdapter restores preserved disabled optional tools when disabling adapter", () => {
	const pi = createToolHarness(["read", "web_search", "parallel"]);
	const codexCtx = createContext({ provider: "openai", api: "openai-responses", id: "gpt-5" });
	const plainCtx = createContext({ provider: "anthropic", api: "anthropic-messages", id: "claude" });
	const state = createAdapterState({ webSearch: false });

	syncAdapter(pi as never, codexCtx as never, state);
	syncAdapter(pi as never, plainCtx as never, state);

	assert.deepEqual(pi.activeTools(), ["read", "web_search", "parallel"]);
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

test("stripAdapterTools can preserve disabled optional tool names", () => {
	assert.deepEqual(
		stripAdapterTools(["read", "exec_command", "web_search", "image_generation", "parallel"], ["exec_command", "write_stdin", "apply_patch", "view_image"]),
		["read", "web_search", "image_generation", "parallel"],
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
	assert.equal(
		buildStatusText({ verbosity: "high", webSearch: false, imageGeneration: false, fast: false, useOnAllModels: false, compaction: { enabled: true, model: "gpt-5.4-mini", reasoning: "low" } }),
		"\u001b[38;2;0;76;255mCodex adapter\u001b[0m V: hi • compact gpt-5.4-mini/low",
	);
});

test("applyCodexRequestParams patches verbosity and priority service tier", () => {
	assert.deepEqual(
		applyCodexRequestParams({ input: "hello", text: { format: { type: "text" } } }, { ...DEFAULT_CODEX_CONVERSION_CONFIG, fast: true, imageGeneration: true, statusLine: true, useOnAllModels: false, webSearch: true, verbosity: "high" }),
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
			{ ...DEFAULT_CODEX_CONVERSION_CONFIG, fast: true, imageGeneration: true, statusLine: true, useOnAllModels: true, webSearch: true, verbosity: "medium" },
			{ serviceTier: false, verbosity: true },
		),
		{ input: "hello", text: { verbosity: "medium" } },
	);
});

test("codex config path is rooted in Pi's agent directory", () => {
	assert.equal(getCodexConversionConfigPath("/tmp/custom-agent"), join("/tmp/custom-agent", "pi-codex-conversion.json"));
});

test("writeCodexConversionConfig reports write failures", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-config-"));
	try {
		const blockedPath = join(root, "blocked");
		writeFileSync(blockedPath, "not a directory");
		const result = writeCodexConversionConfig(
			{ ...DEFAULT_CODEX_CONVERSION_CONFIG, fast: false, imageGeneration: true, statusLine: true, useOnAllModels: false, webSearch: true, verbosity: "low" },
			join(blockedPath, "pi-codex-conversion.json"),
		);
		assert.equal(result.ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeCodexConversionConfig reports successful writes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-config-"));
	try {
		const configPath = join(root, "pi-codex-conversion.json");
		const result = writeCodexConversionConfig(
			{ ...DEFAULT_CODEX_CONVERSION_CONFIG, fast: true, imageGeneration: false, statusLine: false, useOnAllModels: true, webSearch: false, verbosity: "high" },
			configPath,
		);
		assert.equal(result.ok, true);
		assert.match(readFileSync(configPath, "utf8"), /"useOnAllModels": true/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
