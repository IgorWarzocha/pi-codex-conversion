import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CodexVerbosity = "low" | "medium" | "high";

export interface CodexConversionConfig {
	fast: boolean;
	imageGeneration: boolean;
	useOnAllModels: boolean;
	webSearch: boolean;
	verbosity: CodexVerbosity;
}

export const CODEX_CONVERSION_CONFIG_BASENAME = "pi-codex-conversion.json";
export const DEFAULT_CODEX_CONVERSION_CONFIG: CodexConversionConfig = {
	fast: false,
	imageGeneration: true,
	useOnAllModels: false,
	webSearch: true,
	verbosity: "low",
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCodexVerbosity(value: unknown): CodexVerbosity | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : undefined;
}

export function getCodexConversionConfigPath(home: string = homedir()): string {
	return join(home, ".pi", "agent", CODEX_CONVERSION_CONFIG_BASENAME);
}

export function readCodexConversionConfig(configPath: string = getCodexConversionConfigPath()): CodexConversionConfig {
	if (!existsSync(configPath)) {
		writeCodexConversionConfig(DEFAULT_CODEX_CONVERSION_CONFIG, configPath);
		return { ...DEFAULT_CODEX_CONVERSION_CONFIG };
	}

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (!isObject(parsed)) return { ...DEFAULT_CODEX_CONVERSION_CONFIG };
		return {
			fast: typeof parsed.fast === "boolean" ? parsed.fast : DEFAULT_CODEX_CONVERSION_CONFIG.fast,
			imageGeneration: typeof parsed.imageGeneration === "boolean" ? parsed.imageGeneration : DEFAULT_CODEX_CONVERSION_CONFIG.imageGeneration,
			useOnAllModels: typeof parsed.useOnAllModels === "boolean" ? parsed.useOnAllModels : DEFAULT_CODEX_CONVERSION_CONFIG.useOnAllModels,
			webSearch: typeof parsed.webSearch === "boolean" ? parsed.webSearch : DEFAULT_CODEX_CONVERSION_CONFIG.webSearch,
			verbosity: normalizeCodexVerbosity(parsed.verbosity) ?? DEFAULT_CODEX_CONVERSION_CONFIG.verbosity,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-codex-conversion] Failed to read ${configPath}: ${message}`);
		return { ...DEFAULT_CODEX_CONVERSION_CONFIG };
	}
}

export function writeCodexConversionConfig(
	config: CodexConversionConfig,
	configPath: string = getCodexConversionConfigPath(),
): void {
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-codex-conversion] Failed to write ${configPath}: ${message}`);
	}
}

export function applyCodexRequestParams(
	payload: unknown,
	config: CodexConversionConfig,
	options: { serviceTier?: boolean; verbosity?: boolean } = { serviceTier: true, verbosity: true },
): unknown {
	if (!isObject(payload)) return payload;
	const text = isObject(payload.text) ? payload.text : {};
	return {
		...payload,
		...(options.serviceTier && config.fast ? { service_tier: "priority" } : {}),
		...(options.verbosity ? { text: { ...text, verbosity: config.verbosity } } : {}),
	};
}
