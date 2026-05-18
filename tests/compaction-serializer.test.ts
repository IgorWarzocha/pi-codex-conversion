import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { serializeMessagesToCompactRequest, serializeMessagesToResponsesInput } from "../src/adapter/serializer.ts";

const model = {
	id: "gpt-5.1",
	provider: "openai-codex",
	api: "openai-codex-responses",
	reasoning: true,
	input: ["text", "image"],
} as Model<any>;

test("compaction serializer gives unsigned assistant text blocks unique fallback ids", () => {
	const input = serializeMessagesToResponsesInput(model, [
		{
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1",
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AgentMessage,
	]);

	assert.deepEqual(input.map((item) => (item as { id?: string }).id), ["msg_0_0", "msg_0_1"]);
});

test("compaction serializer preserves image generation call blocks", () => {
	const imageCall = {
		type: "image_generation_call",
		item: { type: "image_generation_call", id: "ig_1", status: "completed", result: null },
	};
	const input = serializeMessagesToResponsesInput(model, [
		{
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1",
			content: [imageCall],
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AgentMessage,
	]);

	assert.deepEqual(input, [imageCall.item]);
});

test("compaction serializer honors blocked image conversion", () => {
	const input = serializeMessagesToResponsesInput(model, [
		{
			role: "user",
			content: [{ type: "image", data: "abc", mimeType: "image/png" }],
			timestamp: Date.now(),
		} as unknown as AgentMessage,
	], { blockImages: true });

	assert.deepEqual(input, [{ role: "user", content: [{ type: "input_text", text: "Image reading is disabled." }] }]);
});

test("native compaction requests include Codex-compatible base metadata", () => {
	const request = serializeMessagesToCompactRequest({
		model,
		messages: [],
		instructions: "compact",
	});

	assert.equal(request.store, false);
	assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
});
