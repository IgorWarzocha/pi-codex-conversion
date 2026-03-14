import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { executePatch } from "./apply-patch-core.ts";
import type { ExecutePatchResult } from "./apply-patch-types.ts";

const APPLY_PATCH_PARAMETERS = Type.Object({
	patch: Type.String({
		description: "Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.",
	}),
});

interface ApplyPatchParams {
	patch: string;
}

function parseApplyPatchParams(params: unknown): ApplyPatchParams {
	if (!params || typeof params !== "object" || !("patch" in params) || typeof params.patch !== "string") {
		throw new Error("apply_patch requires a string 'patch' parameter");
	}
	return { patch: params.patch };
}

function isExecutePatchResult(details: unknown): details is ExecutePatchResult {
	return typeof details === "object" && details !== null;
}

export type { ExecutePatchResult } from "./apply-patch-types.ts";

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Use `apply_patch` to edit files. Send the full patch in `patch`.",
		promptSnippet: "Edit files with a patch.",
		promptGuidelines: ["Prefer apply_patch for focused textual edits instead of rewriting whole files."],
		parameters: APPLY_PATCH_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("apply_patch aborted");
			}

			const typedParams = parseApplyPatchParams(params);
			const result = executePatch({ cwd: ctx.cwd, patchText: typedParams.patch });
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
		renderCall(_args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("muted", "patch")}`, 0, 0);
		},
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
			}

			const details = isExecutePatchResult(result.details) ? result.details : undefined;
			if (!details) {
				return new Text(theme.fg("success", "Patch applied"), 0, 0);
			}

			let text = theme.fg("success", "Patch applied");
			text += theme.fg(
				"dim",
				` (${details.changedFiles.length} changed, ${details.createdFiles.length} created, ${details.deletedFiles.length} deleted)`,
			);
			if (expanded) {
				for (const file of details.changedFiles) {
					text += `\n${theme.fg("dim", file)}`;
				}
				for (const move of details.movedFiles) {
					text += `\n${theme.fg("accent", move)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}
