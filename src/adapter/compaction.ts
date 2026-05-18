import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type ModelThinkingLevel, type Tool } from "@earendil-works/pi-ai";
import { executeNativeCompaction } from "./compact-client.ts";
import { extractCompactionSummaryText, hasCompactionOutputItem, sanitizeCompactedWindow, summarizeCompactionOutputForDiagnostics } from "./compaction-output.ts";
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
import { createNativeCompactionDetails, createNativeCompactionShimResult, isNativeCompactionDetails, NATIVE_COMPACTION_SHIM_SUMMARY } from "./types.ts";
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

function findEntryIndexByIdBeforeBoundary(entries: readonly { id: string }[], entryId: string, boundaryIndex: number): number | undefined {
	const index = entries.findIndex((entry, candidateIndex) => candidateIndex < boundaryIndex && entry.id === entryId);
	return index >= 0 ? index : undefined;
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

function buildCompactionReasoning(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState, compactionModel: string): NativeCompactionRequestOptions["reasoning"] {
	const model = ctx.model;
	const level = state.config.compactionReasoning === "current" ? pi.getThinkingLevel() : state.config.compactionReasoning;
	if (!model?.reasoning || level === "off") return undefined;
	const clampedLevel = clampThinkingLevel(model, level as ModelThinkingLevel);
	const rawEffort = model.thinkingLevelMap?.[clampedLevel] ?? clampedLevel;
	const effort = typeof rawEffort === "string" && isOpenAICodexContext(ctx) ? clampCodexReasoningEffort(compactionModel, rawEffort) : rawEffort;
	return effort === null ? undefined : { effort, summary: "auto" };
}

function clampCodexReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	const gpt5MinorMatch = /^gpt-5\.(\d+)/.exec(id);
	const gpt5Minor = gpt5MinorMatch ? Number.parseInt(gpt5MinorMatch[1], 10) : undefined;
	if (gpt5Minor !== undefined && gpt5Minor >= 2 && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

function buildCompactionRequestOptions(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState, compactionModel: string): NativeCompactionRequestOptions {
	const tools = buildCompactionTools(pi, ctx, state);
	const reasoning = buildCompactionReasoning(pi, ctx, state, compactionModel);
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

function formatCompactFailureMessage(compactResult: Awaited<ReturnType<typeof executeNativeCompaction>>): string {
	if (compactResult.ok) return "OpenAI native compaction succeeded";
	const status = compactResult.status ? ` HTTP ${compactResult.status}` : "";
	const response = compactResult.responseText?.trim();
	const detail = response ? `: ${response.slice(0, 500)}` : compactResult.errorMessage ? `: ${compactResult.errorMessage}` : "";
	return `OpenAI native compaction failed (${compactResult.reason}${status})${detail}; Pi compaction was not run.`;
}

function formatCompactRequestDiagnostics(request: NativeCompactionRequestBody): string {
	const reasoning = isRecord(request.reasoning) && typeof request.reasoning.effort === "string" ? request.reasoning.effort : "none";
	const serviceTier = typeof request.service_tier === "string" ? request.service_tier : "none";
	const tools = Array.isArray(request.tools) ? request.tools.length : 0;
	return `model=${request.model}, input=${request.input.length}, tools=${tools}, reasoning=${reasoning}, service_tier=${serviceTier}`;
}

export async function handleCodexSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: AdapterState, pi: ExtensionAPI) {
	if (!state.config.responsesCompaction || !shouldUseCodexAdapter(ctx, state.config)) {
		return undefined;
	}

	try {
		return await handleCodexSessionBeforeCompactInner(event, ctx, state, pi);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`OpenAI native compaction failed unexpectedly: ${message}; Pi compaction was not run.`, "error");
		return { cancel: true };
	}
}

async function handleCodexSessionBeforeCompactInner(event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: AdapterState, pi: ExtensionAPI) {
	if (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx)) {
		ctx.ui.notify("OpenAI native compaction is enabled, but the current model is not Responses-compatible; Pi compaction was not run.", "error");
		return { cancel: true };
	}
	if (event.signal.aborted) return { cancel: true };

	const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true });
	if (!resolution.ok) {
		ctx.ui.notify(`OpenAI native compaction is enabled but unavailable (${resolution.reason}); Pi compaction was not run.`, "error");
		return { cancel: true };
	}

	const runtime = resolution.runtime;
	const compactionModel = state.config.compactionModel;
	const requestOptions = buildCompactionRequestOptions(pi, ctx, state, compactionModel);
	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries, {
		provider: runtime.provider,
		api: runtime.api,
		model: compactionModel,
		baseUrl: runtime.baseUrl,
	});

	let request: NativeCompactionRequestBody;
	let compactedKeptWindow = false;
	if (latestNativeCompaction.ok) {
		const compactedWindow = cloneCompactedWindow(latestNativeCompaction.entry.details?.compactedWindow ?? []);
		if (!compactedWindow) {
			ctx.ui.notify("OpenAI native compaction could not clone the previous compacted window; Pi compaction was not run.", "error");
			return { cancel: true };
		}
		const previousKeptStartIndex = findEntryIndexByIdBeforeBoundary(
			branchEntries,
			latestNativeCompaction.entry.firstKeptEntryId,
			latestNativeCompaction.index,
		);
		if (previousKeptStartIndex === undefined) {
			ctx.ui.notify("OpenAI native compaction could not find the previous kept-window boundary; Pi compaction was not run.", "error");
			return { cancel: true };
		}
		const previousKeptEntries = branchEntries.slice(previousKeptStartIndex, latestNativeCompaction.index);
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		request = {
			model: compactionModel,
			input: [
				...compactedWindow,
				...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: previousKeptEntries }),
				...serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: liveTailEntries }),
			],
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			...requestOptions,
		};
	} else if (latestNativeCompaction.reason === "no-compaction") {
		request = serializeCompactionPreparationToRequest({
			model: { ...runtime.currentModel, id: compactionModel },
			preparation: event.preparation,
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			requestOptions,
		});
		if (request.input.length === 0) {
			request = {
				model: compactionModel,
				input: serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: branchEntries }),
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
				...requestOptions,
			};
			compactedKeptWindow = true;
		}
	} else {
		void getCompactionIdentity(latestNativeCompaction.latestCompaction);
		request = serializeCompactionPreparationToRequest({
			model: { ...runtime.currentModel, id: compactionModel },
			preparation: event.preparation,
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
			requestOptions,
		});
		if (request.input.length === 0) {
			request = {
				model: compactionModel,
				input: serializeLiveTailToResponsesInput({ model: runtime.currentModel, entries: branchEntries }),
				instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
				...requestOptions,
			};
			compactedKeptWindow = true;
		}
	}

	if (request.input.length === 0) {
		ctx.ui.notify("OpenAI native compaction had no serializable conversation items; Pi compaction was not run.", "error");
		return { cancel: true };
	}

	const compactResult = await executeNativeCompaction({ runtime, request, signal: event.signal });
	if (!compactResult.ok) {
		if (compactResult.reason !== "aborted") {
			ctx.ui.notify(formatCompactFailureMessage(compactResult), "error");
		}
		return { cancel: true };
	}
	const compactedWindow = sanitizeCompactedWindow(compactResult.compactedWindow);
	if (compactedWindow.length === 0) {
		ctx.ui.notify(`OpenAI native compaction returned no installable compacted context; Pi compaction was not run. Request: ${formatCompactRequestDiagnostics(request)}. Output: ${summarizeCompactionOutputForDiagnostics(compactResult.compactedWindow, compactedWindow)}`, "error");
		return { cancel: true };
	}
	if (!hasCompactionOutputItem(compactedWindow)) {
		ctx.ui.notify(`OpenAI native compaction did not return a compaction item; Pi compaction was not run. Response=${compactResult.compactResponseId ?? "<none>"}. Request: ${formatCompactRequestDiagnostics(request)}. Output: ${summarizeCompactionOutputForDiagnostics(compactResult.compactedWindow, compactedWindow)}`, "error");
		return { cancel: true };
	}
	const encryptedSummary = extractCompactionSummaryText(compactedWindow);
	if (!encryptedSummary) {
		ctx.ui.notify(`OpenAI native compaction returned compacted context without a displayable summary; Pi compaction was not run. Response=${compactResult.compactResponseId ?? "<none>"}. Request: ${formatCompactRequestDiagnostics(request)}. Output: ${summarizeCompactionOutputForDiagnostics(compactResult.compactedWindow, compactedWindow)}`, "error");
		return { cancel: true };
	}
	try {
		const details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: compactionModel,
			baseUrl: runtime.baseUrl,
			compactedWindow,
			compactResponseId: compactResult.compactResponseId,
			createdAt: compactResult.createdAt,
			requestMeta: { tokensBefore: event.preparation.tokensBefore, previousSummaryPresent: Boolean(event.preparation.previousSummary), compactedKeptWindow },
		});
		return { compaction: createNativeCompactionShimResult({ summary: NATIVE_COMPACTION_SHIM_SUMMARY, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details }) };
	} catch {
		ctx.ui.notify("OpenAI native compaction produced details Pi could not store; Pi compaction was not run.", "error");
		return { cancel: true };
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
		model: state.config.compactionModel,
		baseUrl: runtime.baseUrl,
	});
	if (!latestNativeCompaction.ok) return undefined;
	if (!runtime.payload) return undefined;
	const rewrite = rewriteResponsesPayloadWithNativeReplay({ model: runtime.currentModel, payload: runtime.payload, branchEntries, compactionEntry: latestNativeCompaction.entry });
	return rewrite.ok ? rewrite.rewrittenPayload : undefined;
}
