import test from "node:test";
import assert from "node:assert/strict";
import { isNativeWebSearchEnabled, NATIVE_WEB_SEARCH_ENV_VAR } from "../src/adapter/native-web-search-config.ts";

test("isNativeWebSearchEnabled defaults to enabled", () => {
	assert.equal(isNativeWebSearchEnabled({}), true);
});

test("isNativeWebSearchEnabled accepts common disabled values", () => {
	for (const value of ["0", "false", "off", "no", " FALSE "]) {
		assert.equal(isNativeWebSearchEnabled({ [NATIVE_WEB_SEARCH_ENV_VAR]: value }), false);
	}
});

test("isNativeWebSearchEnabled treats other values as enabled", () => {
	assert.equal(isNativeWebSearchEnabled({ [NATIVE_WEB_SEARCH_ENV_VAR]: "1" }), true);
	assert.equal(isNativeWebSearchEnabled({ [NATIVE_WEB_SEARCH_ENV_VAR]: "true" }), true);
});
