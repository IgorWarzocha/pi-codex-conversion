import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodexRuntimeShell } from "./adapter/runtime-shell.ts";
import { clearApplyPatchRenderState, registerApplyPatchTool } from "./tools/apply-patch-tool.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import {
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	registerOpenAICodexCustomProvider,
} from "./providers/openai-codex-custom-provider.ts";
import { registerImageGenerationTool } from "./tools/image-generation-tool.ts";
import { buildCodexSystemPrompt, extractPiPromptSkills, resolvePromptSkills } from "./prompt/build-system-prompt.ts";
import { registerViewImageTool, supportsOriginalImageDetail } from "./tools/view-image-tool.ts";
import { registerWebSearchTool, WEB_SEARCH_SESSION_NOTE_TYPE } from "./tools/web-search-tool.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import { ensureBundledApplyPatchOnPath } from "./tools/apply-patch-binary.ts";
import { readCodexConversionConfig } from "./adapter/config.ts";
import { syncAdapter, mergeAdapterTools, restoreTools, stripAdapterTools, shouldUseCodexAdapter } from "./adapter/activation.ts";
import { rewriteCodexProviderRequest } from "./adapter/provider-request.ts";
import { handleCodexSessionBeforeCompact } from "./adapter/compaction.ts";
import { getCodexSkillPaths } from "./adapter/skills.ts";
import type { AdapterState } from "./adapter/state.ts";
import { registerCodexCommand } from "./codex-settings/command.ts";

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
	const state: AdapterState = { enabled: false, cwd: process.cwd(), promptSkills: [], config: readCodexConversionConfig() };
	const sessions = createExecSessionManager();
	let nativeWebSearchRegistered = false;
	let nativeImageGenerationRegistered = false;

	function ensureOptionalNativeToolsRegistered(config = state.config): void {
		if (config.webSearch && !nativeWebSearchRegistered) {
			registerWebSearchTool(pi);
			nativeWebSearchRegistered = true;
		}
		if (config.imageGeneration && !nativeImageGenerationRegistered) {
			registerImageGenerationTool(pi);
			nativeImageGenerationRegistered = true;
		}
	}

	registerOpenAICodexCustomProvider(pi, {
		getCurrentCwd: () => state.cwd,
	});
	registerApplyPatchTool(pi);
	registerExecCommandTool(pi, tracker, sessions);
	registerWriteStdinTool(pi, sessions);
	ensureOptionalNativeToolsRegistered();
	registerCodexCommand(pi, state, ensureOptionalNativeToolsRegistered);

	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		state.config = readCodexConversionConfig();
		ensureOptionalNativeToolsRegistered();
		state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());
		registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });
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
		state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());
		registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });
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
		if (!shouldUseCodexAdapter(ctx, state.config)) {
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
		return rewriteCodexProviderRequest(event.payload, ctx, state);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		state.cwd = ctx.cwd;
		return handleCodexSessionBeforeCompact(event, ctx, state, pi);
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

export { getCodexSkillPaths, mergeAdapterTools, restoreTools, stripAdapterTools };
