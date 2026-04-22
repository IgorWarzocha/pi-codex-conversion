import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCodexRuntimeShell } from "./adapter/runtime-shell.ts";
import {
	CORE_ADAPTER_TOOL_NAMES,
	DEFAULT_TOOL_NAMES,
	IMAGE_GENERATION_TOOL_NAME,
	STATUS_KEY,
	STATUS_TEXT,
	VIEW_IMAGE_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
} from "./adapter/tool-set.ts";
import { clearApplyPatchRenderState, registerApplyPatchTool } from "./tools/apply-patch-tool.ts";
import { isCodexLikeContext, isOpenAICodexContext } from "./adapter/codex-model.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import {
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	registerOpenAICodexCustomProvider,
} from "./providers/openai-codex-custom-provider.ts";
import { registerImageGenerationTool, rewriteNativeImageGenerationTool, supportsNativeImageGeneration } from "./tools/image-generation-tool.ts";
import { buildCodexSystemPrompt, extractPiPromptSkills, type PromptSkill } from "./prompt/build-system-prompt.ts";
import { registerViewImageTool, supportsOriginalImageDetail } from "./tools/view-image-tool.ts";
import {
	registerWebSearchTool,
	registerWebSearchSessionNoteRenderer,
	rewriteNativeWebSearchTool,
	shouldShowWebSearchSessionNote,
	supportsNativeWebSearch,
	WEB_SEARCH_SESSION_NOTE_TEXT,
	WEB_SEARCH_SESSION_NOTE_TYPE,
} from "./tools/web-search-tool.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

interface AdapterState {
	enabled: boolean;
	cwd: string;
	previousToolNames?: string[];
	promptSkills: PromptSkill[];
	webSearchNoticeShown: boolean;
}

const ADAPTER_TOOL_NAMES = [...CORE_ADAPTER_TOOL_NAMES, WEB_SEARCH_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];

function getCommandArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("cmd" in args) || typeof args.cmd !== "string") {
		return undefined;
	}
	return args.cmd;
}

function isToolCallOnlyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
		return false;
	}
	if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) {
		return false;
	}
	return message.content.every((item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall");
}

export default function codexConversion(pi: ExtensionAPI) {
	const tracker = createExecCommandTracker();
	const state: AdapterState = { enabled: false, cwd: process.cwd(), promptSkills: [], webSearchNoticeShown: false };
	const sessions = createExecSessionManager();

	registerOpenAICodexCustomProvider(pi, {
		getCurrentCwd: () => state.cwd,
	});
	registerApplyPatchTool(pi);
	registerExecCommandTool(pi, tracker, sessions);
	registerWriteStdinTool(pi, sessions);
	registerImageGenerationTool(pi);
	registerWebSearchTool(pi);
	registerWebSearchSessionNoteRenderer(pi);

	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		state.webSearchNoticeShown = false;
		clearApplyPatchRenderState();
		tracker.clear();
		syncAdapter(pi, ctx, state);
	});

	pi.on("model_select", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		syncAdapter(pi, ctx, state);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		tracker.resetExplorationGroup();
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "exec_command") {
			tracker.resetExplorationGroup();
			return;
		}
		const command = getCommandArg(event.args);
		if (!command) return;
		tracker.recordStart(event.toolCallId, command);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "exec_command") return;
		tracker.recordEnd(event.toolCallId);
	});

	pi.on("session_shutdown", async () => {
		clearApplyPatchRenderState();
		sessions.shutdown();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isCodexLikeContext(ctx)) {
			return undefined;
		}
		return {
			systemPrompt: buildCodexSystemPrompt(event.systemPrompt, {
				skills: state.promptSkills,
				shell: getCodexRuntimeShell(process.env.SHELL),
			}),
		};
	});

	pi.on("before_provider_request", async (event, ctx) => {
		state.cwd = ctx.cwd;
		if (!isOpenAICodexContext(ctx)) {
			return undefined;
		}
		return rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(event.payload, ctx.model), ctx.model);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) =>
					!(
						message.role === "custom" &&
						(message.customType === WEB_SEARCH_SESSION_NOTE_TYPE ||
							message.customType === WEB_SEARCH_ACTIVITY_MESSAGE_TYPE ||
							message.customType === IMAGE_SAVE_DISPLAY_MESSAGE_TYPE)
					),
			),
		};
	});
}

function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());

	registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });
	maybeShowWebSearchSessionNote(pi, ctx, state);

	if (isCodexLikeContext(ctx)) {
		enableAdapter(pi, ctx, state);
	} else {
		disableAdapter(pi, ctx, state);
	}
}

function enableAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const toolNames = mergeAdapterTools(pi.getActiveTools(), getAdapterToolNames(ctx));
	if (!state.enabled) {
		// Preserve the previous active set once so switching away from Codex-like
		// models restores the user's existing Pi tool configuration.
		state.previousToolNames = pi.getActiveTools();
		state.enabled = true;
	}
	pi.setActiveTools(toolNames);
	setStatus(ctx, true);
}

function disableAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const previousToolNames = state.previousToolNames && state.previousToolNames.length > 0 ? state.previousToolNames : DEFAULT_TOOL_NAMES;
	const restoredTools = restoreTools(previousToolNames, pi.getActiveTools());
	if (state.enabled || hasAdapterTools(pi.getActiveTools())) {
		pi.setActiveTools(restoredTools);
	}
	if (state.enabled) {
		state.enabled = false;
	}
	setStatus(ctx, false);
}

function setStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, enabled ? STATUS_TEXT : undefined);
}

function getAdapterToolNames(ctx: ExtensionContext): string[] {
	const toolNames = [...CORE_ADAPTER_TOOL_NAMES];
	if (supportsNativeWebSearch(ctx.model)) {
		toolNames.push(WEB_SEARCH_TOOL_NAME);
	}
	if (supportsNativeImageGeneration(ctx.model)) {
		toolNames.push(IMAGE_GENERATION_TOOL_NAME);
	}
	if (Array.isArray(ctx.model?.input) && ctx.model.input.includes("image")) {
		toolNames.push(VIEW_IMAGE_TOOL_NAME);
	}
	return toolNames;
}

export function mergeAdapterTools(activeTools: string[], adapterTools: string[]): string[] {
	const preservedTools = activeTools.filter((toolName) => !DEFAULT_TOOL_NAMES.includes(toolName) && !ADAPTER_TOOL_NAMES.includes(toolName));
	return [...adapterTools, ...preservedTools];
}

export function restoreTools(previousTools: string[], activeTools: string[]): string[] {
	const restored = [...previousTools];
	for (const toolName of activeTools) {
		if (!ADAPTER_TOOL_NAMES.includes(toolName) && !restored.includes(toolName)) {
			restored.push(toolName);
		}
	}
	return restored;
}

function hasAdapterTools(activeTools: string[]): boolean {
	return activeTools.some((toolName) => ADAPTER_TOOL_NAMES.includes(toolName));
}

function maybeShowWebSearchSessionNote(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	if (!shouldShowWebSearchSessionNote(ctx.model, ctx.hasUI, state.webSearchNoticeShown)) {
		return;
	}
	pi.sendMessage({
		customType: WEB_SEARCH_SESSION_NOTE_TYPE,
		content: WEB_SEARCH_SESSION_NOTE_TEXT,
		display: true,
	});
	state.webSearchNoticeShown = true;
}
