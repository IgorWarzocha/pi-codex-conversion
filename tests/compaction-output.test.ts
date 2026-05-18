import test from "node:test";
import assert from "node:assert/strict";
import { extractCompactionSummaryText, sanitizeCompactedWindow, shouldKeepCompactedOutputItem } from "../src/adapter/compaction-output.ts";

test("sanitizeCompactedWindow keeps only Codex-installable compact output", () => {
	const assistant = { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "summary", annotations: [] }] };
	const user = { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] };
	const compaction = { type: "compaction", encrypted_content: "sealed" };
	const output = [
		{ type: "message", role: "developer", content: "stale instructions" },
		{ type: "message", role: "system", content: "stale system" },
		assistant,
		user,
		{ type: "reasoning", encrypted_content: "foreign" },
		{ type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_1", output: "done" },
		{ type: "web_search_call", id: "ws_1" },
		{ type: "image_generation_call", id: "ig_1" },
		{ type: "context_compaction", encrypted_content: "v2-only" },
		compaction,
		{ nope: true },
		"bad",
	];

	assert.deepEqual(sanitizeCompactedWindow(output), [assistant, user, compaction]);
});

test("sanitizeCompactedWindow clones kept output", () => {
	const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [] }] }];
	const sanitized = sanitizeCompactedWindow(output);
	assert.deepEqual(sanitized, output);
	assert.notEqual(sanitized[0], output[0]);
	assert.notEqual(sanitized[0]?.content, output[0]?.content);
});

test("shouldKeepCompactedOutputItem rejects malformed and non-installable items", () => {
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "assistant" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "user" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "compaction", encrypted_content: "sealed" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "context_compaction", encrypted_content: "v2-only" }), false);
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "developer" }), false);
	assert.equal(shouldKeepCompactedOutputItem({ type: "function_call" }), false);
	assert.equal(shouldKeepCompactedOutputItem({ role: "assistant" }), false);
	assert.equal(shouldKeepCompactedOutputItem(null), false);
});

test("extractCompactionSummaryText prefers assistant compact summary text", () => {
	assert.equal(
		extractCompactionSummaryText([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "prior user" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex compact summary" }] },
			{ type: "compaction", encrypted_content: "sealed" },
		]),
		"Codex compact summary",
	);
});

test("extractCompactionSummaryText falls back to compaction encrypted content", () => {
	assert.equal(extractCompactionSummaryText([{ type: "compaction", encrypted_content: "sealed summary" }]), "sealed summary");
});
