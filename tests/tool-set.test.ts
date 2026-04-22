import test from "node:test";
import assert from "node:assert/strict";
import { CORE_ADAPTER_TOOL_NAMES, IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../src/adapter/tool-set.ts";

test("adapter tool set matches codex-like surface", () => {
	assert.deepEqual(CORE_ADAPTER_TOOL_NAMES, ["exec_command", "write_stdin", "apply_patch"]);
	assert.equal(IMAGE_GENERATION_TOOL_NAME, "image_generation");
	assert.equal(VIEW_IMAGE_TOOL_NAME, "view_image");
	assert.equal(WEB_SEARCH_TOOL_NAME, "web_search");
	assert.equal(CORE_ADAPTER_TOOL_NAMES.includes("write"), false);
	assert.equal(CORE_ADAPTER_TOOL_NAMES.includes("edit"), false);
	assert.equal(CORE_ADAPTER_TOOL_NAMES.includes("read"), false);
});
