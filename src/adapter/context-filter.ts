import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import { IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, WEB_SEARCH_ACTIVITY_MESSAGE_TYPE } from "../providers/openai-codex-custom-provider.ts";
import { WEB_SEARCH_SESSION_NOTE_TYPE } from "../tools/web-search-tool.ts";
import { NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE } from "./types.ts";

const ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES = new Set([
	WEB_SEARCH_SESSION_NOTE_TYPE,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
]);

export function isAdapterContextExcludedCustomMessage(message: Pick<AgentMessage, "role"> & { customType?: string }): boolean {
	return message.role === "custom" && typeof message.customType === "string" && ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES.has(message.customType);
}

export function isAdapterContextExcludedCustomMessageEntry(entry: CustomMessageEntry): boolean {
	return ADAPTER_CONTEXT_EXCLUDED_CUSTOM_MESSAGE_TYPES.has(entry.customType);
}
