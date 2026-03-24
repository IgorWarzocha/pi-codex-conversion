import test from "node:test";
import assert from "node:assert/strict";
import {
	createWebSearchTool,
	rewriteNativeWebSearchTool,
	shouldShowWebSearchSessionNote,
	supportsMultimodalNativeWebSearch,
	supportsNativeWebSearch,
} from "../src/tools/web-search-tool.ts";

test("supportsNativeWebSearch only enables the tool for openai-codex", () => {
	assert.equal(supportsNativeWebSearch({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never), true);
	assert.equal(supportsNativeWebSearch({ provider: "openai", api: "openai-responses", id: "gpt-5" } as never), false);
	assert.equal(supportsNativeWebSearch({ provider: "github-copilot", api: "chat-completions", id: "gpt-5.4" } as never), false);
});

test("rewriteNativeWebSearchTool replaces the adapter function tool with the native openai-codex tool", () => {
	const payload = {
		model: "gpt-5.4",
		tools: [
			{ type: "function", name: "exec_command", parameters: { type: "object" } },
			{ type: "function", name: "web_search", parameters: { type: "object" } },
		],
	};

	assert.deepEqual(
		rewriteNativeWebSearchTool(payload, { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never),
		{
			model: "gpt-5.4",
			tools: [
				{ type: "function", name: "exec_command", parameters: { type: "object" } },
				{ type: "web_search", external_web_access: true, search_content_types: ["text", "image"] },
			],
		},
	);
});

test("rewriteNativeWebSearchTool leaves spark models text-only", () => {
	const payload = {
		model: "gpt-5.3-codex-spark",
		tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
	};

	assert.deepEqual(
		rewriteNativeWebSearchTool(
			payload,
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex-spark" } as never,
		),
		{
			model: "gpt-5.3-codex-spark",
			tools: [{ type: "web_search", external_web_access: true }],
		},
	);
});

test("rewriteNativeWebSearchTool leaves other providers untouched", () => {
	const payload = {
		model: "gpt-5",
		tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }],
	};

	assert.equal(
		rewriteNativeWebSearchTool(payload, { provider: "openai", api: "openai-responses", id: "gpt-5" } as never),
		payload,
	);
});

test("shouldShowWebSearchSessionNote is gated to UI-backed openai-codex sessions and only shows once", () => {
	assert.equal(
		shouldShowWebSearchSessionNote(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never,
			true,
			false,
		),
		true,
	);
	assert.equal(
		shouldShowWebSearchSessionNote(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never,
			false,
			false,
		),
		false,
	);
	assert.equal(
		shouldShowWebSearchSessionNote(
			{ provider: "github-copilot", api: "chat-completions", id: "gpt-5.4" } as never,
			true,
			false,
		),
		false,
	);
	assert.equal(
		shouldShowWebSearchSessionNote(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never,
			true,
			true,
		),
		false,
	);
});

test("supportsMultimodalNativeWebSearch excludes spark", () => {
	assert.equal(
		supportsMultimodalNativeWebSearch(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" } as never,
		),
		true,
	);
	assert.equal(
		supportsMultimodalNativeWebSearch(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex-spark" } as never,
		),
		false,
	);
});

test("createWebSearchTool exposes a strict zero-argument schema and agent-facing description", () => {
	const tool = createWebSearchTool();
	assert.equal(tool.description, "Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.");
	assert.equal(tool.promptSnippet, tool.description);
	assert.equal((tool.parameters as { type?: unknown }).type, "object");
	assert.equal((tool.parameters as { additionalProperties?: unknown }).additionalProperties, false);
	assert.equal("properties" in (tool.parameters as object), false);
});

test("createWebSearchTool renderResult returns an empty component when collapsed", () => {
	const tool = createWebSearchTool();
	const component = tool.renderResult?.(
		{
			content: [{ type: "text", text: "hidden" }],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		{
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
		} as never,
	);

	assert.ok(component);
	assert.deepEqual(component.render(120), []);
});
