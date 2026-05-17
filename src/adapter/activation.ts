import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCodexLikeContext, isOpenAICodexContext, isResponsesContext } from "./codex-model.ts";
import type { CodexConversionConfig } from "./config.ts";
import type { AdapterState } from "./state.ts";
import {
	CORE_ADAPTER_TOOL_NAMES,
	DEFAULT_TOOL_NAMES,
	IMAGE_GENERATION_TOOL_NAME,
	STATUS_KEY,
	VIEW_IMAGE_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
	buildStatusText,
} from "./tool-set.ts";
import { supportsNativeImageGeneration } from "../tools/image-generation-tool.ts";
import { supportsNativeWebSearch } from "../tools/web-search-tool.ts";

const ADAPTER_TOOL_NAMES = [...CORE_ADAPTER_TOOL_NAMES, WEB_SEARCH_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];
const ALWAYS_OWNED_ADAPTER_TOOL_NAMES = [...CORE_ADAPTER_TOOL_NAMES, VIEW_IMAGE_TOOL_NAME];

export function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	if (shouldUseCodexAdapter(ctx, state.config)) {
		enableAdapter(pi, ctx, state);
	} else {
		disableAdapter(pi, ctx, state);
	}
}

export function shouldUseCodexAdapter(ctx: ExtensionContext, config: CodexConversionConfig): boolean {
	return config.useOnAllModels || isCodexLikeContext(ctx);
}

function enableAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const currentAdapterOwnedTools = getAdapterOwnedToolNames(state.config);
	const adapterOwnedTools = state.enabled ? mergeToolNames(state.adapterOwnedToolNames ?? currentAdapterOwnedTools, currentAdapterOwnedTools) : currentAdapterOwnedTools;
	const toolNames = mergeAdapterTools(pi.getActiveTools(), getAdapterToolNames(ctx, state.config), adapterOwnedTools);
	if (!state.enabled) {
		// Preserve the previous active set once so switching away from Codex-like
		// models restores the user's existing Pi tool configuration. Strip adapter
		// tools in case a fresh session starts from persisted/mixed active tools.
		state.previousToolNames = stripAdapterTools(pi.getActiveTools(), adapterOwnedTools);
		state.enabled = true;
	}
	state.adapterOwnedToolNames = currentAdapterOwnedTools;
	pi.setActiveTools(toolNames);
	setStatus(ctx, true, state.config);
}

function disableAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const previousToolNames = state.previousToolNames && state.previousToolNames.length > 0 ? state.previousToolNames : DEFAULT_TOOL_NAMES;
	const adapterOwnedTools = state.adapterOwnedToolNames ?? getAdapterOwnedToolNames(state.config);
	const restoredTools = restoreTools(previousToolNames, pi.getActiveTools(), adapterOwnedTools);
	if (state.enabled || hasAdapterTools(pi.getActiveTools(), adapterOwnedTools)) {
		pi.setActiveTools(restoredTools);
	}
	if (state.enabled) {
		state.enabled = false;
		state.adapterOwnedToolNames = undefined;
	}
	setStatus(ctx, false, state.config);
}

function setStatus(ctx: ExtensionContext, enabled: boolean, config: CodexConversionConfig): void {
	if (!ctx.hasUI) return;
	if (!config.statusLine) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const statusConfig = getStatusConfig(ctx, config);
	ctx.ui.setStatus(STATUS_KEY, enabled ? buildStatusText(statusConfig) : undefined);
}

function getStatusConfig(ctx: ExtensionContext, config: CodexConversionConfig): Parameters<typeof buildStatusText>[0] {
	const showOpenAICodexFlags = isOpenAICodexContext(ctx);
	const showResponsesVerbosity = isResponsesContext(ctx);
	return {
		useOnAllModels: config.useOnAllModels,
		fast: showOpenAICodexFlags && config.fast,
		webSearch: showOpenAICodexFlags && config.webSearch && supportsNativeWebSearch(ctx.model),
		imageGeneration: showOpenAICodexFlags && config.imageGeneration && supportsNativeImageGeneration(ctx.model),
		...(showResponsesVerbosity ? { verbosity: config.verbosity } : {}),
	};
}

function getAdapterToolNames(ctx: ExtensionContext, config: CodexConversionConfig): string[] {
	const toolNames = [...CORE_ADAPTER_TOOL_NAMES];
	if (config.webSearch && supportsNativeWebSearch(ctx.model)) {
		toolNames.push(WEB_SEARCH_TOOL_NAME);
	}
	if (config.imageGeneration && supportsNativeImageGeneration(ctx.model)) {
		toolNames.push(IMAGE_GENERATION_TOOL_NAME);
	}
	if (Array.isArray(ctx.model?.input) && ctx.model.input.includes("image")) {
		toolNames.push(VIEW_IMAGE_TOOL_NAME);
	}
	return toolNames;
}

function getAdapterOwnedToolNames(config: CodexConversionConfig): string[] {
	return [
		...ALWAYS_OWNED_ADAPTER_TOOL_NAMES,
		...(config.webSearch ? [WEB_SEARCH_TOOL_NAME] : []),
		...(config.imageGeneration ? [IMAGE_GENERATION_TOOL_NAME] : []),
	];
}

function mergeToolNames(...toolNameGroups: string[][]): string[] {
	return [...new Set(toolNameGroups.flat())];
}

export function mergeAdapterTools(activeTools: string[], adapterTools: string[], adapterOwnedTools: string[] = adapterTools): string[] {
	const ownedTools = new Set([...ALWAYS_OWNED_ADAPTER_TOOL_NAMES, ...adapterTools, ...adapterOwnedTools]);
	const preservedTools = activeTools.filter((toolName) => !DEFAULT_TOOL_NAMES.includes(toolName) && !ownedTools.has(toolName));
	return [...adapterTools, ...preservedTools];
}

export function restoreTools(previousTools: string[], activeTools: string[], adapterOwnedTools: string[] = ADAPTER_TOOL_NAMES): string[] {
	const restored = stripAdapterTools(previousTools, adapterOwnedTools);
	for (const toolName of activeTools) {
		if (!adapterOwnedTools.includes(toolName) && !restored.includes(toolName)) {
			restored.push(toolName);
		}
	}
	return restored;
}

export function stripAdapterTools(toolNames: string[], adapterOwnedTools: string[] = ADAPTER_TOOL_NAMES): string[] {
	return toolNames.filter((toolName) => !adapterOwnedTools.includes(toolName));
}

function hasAdapterTools(activeTools: string[], adapterOwnedTools: string[]): boolean {
	return activeTools.some((toolName) => adapterOwnedTools.includes(toolName));
}
