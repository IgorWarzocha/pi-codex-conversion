export const STATUS_KEY = "codex-adapter";
export const STATUS_TEXT = "\u001b[38;2;0;76;255mCodex adapter\u001b[0m";

export function buildStatusText(options: { verbosity: string; webSearch: boolean; imageGeneration: boolean; fast: boolean }): string {
	const extras = [
		options.webSearch ? "web search" : undefined,
		options.imageGeneration ? "image gen" : undefined,
		options.fast ? "fast" : undefined,
	]
		.filter(Boolean)
		.join(" • ");
	const verbosity = options.verbosity === "medium" ? "mid" : options.verbosity === "high" ? "hi" : options.verbosity;
	return `${STATUS_TEXT} V: ${verbosity}${extras ? ` • ${extras}` : ""}`;
}

export const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];

export const CORE_ADAPTER_TOOL_NAMES = ["exec_command", "write_stdin", "apply_patch"];
export const IMAGE_GENERATION_TOOL_NAME = "image_generation";
export const VIEW_IMAGE_TOOL_NAME = "view_image";
export const WEB_SEARCH_TOOL_NAME = "web_search";
