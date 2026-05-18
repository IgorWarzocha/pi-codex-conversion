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

export function extractCompactionSummaryText(compactedWindow: readonly unknown[]): string | undefined {
	for (const item of compactedWindow) {
		if (!isRecord(item) || item.type !== "compaction") continue;
		if (typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0) return item.encrypted_content.trim();
	}
	return undefined;
}

export function hasCompactionOutputItem(compactedWindow: readonly unknown[]): boolean {
	return compactedWindow.some((item) => isRecord(item) && item.type === "compaction");
}
