import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ResponsesCompatibleRequestPayload } from "./compaction-runtime.ts";

/**
 * Decision for T4: keep a narrow local serializer instead of importing Pi internals.
 *
 * Why this is sufficient for v1:
 * - we only target same-model OpenAI Responses-compatible requests
 * - we only need Pi's current supported message semantics (assistant phase,
 *   reasoning signatures, tool call/result pairing, image blocks)
 * - Pi's shared Responses converter is not publicly exported, so importing it
 *   would require a brittle install-path-specific wrapper
 *
 * The helpers below intentionally mirror Pi's same-model Responses serialization
 * rules closely so later tasks can compare their output against captured
 * before_provider_request payload artifacts.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "local-same-model-responses-serializer" as const;

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
	parallel_tool_calls?: boolean;
	prompt_cache_key?: string;
	service_tier?: string;
	text?: { verbosity: string };
	tools?: unknown[];
	reasoning?: unknown;
};

export type NativeCompactionRequestOptions = Pick<
	NativeCompactionRequestBody,
	"parallel_tool_calls" | "prompt_cache_key" | "service_tier" | "text" | "tools" | "reasoning"
>;

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
	blockImages?: boolean;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function readBlockImagesSetting(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8")) as unknown;
		return isRecord(parsed) && isRecord(parsed.images) && parsed.images.blockImages === true;
	} catch {
		return false;
	}
}

function replaceImagesWithDisabledPlaceholder<TMessage extends UserMessage | ToolResultMessage>(message: TMessage): TMessage {
	if (!Array.isArray(message.content) || !message.content.some((item) => item.type === "image")) return message;
	const content = message.content
		.map((item): TextContent | ImageContent => item.type === "image" ? { type: "text", text: "Image reading is disabled." } : item)
		.filter((item, index, items) => {
			const previous = items[index - 1];
			return !(item.type === "text" && item.text === "Image reading is disabled." && previous?.type === "text" && previous.text === "Image reading is disabled.");
		});
	return { ...message, content };
}

function applyBlockImages(messages: Message[], blockImages: boolean): Message[] {
	if (!blockImages) return messages;
	return messages.map((message) => {
		if (message.role === "user" || message.role === "toolResult") return replaceImagesWithDisabledPlaceholder(message);
		return message;
	});
}

type CompactionPreparationLike = { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[]; previousSummary?: string };

export function collectCompactionWindowMessages(preparation: CompactionPreparationLike): AgentMessage[] {
	const previousSummary = preparation.previousSummary?.trim();
	const previousSummaryMessages: AgentMessage[] = previousSummary
		? [
				{
					role: "user",
					content: `Previous compaction summary:\n${previousSummary}`,
					timestamp: Date.now(),
				} as AgentMessage,
			]
		: [];
	return [...previousSummaryMessages, ...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparationLike;
	instructions: string;
	requestOptions?: NativeCompactionRequestOptions;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
		requestOptions: args.requestOptions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
	requestOptions?: NativeCompactionRequestOptions;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
		...args.requestOptions,
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	const llmMessages = applyBlockImages(convertToLlm(messages), options.blockImages ?? readBlockImagesSetting());
	const transformedMessages = transformMessagesForResponses(llmMessages, model);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	for (const message of transformedMessages) {
		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex);
			if (items.length > 0) {
				input.push(...items);
			}
			messageIndex++;
			continue;
		}

		input.push(serializeToolResultMessage(message, model));
		messageIndex++;
	}

	return input;
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

function isSameModelAssistant<TApi extends Api>(message: AssistantMessage, model: Model<TApi>): boolean {
	return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

function transformMessagesForResponses<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const transformed: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (const message of messages) {
		if (message.role === "assistant") {
			const isSameModel = isSameModelAssistant(message, model);
			if (pendingToolCalls.length > 0) {
				transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
				pendingToolCalls = [];
				existingToolResultIds = new Set<string>();
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			const normalizedContent = message.content.flatMap((block): Array<TextContent | ThinkingContent | ToolCall> => {
				if (block.type !== "thinking") {
					return [block];
				}

				if (isSameModel && block.thinkingSignature) return [block];
				if (!block.thinking || block.thinking.trim() === "") return [];
				return [{ type: "text", text: block.thinking }];
			});

			const normalizedAssistantMessage: AssistantMessage = {
				...message,
				content: normalizedContent,
			};
			transformed.push(normalizedAssistantMessage);

			const toolCalls = normalizedContent.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set<string>();
			}
			continue;
		}

		if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			transformed.push(message);
			continue;
		}

		if (pendingToolCalls.length > 0) {
			transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
			pendingToolCalls = [];
			existingToolResultIds = new Set<string>();
		}

		transformed.push(message);
	}

	if (pendingToolCalls.length > 0) {
		transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds));
	}

	return transformed;
}

function createSyntheticToolResults(
	pendingToolCalls: readonly ToolCall[],
	existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
	const syntheticResults: ToolResultMessage[] = [];

	for (const toolCall of pendingToolCalls) {
		if (existingToolResultIds.has(toolCall.id)) {
			continue;
		}

		syntheticResults.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: Date.now(),
		});
	}

	return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [{ type: "input_text", text: NON_VISION_USER_IMAGE_PLACEHOLDER }];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

type ImageGenerationCallItem = {
	type: "image_generation_call";
	id: string;
	status: string;
	result: string | null;
	revised_prompt?: string;
};

type ImageGenerationCallBlock = {
	type: "image_generation_call";
	item: ImageGenerationCallItem;
};

function isImageGenerationCallBlock(block: unknown): block is ImageGenerationCallBlock {
	return isRecord(block) && block.type === "image_generation_call" && isRecord(block.item) && block.item.type === "image_generation_call";
}

function sanitizeImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined {
	if (!isRecord(item)) return undefined;
	if (item.type !== "image_generation_call") return undefined;
	if (typeof item.id !== "string" || item.id === "") return undefined;
	if (typeof item.status !== "string" || item.status === "") return undefined;
	if (!(typeof item.result === "string" || item.result === null)) return undefined;
	return {
		type: "image_generation_call",
		id: item.id,
		status: item.status,
		result: item.result,
		...(typeof item.revised_prompt === "string" ? { revised_prompt: item.revised_prompt } : {}),
	};
}

function serializeAssistantMessage(message: AssistantMessage, messageIndex: number): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	let assistantBlockIndex = 0;

	for (const block of message.content as Array<AssistantMessage["content"][number] | ImageGenerationCallBlock>) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) {
				items.push(reasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex, assistantBlockIndex),
				phase: signature?.phase,
			});
			assistantBlockIndex++;
			continue;
		}

		if (isImageGenerationCallBlock(block)) {
			const imageGenerationCall = sanitizeImageGenerationCallItem(block.item);
			if (imageGenerationCall) items.push(imageGenerationCall);
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		items.push({
			type: "function_call",
			id: rawItemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
	const [callId] = message.toolCallId.split("|");
	const textOutput = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = message.content.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of message.content) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type: "function_call_output",
			call_id: callId,
			output,
		};
	}

	return {
		type: "function_call_output",
		call_id: callId,
		output: hasText ? textOutput : hasImages ? NON_VISION_TOOL_IMAGE_PLACEHOLDER : "(see attached image)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return undefined;
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number, assistantBlockIndex: number): string {
	if (!id) {
		return `msg_${messageIndex}_${assistantBlockIndex}`;
	}

	if (id.length <= 64) {
		return id;
	}

	return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call") {
		return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output") {
		return "function_call_output";
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
