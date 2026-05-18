import test from "node:test";
import assert from "node:assert/strict";
import { extractCompactionSummaryText, hasCompactionOutputItem, sanitizeCompactedWindow, shouldKeepCompactedOutputItem } from "../src/adapter/compaction-output.ts";

test("sanitizeCompactedWindow preserves structured compact output items", () => {
	const assistant = { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "summary", annotations: [] }] };
	const user = { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] };
	const compaction = { type: "compaction_summary", encrypted_content: "sealed" };
	const reasoning = { type: "reasoning", encrypted_content: "foreign" };
	const functionCall = { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" };
	const functionCallOutput = { type: "function_call_output", call_id: "call_1", output: "done" };
	const webSearchCall = { type: "web_search_call", id: "ws_1" };
	const imageGenerationCall = { type: "image_generation_call", id: "ig_1" };
	const output = [
		{ type: "message", role: "developer", content: "stale instructions" },
		{ type: "message", role: "system", content: "stale system" },
		assistant,
		user,
		reasoning,
		functionCall,
		functionCallOutput,
		webSearchCall,
		imageGenerationCall,
		{ type: "context_compaction", encrypted_content: "v2-only" },
		compaction,
		{ nope: true },
		"bad",
	];

	assert.deepEqual(sanitizeCompactedWindow(output), output.slice(0, 11));
});

test("sanitizeCompactedWindow clones kept output", () => {
	const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "summary", annotations: [] }] }];
	const sanitized = sanitizeCompactedWindow(output);
	assert.deepEqual(sanitized, output);
	assert.notEqual(sanitized[0], output[0]);
	assert.notEqual(sanitized[0]?.content, output[0]?.content);
});

test("shouldKeepCompactedOutputItem rejects malformed compact output items", () => {
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "assistant" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "user" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "compaction", encrypted_content: "sealed" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "compaction_summary", encrypted_content: "sealed" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "context_compaction", encrypted_content: "v2-only" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "message", role: "developer" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ type: "function_call" }), true);
	assert.equal(shouldKeepCompactedOutputItem({ role: "assistant" }), false);
	assert.equal(shouldKeepCompactedOutputItem(null), false);
});

test("extractCompactionSummaryText prefers explicit compaction content", () => {
	assert.equal(
		extractCompactionSummaryText([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "prior user" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex compact summary" }] },
			{ type: "compaction", encrypted_content: "sealed" },
		]),
		"sealed",
	);
});

test("extractCompactionSummaryText does not present retained messages as a summary", () => {
	assert.equal(
		extractCompactionSummaryText([
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "retained assistant turn" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "retained user turn" }] },
		]),
		undefined,
	);
});

test("hasCompactionOutputItem detects whether native compact returned a compaction item", () => {
	assert.equal(hasCompactionOutputItem([{ type: "message", role: "assistant" }]), false);
	assert.equal(hasCompactionOutputItem([{ type: "compaction", encrypted_content: "sealed" }]), true);
	assert.equal(hasCompactionOutputItem([{ type: "compaction_summary", encrypted_content: "sealed" }]), true);
});
