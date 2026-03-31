import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { executePatch } from "../patch/core.ts";
import { ExecutePatchError, type ExecutePatchResult } from "../patch/types.ts";
import { formatApplyPatchSummary, formatPatchTarget, renderApplyPatchCall } from "./apply-patch-rendering.ts";

const APPLY_PATCH_PARAMETERS = Type.Object({
	input: Type.String({
		description: "Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.",
	}),
});

interface ApplyPatchRenderState {
	cwd: string;
	patchText: string;
	collapsed: string;
	expanded: string;
	status: "pending" | "partial_failure";
	failedTarget?: string;
}

interface ApplyPatchSuccessDetails {
	status: "success";
	result: ExecutePatchResult;
}

interface ApplyPatchPartialFailureDetails {
	status: "partial_failure";
	result: ExecutePatchResult;
	error: string;
	failedTarget?: string;
}

type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;

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

function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails {
	return typeof details === "object" && details !== null && "status" in details && "result" in details;
}

function setApplyPatchRenderState(
	toolCallId: string,
	patchText: string,
	cwd: string,
	status: "pending" | "partial_failure" = "pending",
	failedTarget?: string,
): void {
	const collapsed = formatApplyPatchSummary(patchText, cwd);
	const expanded = renderApplyPatchCall(patchText, cwd);
	applyPatchRenderStates.set(toolCallId, {
		cwd,
		patchText,
		collapsed,
		expanded,
		status,
		failedTarget,
	});
}

function renderPartialFailureCall(
	text: string,
	theme: { fg(role: string, text: string): string },
	failedTarget?: string,
): string {
	const lines = text.split("\n");
	if (lines.length === 0) {
		return theme.fg("warning", "• Edit partially failed");
	}
	lines[0] = lines[0].replace(/^• (Added|Edited|Deleted)\b/, theme.fg("warning", "• Edit partially failed"));
	if (failedTarget) {
		for (let i = 0; i < lines.length; i += 1) {
			if (lines[i].includes(failedTarget)) {
				lines[i] = theme.fg("error", lines[i].replace(failedTarget, `${failedTarget} failed`));
			}
		}
	}
	return lines.join("\n");
}

function summarizePatchCounts(result: ExecutePatchResult): string {
	return [
		`changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`,
		`created ${result.createdFiles.length}`,
		`deleted ${result.deletedFiles.length}`,
		`moved ${result.movedFiles.length}`,
	].join(", ");
}

function describeFailedAction(error: ExecutePatchError, cwd: string): string | undefined {
	if (!error.failedAction) {
		return undefined;
	}
	return formatPatchTarget(error.failedAction.path, error.failedAction.type === "update" ? error.failedAction.movePath : undefined, cwd);
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
	const effectivePatchText = cached?.patchText ?? patchText;
	const baseText = context?.expanded
		? cached?.expanded ?? renderApplyPatchCall(effectivePatchText, cwd)
		: cached?.collapsed ?? formatApplyPatchSummary(effectivePatchText, cwd);
	const text = cached?.status === "partial_failure" ? renderPartialFailureCall(baseText, theme, cached.failedTarget) : baseText;
	return new Text(text, 0, 0);
};

export function registerApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Use `apply_patch` to edit files. Send the full patch in `input`.",
		promptSnippet: "Edit files with a patch.",
		promptGuidelines: [
			"Prefer apply_patch for focused textual edits instead of rewriting whole files.",
			"When one task needs coordinated edits across multiple files, send them in a single apply_patch call when one coherent patch will do.",
		],
		parameters: APPLY_PATCH_PARAMETERS,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("apply_patch aborted");
			}

			const typedParams = parseApplyPatchParams(params);
			setApplyPatchRenderState(toolCallId, typedParams.patchText, ctx.cwd);
			let result: ExecutePatchResult;
			try {
				result = executePatch({ cwd: ctx.cwd, patchText: typedParams.patchText });
			} catch (error) {
				if (error instanceof ExecutePatchError) {
					const partial = error.hasPartialSuccess();
					const failedTarget = describeFailedAction(error, ctx.cwd);
					const prefix = partial
						? `apply_patch partially failed after ${summarizePatchCounts(error.result)}`
						: "apply_patch failed";
					const message = failedTarget ? `${prefix} while patching ${failedTarget}: ${error.message}` : `${prefix}: ${error.message}`;
					if (partial) {
						setApplyPatchRenderState(toolCallId, typedParams.patchText, ctx.cwd, "partial_failure", failedTarget);
						return {
							content: [{ type: "text", text: message }],
							details: {
								status: "partial_failure",
								result: error.result,
								error: message,
								failedTarget,
							} satisfies ApplyPatchPartialFailureDetails,
						};
					}
					throw new Error(message);
				}
				throw error;
			}
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
				details: {
					status: "success",
					result,
				} satisfies ApplyPatchSuccessDetails,
			};
		},
		renderCall: renderApplyPatchCallWithOptionalContext,
		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(`${theme.fg("dim", "•")} ${theme.bold("Patching")}`, 0, 0);
			}

			if (!isApplyPatchToolDetails(result.details)) {
				return new Container();
			}

			if (result.details.status === "partial_failure") {
				return new Container();
			}

			return new Container();
		},
	});
}
