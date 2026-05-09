import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import { ensureBundledApplyPatchOnPath, getBundledApplyPatchBinDir } from "../src/tools/apply-patch-binary.ts";

test("ensureBundledApplyPatchOnPath prepends package bin dir", () => {
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
	const binDir = ensureBundledApplyPatchOnPath(env);
	assert.equal(binDir, getBundledApplyPatchBinDir());
	assert.equal(env.PATH, `${binDir}${delimiter}/usr/bin`);
});

test("ensureBundledApplyPatchOnPath is idempotent", () => {
	const binDir = getBundledApplyPatchBinDir();
	const env: NodeJS.ProcessEnv = { PATH: `${binDir}${delimiter}/usr/bin` };
	ensureBundledApplyPatchOnPath(env);
	assert.equal(env.PATH, `${binDir}${delimiter}/usr/bin`);
});
