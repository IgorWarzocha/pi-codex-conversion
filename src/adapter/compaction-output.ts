const KEEP_MESSAGE_ROLES = new Set(["assistant", "user"]);
const KEEP_ITEM_TYPES = new Set(["compaction"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneStructuredValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}
	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			clone[key] = cloneStructuredValue(nested);
		}
		return clone;
	}
	throw new Error(`Unsupported structured compact output value: ${typeof value}`);
}

function cloneCompactedOutputItem(item: Record<string, unknown>): Record<string, unknown> | undefined {
	try {
		return cloneStructuredValue(item) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function shouldKeepCompactedOutputItem(item: unknown): item is Record<string, unknown> {
	if (!isRecord(item) || typeof item.type !== "string") return false;
	if (item.type === "message") {
		return typeof item.role === "string" && KEEP_MESSAGE_ROLES.has(item.role);
	}
	return KEEP_ITEM_TYPES.has(item.type);
}

export function sanitizeCompactedWindow(output: readonly unknown[]): Record<string, unknown>[] {
	const sanitized: Record<string, unknown>[] = [];
	for (const item of output) {
		if (!shouldKeepCompactedOutputItem(item)) continue;
		const cloned = cloneCompactedOutputItem(item);
		if (cloned) sanitized.push(cloned);
	}
	return sanitized;
}

function extractTextFromContent(content: unknown, contentTypes: readonly string[]): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const allowedTypes = new Set(contentTypes);
	const text = content
		.map((part) => isRecord(part) && allowedTypes.has(String(part.type)) && typeof part.text === "string" ? part.text : "")
		.join("")
		.trim();
	return text.length > 0 ? text : undefined;
}

export function extractCompactionSummaryText(compactedWindow: readonly unknown[]): string | undefined {
	for (const item of compactedWindow) {
		if (!isRecord(item) || item.type !== "compaction") continue;
		if (typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0) return item.encrypted_content.trim();
	}

	const messageItems = compactedWindow.filter((item) => isRecord(item) && item.type === "message");
	if (messageItems.length === 1) {
		const [item] = messageItems;
		if (isRecord(item) && item.role === "assistant") return extractTextFromContent(item.content, ["output_text"]);
		if (isRecord(item) && item.role === "user") return extractTextFromContent(item.content, ["input_text", "output_text"]);
	}

	const userMessages = messageItems.filter((item) => isRecord(item) && item.role === "user").length;
	const assistantMessages = messageItems.filter((item) => isRecord(item) && item.role === "assistant").length;
	if (messageItems.length > 0) {
		return `OpenAI native compaction completed. Compacted context contains ${messageItems.length} message${messageItems.length === 1 ? "" : "s"} (${userMessages} user, ${assistantMessages} assistant).`;
	}

	return undefined;
}
