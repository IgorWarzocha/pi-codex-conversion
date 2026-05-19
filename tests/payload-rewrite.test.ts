import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { buildNativeReplaySegments } from "../src/adapter/payload-rewrite.ts";
import { serializeMessagesToResponsesInput } from "../src/adapter/serializer.ts";
import { NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, NATIVE_COMPACTION_STRATEGY, type NativeCompactionEntry } from "../src/adapter/types.ts";

const model = {
	id: "gpt-5.1",
	provider: "openai-codex",
	api: "openai-codex-responses",
	reasoning: true,
	input: ["text"],
} as Model<any>;

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

function custom(customType: string, content: string, timestamp = 1): AgentMessage {
	return { role: "custom", customType, content, display: true, timestamp } as AgentMessage;
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage) {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp ?? 1).toISOString(), message } as any;
}

function customMessageEntry(id: string, parentId: string | null, message: AgentMessage) {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: new Date(message.timestamp ?? 1).toISOString(),
		customType: (message as { customType: string }).customType,
		content: (message as { content: string }).content,
		display: true,
		details: undefined,
	} as any;
}

function compactionEntry(parentId: string): NativeCompactionEntry {
	return {
		type: "compaction",
		id: "compact",
		parentId,
		timestamp: new Date(3).toISOString(),
		summary: "[OpenAI native compaction checkpoint]",
		firstKeptEntryId: "pre",
		tokensBefore: 100,
		details: {
			strategy: NATIVE_COMPACTION_STRATEGY,
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1",
			baseUrl: "https://chatgpt.com/backend-api",
			createdAt: new Date(4).toISOString(),
			compactedWindow: [{ type: "compaction_summary", encrypted_content: "sealed" }],
		},
	} as NativeCompactionEntry;
}

function compactionSummaryMessage(entry: NativeCompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function runReplay(payloadMessages: AgentMessage[]) {
	const pre = messageEntry("pre", null, user("pre", 1));
	const compaction = compactionEntry("pre");
	const display = customMessageEntry("display", "compact", custom(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, "display", 5));
	const tail = messageEntry("tail", "display", user("tail", 6));
	return buildNativeReplaySegments({
		model,
		payload: { model: model.id, input: serializeMessagesToResponsesInput(model, payloadMessages), instructions: "" },
		branchEntries: [pre, compaction, display, tail],
		compactionEntry: compaction,
	});
}

test("native replay accepts Pi payloads that include adapter display messages", () => {
	const compaction = compactionEntry("pre");
	const result = runReplay([
		compactionSummaryMessage(compaction),
		user("pre", 1),
		custom(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, "display", 5),
		user("tail", 6),
	]);

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.rewrittenPayload.input.map((item) => (item as { type?: string; role?: string }).type ?? (item as { role?: string }).role), ["compaction_summary", "user"]);
});

test("native replay accepts Pi payloads that omit adapter display messages", () => {
	const compaction = compactionEntry("pre");
	const result = runReplay([
		compactionSummaryMessage(compaction),
		user("pre", 1),
		user("tail", 6),
	]);

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.rewrittenPayload.input.map((item) => (item as { type?: string; role?: string }).type ?? (item as { role?: string }).role), ["compaction_summary", "user"]);
});

test("native replay preserves current payload tail beyond persisted branch entries", () => {
	const compaction = compactionEntry("pre");
	const result = runReplay([
		compactionSummaryMessage(compaction),
		user("pre", 1),
		user("tail", 6),
		user("current", 7),
	]);

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.rewrittenPayload.input.map((item) => (item as { type?: string; role?: string }).type ?? (item as { role?: string }).role), ["compaction_summary", "user", "user"]);
});
