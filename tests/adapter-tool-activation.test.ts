import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codexConversion, { applyFastServiceTier, getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools } from "../src/index.ts";

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

test("applyFastServiceTier injects Codex's priority service tier without mutating the original payload", () => {
	const payload = { model: "gpt-5.4", stream: true };

	assert.deepEqual(applyFastServiceTier(payload, true), { model: "gpt-5.4", stream: true, service_tier: "priority" });
	assert.deepEqual(payload, { model: "gpt-5.4", stream: true });
	assert.equal(applyFastServiceTier(payload, false), payload);
});

test("/fast registers as a pure toggle command", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, (event: { payload: unknown }, ctx: unknown) => Promise<unknown>>();
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	const pi = {
		registerProvider() {},
		registerTool() {},
		registerMessageRenderer() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command);
		},
		getActiveTools: () => [],
		setActiveTools() {},
		on(event: string, handler: (event: { payload: unknown }, ctx: unknown) => Promise<unknown>) {
			handlers.set(event, handler);
		},
	} as never;
	const ctx = {
		hasUI: true,
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" },
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
	};

	codexConversion(pi);
	const fast = commands.get("fast");
	assert.ok(fast);

	await fast.handler("ignored", ctx);
	assert.equal(statuses.get("codex-fast"), "fast");
	assert.deepEqual(notifications, ["Fast mode enabled"]);
	assert.deepEqual(await handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.4" } }, ctx), {
		model: "gpt-5.4",
		service_tier: "priority",
	});

	await fast.handler("", ctx);
	assert.equal(statuses.get("codex-fast"), undefined);
	assert.deepEqual(notifications, ["Fast mode enabled", "Fast mode disabled"]);
	assert.deepEqual(await handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.4" } }, ctx), { model: "gpt-5.4" });
});
