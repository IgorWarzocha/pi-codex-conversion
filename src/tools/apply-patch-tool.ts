import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { executePatch } from "../patch/core.ts";
import type { ExecutePatchResult } from "../patch/types.ts";
import { formatApplyPatchSummary, renderApplyPatchCall } from "./apply-patch-rendering.ts";

const APPLY_PATCH_PARAMETERS = Type.Object({
	input: Type.String({
		description: "Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.",
	}),
});

interface ApplyPatchRenderState {
	cwd: string;
	collapsed: string;
	expanded: string;
}

const applyPatchRenderStates = new Map<string, ApplyPatchRenderState>();

interface ApplyPatchRenderContextLike {
	toolCallId?: string;
	cwd?: string;
	expanded?: boolean;
	argsComplete?: boolean;
}

function parseApplyPatchParams(params: unknown): { patchText: string } {
	if (!params || typeof params !== "object" || !("input" in params) || typeof params.input !== "string") {
		throw new Error("apply_patch requires a string 'input' parameter");
	}
	return { patchText: params.input };
}

function isExecutePatchResult(details: unknown): details is ExecutePatchResult {
	return typeof details === "object" && details !== null;
}

export type { ExecutePatchResult } from "../patch/types.ts";

export function clearApplyPatchRenderState(): void {
	applyPatchRenderStates.clear();
}

const renderApplyPatchCallWithOptionalContext: any = (
	args: { input?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context?: ApplyPatchRenderContextLike,
) => {
	if (context?.argsComplete === false) {
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	}
	const patchText = typeof args.input === "string" ? args.input : "";
	if (patchText.trim().length === 0) {
		return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
	}
	const cached = context?.toolCallId ? applyPatchRenderStates.get(context.toolCallId) : undefined;
	const cwd = context?.cwd ?? cached?.cwd;
	const text = context?.expanded ? cached?.expanded ?? renderApplyPatchCall(patchText, cwd) : cached?.collapsed ?? formatApplyPatchSummary(patchText, cwd);
	return new Text(text, 0, 0);
};

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Use `apply_patch` to edit files. Send the full patch in `input`.",
		promptSnippet: "Edit files with a patch.",
		promptGuidelines: ["Prefer apply_patch for focused textual edits instead of rewriting whole files."],
		parameters: APPLY_PATCH_PARAMETERS,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("apply_patch aborted");
			}

			const typedParams = parseApplyPatchParams(params);
			applyPatchRenderStates.set(toolCallId, {
				cwd: ctx.cwd,
				collapsed: formatApplyPatchSummary(typedParams.patchText, ctx.cwd),
				expanded: renderApplyPatchCall(typedParams.patchText, ctx.cwd),
			});
			const result = executePatch({ cwd: ctx.cwd, patchText: typedParams.patchText });
			const summary = [
				"Applied patch successfully.",
				`Changed files: ${result.changedFiles.length}`,
				`Created files: ${result.createdFiles.length}`,
				`Deleted files: ${result.deletedFiles.length}`,
				`Moved files: ${result.movedFiles.length}`,
				`Fuzz: ${result.fuzz}`,
			].join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: result,
			};
		},
		renderCall: renderApplyPatchCallWithOptionalContext,
		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
			}

			if (!isExecutePatchResult(result.details)) {
				return new Container();
			}

			return new Container();
		},
	});
}
