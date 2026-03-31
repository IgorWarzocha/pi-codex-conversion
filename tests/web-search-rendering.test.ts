import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool } from "../src/tools/web-search-tool.ts";

function createTheme() {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function renderComponentText(component: { render(width: number): string[] } | undefined): string {
	assert.ok(component);
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

test("createWebSearchTool renderResult returns an empty component when collapsed", () => {
	const tool = createWebSearchTool();
	const theme = createTheme();
	const rendered = renderComponentText(
		tool.renderResult?.(
			{ content: [{ type: "text", text: "ignored" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme as never,
		),
	);

	assert.equal(rendered, "");
});
