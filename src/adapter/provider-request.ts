import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOpenAICodexContext, isResponsesContext } from "./codex-model.ts";
import { applyCodexRequestParams } from "./config.ts";
import type { AdapterState } from "./state.ts";
import { rewriteNativeImageGenerationTool } from "../tools/image-generation-tool.ts";
import { rewriteNativeWebSearchTool } from "../tools/web-search-tool.ts";
import { shouldUseCodexAdapter } from "./activation.ts";
import { rewriteCodexCompactedProviderRequest } from "./compaction.ts";

export async function rewriteCodexProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined> {
	if (!shouldUseCodexAdapter(ctx, state.config) || (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx))) {
		return undefined;
	}

	const isOpenAICodex = isOpenAICodexContext(ctx);
	const webSearchPayload = isOpenAICodex && state.config.webSearch ? rewriteNativeWebSearchTool(payload, ctx.model) : payload;
	const imageGenerationPayload = isOpenAICodex && state.config.imageGeneration
		? rewriteNativeImageGenerationTool(webSearchPayload, ctx.model)
		: webSearchPayload;
	const configuredPayload = applyCodexRequestParams(imageGenerationPayload, state.config, {
		serviceTier: isOpenAICodex,
		verbosity: true,
	});
	return (await rewriteCodexCompactedProviderRequest(configuredPayload, ctx, state)) ?? configuredPayload;
}
