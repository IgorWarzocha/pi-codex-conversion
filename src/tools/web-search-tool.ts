import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Container, Text } from "@mariozechner/pi-tui";
import { isOpenAICodexModel } from "../adapter/codex-model.ts";

export const WEB_SEARCH_UNSUPPORTED_MESSAGE = "web_search is only available with the openai-codex provider";
const WEB_SEARCH_LOCAL_EXECUTION_MESSAGE =
	"web_search is a native openai-codex provider tool and should not execute locally";
export const WEB_SEARCH_SESSION_NOTE_TYPE = "codex-web-search-session-note";
export const WEB_SEARCH_SESSION_NOTE_TEXT =
	"Native OpenAI Codex web search is enabled for this session. Search activity is surfaced as merged foldable status messages instead of native tool-call rows.";
const WEB_SEARCH_MULTIMODAL_CONTENT_TYPES = ["text", "image"] as const;

const WEB_SEARCH_PARAMETERS = Type.Unsafe<Record<string, never>>({
	type: "object",
	additionalProperties: false,
});

interface FunctionToolPayload {
	type?: unknown;
	name?: unknown;
}

interface ResponsesPayload {
	tools?: unknown[];
	[key: string]: unknown;
}

interface ResponsesWebSearchTool {
	type: "web_search";
	external_web_access: true;
	search_content_types?: string[];
}

export function supportsNativeWebSearch(model: ExtensionContext["model"]): boolean {
	return isOpenAICodexModel(model);
}

export function shouldShowWebSearchSessionNote(
	model: ExtensionContext["model"],
	hasUI: boolean,
	alreadyShown: boolean,
): boolean {
	return hasUI && !alreadyShown && supportsNativeWebSearch(model);
}

export function supportsMultimodalNativeWebSearch(model: ExtensionContext["model"]): boolean {
	if (!supportsNativeWebSearch(model)) {
		return false;
	}
	const id = (model?.id ?? "").toLowerCase();
	return !id.includes("spark");
}

function isWebSearchFunctionTool(tool: unknown): tool is FunctionToolPayload {
	return !!tool && typeof tool === "object" && (tool as FunctionToolPayload).type === "function" && (tool as FunctionToolPayload).name === "web_search";
}

function createEmptyResultComponent(): Container {
	return new Container();
}

export function rewriteNativeWebSearchTool(payload: unknown, model: ExtensionContext["model"]): unknown {
	if (!supportsNativeWebSearch(model) || !payload || typeof payload !== "object") {
		return payload;
	}

	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) {
		return payload;
	}

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isWebSearchFunctionTool(tool)) {
			return tool;
		}
		rewritten = true;
		// Match Codex's native tool shape rather than exposing a synthetic function tool.
		const nativeTool: ResponsesWebSearchTool = {
			type: "web_search",
			external_web_access: true,
		};
		if (supportsMultimodalNativeWebSearch(model)) {
			nativeTool.search_content_types = [...WEB_SEARCH_MULTIMODAL_CONTENT_TYPES];
		}
		return nativeTool;
	});

	if (!rewritten) {
		return payload;
	}

	return {
		...(payload as ResponsesPayload),
		tools: nextTools,
	};
}

export function createWebSearchTool(): ToolDefinition<typeof WEB_SEARCH_PARAMETERS> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		promptSnippet:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		parameters: WEB_SEARCH_PARAMETERS,
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeWebSearch(ctx.model)) {
				throw new Error(WEB_SEARCH_UNSUPPORTED_MESSAGE);
			}
			throw new Error(WEB_SEARCH_LOCAL_EXECUTION_MESSAGE);
		},
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("web_search"))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				return createEmptyResultComponent();
			}
			const textBlock = result.content.find((item) => item.type === "text");
			const text = textBlock?.type === "text" ? textBlock.text : "(no output)";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	};
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
	pi.registerTool(createWebSearchTool());
}

export function registerWebSearchSessionNoteRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(WEB_SEARCH_SESSION_NOTE_TYPE, (_message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(new Text(theme.bold("Web search enabled"), 0, 0));
		box.addChild(new Text(`\n${theme.fg("dim", WEB_SEARCH_SESSION_NOTE_TEXT)}`, 0, 0));
		return box;
	});
}
