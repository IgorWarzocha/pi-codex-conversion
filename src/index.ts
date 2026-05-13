import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import { buildCodexSystemPrompt, extractPiPromptSkills, resolvePromptSkills, type PromptSkill } from "./prompt/build-system-prompt.ts";
import { registerViewImageTool, supportsOriginalImageDetail } from "./tools/view-image-tool.ts";
import {
	registerWebSearchTool,
	rewriteNativeWebSearchTool,
	supportsNativeWebSearch,
	WEB_SEARCH_SESSION_NOTE_TYPE,
} from "./tools/web-search-tool.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import { ensureBundledApplyPatchOnPath } from "./tools/apply-patch-binary.ts";

interface AdapterState {
	enabled: boolean;
	cwd: string;
	fastModeEnabled: boolean;
	previousToolNames?: string[];
	promptSkills: PromptSkill[];
}

const ADAPTER_TOOL_NAMES = [...CORE_ADAPTER_TOOL_NAMES, WEB_SEARCH_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];
const FAST_MODE_STATUS_KEY = "codex-fast";
const FAST_MODE_STATUS_TEXT = "fast";
const FAST_MODE_SERVICE_TIER = "priority";

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
	ensureBundledApplyPatchOnPath();
	const tracker = createExecCommandTracker();
	const state: AdapterState = { enabled: false, cwd: process.cwd(), fastModeEnabled: false, promptSkills: [] };
	const sessions = createExecSessionManager();

	registerOpenAICodexCustomProvider(pi, {
		getCurrentCwd: () => state.cwd,
	});
	registerApplyPatchTool(pi);
	registerExecCommandTool(pi, tracker, sessions);
	registerWriteStdinTool(pi, sessions);
	registerImageGenerationTool(pi);
	registerWebSearchTool(pi);
	registerFastModeCommand(pi, state);

	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		state.fastModeEnabled = false;
		clearApplyPatchRenderState();
		tracker.clear();
		syncAdapter(pi, ctx, state);
	});

	pi.on("resources_discover", async (event) => {
		const skillPaths = getCodexSkillPaths(event.cwd);
		return skillPaths.length > 0 ? { skillPaths } : undefined;
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
		const skills = resolvePromptSkills(event.systemPromptOptions?.skills, state.promptSkills);
		return {
			systemPrompt: buildCodexSystemPrompt(event.systemPrompt, {
				skills,
				shell: getCodexRuntimeShell(process.env.SHELL),
			}),
		};
	});

	pi.on("before_provider_request", async (event, ctx) => {
		state.cwd = ctx.cwd;
		if (!isOpenAICodexContext(ctx)) {
			return undefined;
		}
		const rewrittenPayload = rewriteNativeImageGenerationTool(rewriteNativeWebSearchTool(event.payload, ctx.model), ctx.model);
		return applyFastServiceTier(rewrittenPayload, state.fastModeEnabled);
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

function registerFastModeCommand(pi: ExtensionAPI, state: AdapterState): void {
	pi.registerCommand("fast", {
		description: "Toggle Codex fast service tier",
		handler: async (_args, ctx) => {
			if (!isOpenAICodexContext(ctx)) {
				if (ctx.hasUI) {
					ctx.ui.notify("Fast mode is only available with the openai-codex provider", "warning");
				}
				return;
			}

			state.fastModeEnabled = !state.fastModeEnabled;
			setFastStatus(ctx, state.fastModeEnabled);
			if (ctx.hasUI) {
				ctx.ui.notify(`Fast mode ${state.fastModeEnabled ? "enabled" : "disabled"}`, "info");
			}
		},
	});
}

export function applyFastServiceTier(payload: unknown, enabled: boolean): unknown {
	if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return { ...payload, service_tier: FAST_MODE_SERVICE_TIER };
}

export function getCodexSkillPaths(cwd: string, home: string = homedir()): string[] {
	const skillPaths = [join(home, ".agents", "skills")];
	let currentDir = resolve(cwd);
	while (true) {
		skillPaths.push(join(currentDir, ".agents", "skills"));
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}
	return skillPaths.filter((path) => existsSync(path));
}

function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());

	registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });

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
		// models restores the user's existing Pi tool configuration. Strip adapter
		// tools in case a fresh session starts from persisted/mixed active tools.
		state.previousToolNames = stripAdapterTools(pi.getActiveTools());
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
	state.fastModeEnabled = false;
	setStatus(ctx, false);
	setFastStatus(ctx, false);
}

function setStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, enabled ? STATUS_TEXT : undefined);
}

function setFastStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(FAST_MODE_STATUS_KEY, enabled ? FAST_MODE_STATUS_TEXT : undefined);
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
	const restored = stripAdapterTools(previousTools);
	for (const toolName of activeTools) {
		if (!ADAPTER_TOOL_NAMES.includes(toolName) && !restored.includes(toolName)) {
			restored.push(toolName);
		}
	}
	return restored;
}

export function stripAdapterTools(toolNames: string[]): string[] {
	return toolNames.filter((toolName) => !ADAPTER_TOOL_NAMES.includes(toolName));
}

function hasAdapterTools(activeTools: string[]): boolean {
	return activeTools.some((toolName) => ADAPTER_TOOL_NAMES.includes(toolName));
}
