import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, SettingsList, Spacer, Text, type SettingItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getCodexRuntimeShell } from "./adapter/runtime-shell.ts";
import {
	CORE_ADAPTER_TOOL_NAMES,
	DEFAULT_TOOL_NAMES,
	IMAGE_GENERATION_TOOL_NAME,
	STATUS_KEY,
	buildStatusText,
	VIEW_IMAGE_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
} from "./adapter/tool-set.ts";
import {
	applyCodexRequestParams,
	DEFAULT_CODEX_CONVERSION_CONFIG,
	normalizeCodexVerbosity,
	readCodexConversionConfig,
	writeCodexConversionConfig,
	type CodexConversionConfig,
} from "./adapter/config.ts";
import { clearApplyPatchRenderState, registerApplyPatchTool } from "./tools/apply-patch-tool.ts";
import { isCodexLikeContext, isOpenAICodexContext, isResponsesContext } from "./adapter/codex-model.ts";
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
	previousToolNames?: string[];
	promptSkills: PromptSkill[];
	config: CodexConversionConfig;
}

const ADAPTER_TOOL_NAMES = [...CORE_ADAPTER_TOOL_NAMES, WEB_SEARCH_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME, VIEW_IMAGE_TOOL_NAME];
const GITHUB_URL = "https://github.com/IgorWarzocha/pi-codex-conversion";
const CHANGELOG_URL = `${GITHUB_URL}/blob/master/CHANGELOG.md`;
const DISCORD_URL = "https://discord.com/channels/1456806362351669492/1482388023994748948";
const ISSUE_URL = `${GITHUB_URL}/issues/new`;

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

	registerOpenAICodexCustomProvider(pi, {
		getCurrentCwd: () => state.cwd,
	});
	registerApplyPatchTool(pi);
	registerExecCommandTool(pi, tracker, sessions);
	registerWriteStdinTool(pi, sessions);
	registerImageGenerationTool(pi);
	registerWebSearchTool(pi);
	registerCodexCommand(pi, state);

	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.on("session_start", async (_event, ctx) => {
		state.cwd = ctx.cwd;
		state.config = readCodexConversionConfig();
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
		if (!isOpenAICodexContext(ctx) && !isResponsesContext(ctx)) {
			return undefined;
		}
		const isOpenAICodex = isOpenAICodexContext(ctx);
		const webSearchPayload = isOpenAICodex && state.config.webSearch ? rewriteNativeWebSearchTool(event.payload, ctx.model) : event.payload;
		const imageGenerationPayload = isOpenAICodex && state.config.imageGeneration
			? rewriteNativeImageGenerationTool(webSearchPayload, ctx.model)
			: webSearchPayload;
		return applyCodexRequestParams(imageGenerationPayload, state.config, {
			serviceTier: isOpenAICodex,
			verbosity: true,
		});
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

function registerCodexCommand(pi: ExtensionAPI, state: AdapterState): void {
	function saveAndApply(ctx: ExtensionContext, nextConfig: CodexConversionConfig): void {
		state.config = nextConfig;
		writeCodexConversionConfig(nextConfig);
		syncAdapter(pi, ctx, state);
	}

	pi.registerCommand("codex", {
		description: "Configure Codex adapter settings",
		getArgumentCompletions: (prefix) =>
			["all", "fast", "search", "image", "low", "medium", "high"]
				.filter((item) => item.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ label: value, value })),
		handler: async (args, ctx) => {
			state.config = readCodexConversionConfig();
			const arg = args.trim().toLowerCase();

			if (arg === "fast") {
				const nextConfig = { ...state.config, fast: !state.config.fast };
				saveAndApply(ctx, nextConfig);
				ctx.ui.notify(`Codex fast mode ${nextConfig.fast ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (arg === "all") {
				const nextConfig = { ...state.config, useOnAllModels: !state.config.useOnAllModels };
				saveAndApply(ctx, nextConfig);
				ctx.ui.notify(`Codex adapter on all models ${nextConfig.useOnAllModels ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (arg === "search") {
				const nextConfig = { ...state.config, webSearch: !state.config.webSearch };
				saveAndApply(ctx, nextConfig);
				ctx.ui.notify(`Codex web search ${nextConfig.webSearch ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (arg === "image") {
				const nextConfig = { ...state.config, imageGeneration: !state.config.imageGeneration };
				saveAndApply(ctx, nextConfig);
				ctx.ui.notify(`Codex image generation ${nextConfig.imageGeneration ? "enabled" : "disabled"}`, "info");
				return;
			}

			const verbosity = normalizeCodexVerbosity(arg);
			if (verbosity) {
				const nextConfig = { ...state.config, verbosity };
				saveAndApply(ctx, nextConfig);
				ctx.ui.notify(`Codex verbosity set to ${verbosity}`, "info");
				return;
			}

			if (arg) {
				ctx.ui.notify("Usage: /codex, /codex all, /codex fast, /codex search, /codex image, /codex low|medium|high", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Codex settings: all models ${state.config.useOnAllModels ? "on" : "off"}, fast ${state.config.fast ? "on" : "off"}, web search ${state.config.webSearch ? "on" : "off"}, image generation ${state.config.imageGeneration ? "on" : "off"}, verbosity ${state.config.verbosity}`, "info");
				return;
			}

			let draft = { ...state.config };
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const buildItems = (): SettingItem[] => [
					{ id: "useOnAllModels", label: "Use on all models", currentValue: draft.useOnAllModels ? "on" : "off", values: ["off", "on"] },
					{ id: "fast", label: "Fast mode", currentValue: draft.fast ? "on" : "off", values: ["off", "on"] },
					{ id: "webSearch", label: "Web search", currentValue: draft.webSearch ? "on" : "off", values: ["off", "on"] },
					{ id: "imageGeneration", label: "Image generation", currentValue: draft.imageGeneration ? "on" : "off", values: ["off", "on"] },
					{ id: "verbosity", label: "Verbosity", currentValue: draft.verbosity, values: ["low", "medium", "high"] },
				];

				const container = new Container();
				const panel = new Box(1, 0);
				panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				let settingsList: SettingsList;
				settingsList = new SettingsList(buildItems(), 6, getSettingsListTheme(), (id, value) => {
					if (id === "useOnAllModels") draft.useOnAllModels = value === "on";
					if (id === "fast") draft.fast = value === "on";
					if (id === "webSearch") draft.webSearch = value === "on";
					if (id === "imageGeneration") draft.imageGeneration = value === "on";
					if (id === "verbosity") draft.verbosity = normalizeCodexVerbosity(value) ?? DEFAULT_CODEX_CONVERSION_CONFIG.verbosity;
					saveAndApply(ctx, draft);
					tui.requestRender();
				}, () => done(undefined));
				panel.addChild(settingsList);
				panel.addChild(new DynamicBorder((text) => theme.fg("dim", text)));
				panel.addChild(
					new Text(
						[
							`${theme.bold("g")} github  ${theme.fg("dim", GITHUB_URL)}`,
							`${theme.bold("c")} changes ${theme.fg("dim", CHANGELOG_URL)}`,
							`${theme.bold("d")} discord ${theme.fg("dim", DISCORD_URL)}`,
							`${theme.bold("i")} issue   ${theme.fg("dim", ISSUE_URL)}`,
						].join("\n"),
						0,
						0,
					),
				);
				panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				container.addChild(new Spacer(1));
				container.addChild(panel);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (data === "g") {
							openExternalUrl(GITHUB_URL);
							ctx.ui.notify("Opened GitHub", "info");
							return;
						}
						if (data === "d") {
							openExternalUrl(DISCORD_URL);
							ctx.ui.notify("Opened Discord", "info");
							return;
						}
						if (data === "c") {
							openExternalUrl(CHANGELOG_URL);
							ctx.ui.notify("Opened changelog", "info");
							return;
						}
						if (data === "i") {
							openExternalUrl(ISSUE_URL);
							ctx.ui.notify("Opened issue form", "info");
							return;
						}
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}

function openExternalUrl(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
}

function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	state.promptSkills = extractPiPromptSkills(ctx.getSystemPrompt());

	registerViewImageTool(pi, { allowOriginalDetail: supportsOriginalImageDetail(ctx.model) });

	if (shouldUseCodexAdapter(ctx, state.config)) {
		enableAdapter(pi, ctx, state);
	} else {
		disableAdapter(pi, ctx, state);
	}
}

function enableAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): void {
	const toolNames = mergeAdapterTools(pi.getActiveTools(), getAdapterToolNames(ctx, state.config));
	if (!state.enabled) {
		// Preserve the previous active set once so switching away from Codex-like
		// models restores the user's existing Pi tool configuration. Strip adapter
		// tools in case a fresh session starts from persisted/mixed active tools.
		state.previousToolNames = stripAdapterTools(pi.getActiveTools());
		state.enabled = true;
	}
	pi.setActiveTools(toolNames);
	setStatus(ctx, true, state.config);
}

function shouldUseCodexAdapter(ctx: ExtensionContext, config: CodexConversionConfig): boolean {
	return config.useOnAllModels || isCodexLikeContext(ctx);
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
	setStatus(ctx, false, state.config);
}

function setStatus(ctx: ExtensionContext, enabled: boolean, config: CodexConversionConfig): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		STATUS_KEY,
		enabled
			? buildStatusText(
					isOpenAICodexContext(ctx)
						? config
						: isResponsesContext(ctx)
							? { useOnAllModels: config.useOnAllModels, fast: false, webSearch: false, imageGeneration: false, verbosity: config.verbosity }
							: { useOnAllModels: config.useOnAllModels, fast: false, webSearch: false, imageGeneration: false },
				)
			: undefined,
	);
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
