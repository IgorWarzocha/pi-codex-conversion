const DISABLED_NATIVE_WEB_SEARCH_VALUES = new Set(["0", "false", "off", "no"]);

export const NATIVE_WEB_SEARCH_ENV_VAR = "PI_CODEX_CONVERSION_NATIVE_WEB_SEARCH";

export function isNativeWebSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[NATIVE_WEB_SEARCH_ENV_VAR];
	if (value === undefined) {
		return true;
	}
	return !DISABLED_NATIVE_WEB_SEARCH_VALUES.has(value.trim().toLowerCase());
}
