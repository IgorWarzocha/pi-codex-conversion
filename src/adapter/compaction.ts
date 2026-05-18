import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel, type Tool } from "@earendil-works/pi-ai";
import { executeNativeCompaction } from "./compact-client.ts";
import { sanitizeCompactedWindow } from "./compaction-output.ts";
import { resolveLatestNativeCompactionEntry } from "./details-store.ts";
import { rewriteResponsesPayloadWithNativeReplay, serializeLiveTailToResponsesInput } from "./payload-rewrite.ts";
import { resolveNativeCompactionEnvironment } from "./compaction-runtime.ts";
import { convertResponsesTools } from "../providers/openai-responses-shared.ts";
import {
	serializeCompactionPreparationToRequest,
	type NativeCompactionRequestBody,
	type NativeCompactionRequestOptions,
	type ResponsesInputItem,
} from "./serializer.ts";
import { createNativeCompactionDetails, createNativeCompactionShimResult, isNativeCompactionDetails } from "./types.ts";
import { isOpenAICodexContext, isResponsesContext } from "./codex-model.ts";
import { shouldUseCodexAdapter } from "./activation.ts";
import type { AdapterState } from "./state.ts";
import { rewriteNativeImageGenerationTool } from "../tools/image-generation-tool.ts";
import { rewriteNativeWebSearchTool } from "../tools/web-search-tool.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneCompactedWindow(window: readonly unknown[]): ResponsesInputItem[] | undefined {
	if (!window.every(isRecord)) return undefined;
	return window.map((item) => structuredClone(item));
}

function buildCompactionInstructions(systemPrompt: string, customInstructions?: string): string {
	const guidance = customInstructions?.trim();
	return guidance ? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}` : systemPrompt;
}

function buildCompactionTools(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): unknown[] | undefined {
	const activeToolNames = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => activeToolNames.has(tool.name))
		.map((tool): Tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	if (tools.length === 0) return undefined;
	let payload: { tools: unknown[] } = { tools: convertResponsesTools(tools, { strict: null }) };
	if (isOpenAICodexContext(ctx) && state.config.webSearch) {
		payload = rewriteNativeWebSearchTool(payload, ctx.model) as { tools: unknown[] };
	}
	if (isOpenAICodexContext(ctx) && state.config.imageGeneration) {
		payload = rewriteNativeImageGenerationTool(payload, ctx.model) as { tools: unknown[] };
	}
	return payload.tools;
}

function buildCompactionReasoning(pi: ExtensionAPI, ctx: ExtensionContext): NativeCompactionRequestOptions["reasoning"] {
	const model = ctx.model;
	const level = pi.getThinkingLevel();
	if (!model?.reasoning || level === "off") return undefined;
	const clampedLevel = clampThinkingLevel(model, level as ModelThinkingLevel);
	const effort = model.thinkingLevelMap?.[clampedLevel] ?? clampedLevel;
	return effort === null ? undefined : { effort, summary: "auto" };
}

function buildCompactionRequestOptions(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): NativeCompactionRequestOptions {
	const tools = buildCompactionTools(pi, ctx, state);
	const reasoning = buildCompactionReasoning(pi, ctx);
	return {
		parallel_tool_calls: true,
		prompt_cache_key: ctx.sessionManager.getSessionId(),
		...(isOpenAICodexContext(ctx) && state.config.fast ? { service_tier: "priority" } : {}),
		text: { verbosity: state.config.verbosity },
		...(tools ? { tools } : {}),
		...(reasoning ? { reasoning } : {}),
	};
}

function getCompactionIdentity(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? { provider: entry.details.provider, api: entry.details.api, model: entry.details.model, baseUrl: entry.details.baseUrl }
		: undefined;
}

export async function handleCodexSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: AdapterState, pi: ExtensionAPI) {
	if (!state.config.responsesCompaction || !shouldUseCodexAdapter(ctx, state.config) || (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx))) {
		return undefined;
	}
	if (event.signal.aborted) return { cancel: true };

	const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true });
	if (!resolution.ok) return undefined;

	const runtime = resolution.runtime;
	const requestOptions = buildCompactionRequestOptions(pi, ctx, state);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});

	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const compactedWindow = cloneCompactedWindow(latestNativeCompaction.entry.details?.compactedWindow ?? []);
		if (!compactedWindow) return undefined;
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		request = {
			model: runtime.currentModel.id,
			input: [
				...compactedWindow,
				...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
			],
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			...requestOptions,
		};
	} else if (latestNativeCompaction.reason === "no-compaction") {
		request = serializeCompactionPreparationToRequest({
			model: runtime.currentModel,
			preparation: event.preparation,
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			requestOptions,
		});
	} else {
		void getCompactionIdentity(latestNativeCompaction.latestCompaction);
		return undefined;
	}

	const compactResult = await executeNativeCompaction({ runtime, request, signal: event.signal });
	if (!compactResult.ok) return compactResult.reason === "aborted" ? { cancel: true } : undefined;
	const compactedWindow = sanitizeCompactedWindow(compactResult.compactedWindow);
	if (compactedWindow.length === 0) return undefined;

	try {
		const details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: { tokensBefore: event.preparation.tokensBefore, previousSummaryPresent: Boolean(event.preparation.previousSummary) },
		});
		return { compaction: createNativeCompactionShimResult({ firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details }) };
	} catch {
		return undefined;
	}
}

export async function rewriteCodexCompactedProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined> {
	if (!state.config.responsesCompaction || !shouldUseCodexAdapter(ctx, state.config) || (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx))) return undefined;
	const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true }, payload);
	if (!resolution.ok) return undefined;
	const runtime = resolution.runtime;
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: runtime.model,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) return undefined;
	if (!runtime.payload) return undefined;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({ model: runtime.currentModel, payload: runtime.payload, branchEntries, compactionEntry: latestNativeCompaction.entry });
	return rewrite.ok ? rewrite.rewrittenPayload : undefined;
}
