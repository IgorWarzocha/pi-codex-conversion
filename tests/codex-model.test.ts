import test from "node:test";
import assert from "node:assert/strict";
import { isCodexLikeModel, isOpenAICodexModel, isResponsesModel } from "../src/adapter/codex-model.ts";

test("detects codex provider and model ids", () => {
	assert.equal(isCodexLikeModel({ provider: "openai-codex", api: "responses", id: "codex-mini-latest" }), true);
	assert.equal(isCodexLikeModel({ provider: "OpenAI", api: "responses", id: "gpt-5" }), true);
	assert.equal(isCodexLikeModel({ provider: "github-copilot", api: "chat-completions", id: "gpt-5.4" }), true);
	assert.equal(isCodexLikeModel({ provider: "acme-codex", api: "custom", id: "assistant" }), true);
});

test("avoids false positives for non-openai non-codex models", () => {
	assert.equal(isCodexLikeModel({ provider: "anthropic", api: "messages", id: "claude-sonnet-4" }), false);
	assert.equal(isCodexLikeModel(undefined), false);
});

test("native web search gating is restricted to the openai-codex provider", () => {
	assert.equal(isOpenAICodexModel({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" }), true);
	assert.equal(isOpenAICodexModel({ provider: "openai", api: "openai-responses", id: "gpt-5" }), false);
	assert.equal(isOpenAICodexModel({ provider: "github-copilot", api: "chat-completions", id: "gpt-5.4" }), false);
});

test("verbosity support follows responses-family APIs", () => {
	assert.equal(isResponsesModel({ provider: "openai", api: "openai-responses", id: "gpt-5" }), true);
	assert.equal(isResponsesModel({ provider: "azure", api: "azure-openai-responses", id: "gpt-5" }), true);
	assert.equal(isResponsesModel({ provider: "anthropic", api: "messages", id: "claude-sonnet-4" }), false);
});
