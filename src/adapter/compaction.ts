import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client.ts";
import { resolveLatestNativeCompactionEntry } from "./details-store.ts";
import { rewriteResponsesPayloadWithNativeReplay, serializeLiveTailToResponsesInput } from "./payload-rewrite.ts";
import { resolveNativeCompactionEnvironment } from "./compaction-runtime.ts";
import { serializeCompactionPreparationToRequest, type NativeCompactionRequestBody, type ResponsesInputItem } from "./serializer.ts";
import { createNativeCompactionDetails, createNativeCompactionShimResult, isNativeCompactionDetails } from "./types.ts";
import { isOpenAICodexContext, isResponsesContext } from "./codex-model.ts";
import { shouldUseCodexAdapter } from "./activation.ts";
import type { AdapterState } from "./state.ts";

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

function getCompactionIdentity(entry: { details?: unknown } | undefined) {
	return isNativeCompactionDetails(entry?.details)
		? { provider: entry.details.provider, api: entry.details.api, model: entry.details.model, baseUrl: entry.details.baseUrl }
		: undefined;
}

export async function handleCodexSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: AdapterState) {
	if (!state.config.responsesCompaction || !shouldUseCodexAdapter(ctx, state.config) || (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx))) {
		return undefined;
	}
	if (event.signal.aborted) return { cancel: true };

	const resolution = await resolveNativeCompactionEnvironment(ctx, { enabled: true });
	if (!resolution.ok) return undefined;

	const runtime = resolution.runtime;
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
		};
	} else if (latestNativeCompaction.reason === "no-compaction") {
		request = serializeCompactionPreparationToRequest({
			model: runtime.currentModel,
			preparation: event.preparation,
			instructions: buildCompactionInstructions(ctx.getSystemPrompt(), event.customInstructions),
		});
	} else {
		void getCompactionIdentity(latestNativeCompaction.latestCompaction);
		return undefined;
	}

	const compactResult = await executeNativeCompaction({ runtime, request, signal: event.signal });
	if (!compactResult.ok) return compactResult.reason === "aborted" ? { cancel: true } : undefined;

	try {
		const details = createNativeCompactionDetails({
			provider: runtime.provider,
			api: runtime.api,
			model: runtime.model,
			baseUrl: runtime.baseUrl,
			compactedWindow: compactResult.compactedWindow,
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
