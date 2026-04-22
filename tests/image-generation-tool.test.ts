import test from "node:test";
import assert from "node:assert/strict";
import {
	createImageGenerationTool,
	rewriteNativeImageGenerationTool,
	supportsNativeImageGeneration,
} from "../src/tools/image-generation-tool.ts";

test("supportsNativeImageGeneration only enables the tool for image-capable openai-codex models", () => {
	assert.equal(
		supportsNativeImageGeneration({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4", input: ["text", "image"] } as never),
		true,
	);
	assert.equal(
		supportsNativeImageGeneration({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex-spark", input: ["text"] } as never),
		false,
	);
	assert.equal(
		supportsNativeImageGeneration({ provider: "openai", api: "openai-responses", id: "gpt-5", input: ["text", "image"] } as never),
		false,
	);
});

test("rewriteNativeImageGenerationTool replaces the adapter function tool with the native openai-codex image tool", () => {
	const payload = {
		model: "gpt-5.4",
		tools: [
			{ type: "function", name: "exec_command", parameters: { type: "object" } },
			{ type: "function", name: "image_generation", parameters: { type: "object" } },
		],
	};

	assert.deepEqual(
		rewriteNativeImageGenerationTool(
			payload,
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4", input: ["text", "image"] } as never,
		),
		{
			model: "gpt-5.4",
			tools: [
				{ type: "function", name: "exec_command", parameters: { type: "object" } },
				{ type: "image_generation", output_format: "png" },
			],
		},
	);
});

test("rewriteNativeImageGenerationTool leaves unsupported models and providers untouched", () => {
	const payload = {
		model: "gpt-5.3-codex-spark",
		tools: [{ type: "function", name: "image_generation", parameters: { type: "object" } }],
	};

	assert.equal(
		rewriteNativeImageGenerationTool(
			payload,
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex-spark", input: ["text"] } as never,
		),
		payload,
	);
	assert.equal(
		rewriteNativeImageGenerationTool(payload, { provider: "openai", api: "openai-responses", id: "gpt-5", input: ["text", "image"] } as never),
		payload,
	);
});

test("createImageGenerationTool exposes a strict zero-argument schema", () => {
	const tool = createImageGenerationTool();
	assert.equal(tool.description, "Generate an image.");
	assert.equal(tool.promptSnippet, tool.description);
	assert.equal((tool.parameters as { type?: unknown }).type, "object");
	assert.equal((tool.parameters as { additionalProperties?: unknown }).additionalProperties, false);
	assert.equal("properties" in (tool.parameters as object), false);
	assert.deepEqual(tool.prepareArguments?.({ ignored: true }), {});
});

test("createImageGenerationTool renderResult returns an empty component when collapsed", () => {
	const tool = createImageGenerationTool();
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
		{} as never,
	);

	assert.ok(component);
	assert.deepEqual(component.render(120), []);
});
