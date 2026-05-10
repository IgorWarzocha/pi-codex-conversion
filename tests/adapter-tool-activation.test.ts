import test from "node:test";
import assert from "node:assert/strict";
import { mergeAdapterTools, restoreTools, stripAdapterTools } from "../src/index.ts";

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
