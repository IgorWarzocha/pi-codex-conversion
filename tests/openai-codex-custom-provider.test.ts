import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	buildGeneratedImageDisplayText,
	buildWebSearchActivityMessage,
	buildWebSearchSummaryText,
	getOpenAICodexLatestImagePath,
	getOpenAICodexImagePath,
	saveOpenAICodexGeneratedImage,
} from "../src/providers/openai-codex-custom-provider.ts";

test("getOpenAICodexImagePath saves images under the repo-local .pi/openai-codex-images directory", () => {
	const filePath = getOpenAICodexImagePath("/repo", "resp_123", "ig_456", "png");
	assert.equal(filePath, path.join("/repo", ".pi", "openai-codex-images", "ig_456-resp_123.png"));
});

test("getOpenAICodexImagePath shortens long codex ids for friendlier filenames", () => {
	const filePath = getOpenAICodexImagePath(
		"/repo",
		"resp_05d6d2731de96e7d0169e6d4bb06d88191adb685d17c2e4e9b",
		"ig_05d6d2731de96e7d0169e6d4bc910081918539a5b24943cd3c",
		"png",
	);
	assert.equal(filePath, path.join("/repo", ".pi", "openai-codex-images", "ig_05d6d273-cd3c-resp_05d6d273-4e9b.png"));
});
test("buildGeneratedImageDisplayText surfaces the prompt and saved filename to the user", () => {
	assert.equal(
		buildGeneratedImageDisplayText({
			absolutePath: "/repo/.pi/openai-codex-images/ig_456-resp_123.png",
			relativePath: ".pi/openai-codex-images/ig_456-resp_123.png",
			latestAbsolutePath: "/repo/.pi/openai-codex-images/latest.png",
			latestRelativePath: ".pi/openai-codex-images/latest.png",
			responseId: "resp_123",
			callId: "ig_456",
			outputFormat: "png",
			revisedPrompt: "A tiny red square icon",
		}),
		"File: .pi/openai-codex-images/ig_456-resp_123.png",
	);
	assert.equal(
		buildGeneratedImageDisplayText(
			{
				absolutePath: "/repo/.pi/openai-codex-images/ig_456-resp_123.png",
				relativePath: ".pi/openai-codex-images/ig_456-resp_123.png",
				latestAbsolutePath: "/repo/.pi/openai-codex-images/latest.png",
				latestRelativePath: ".pi/openai-codex-images/latest.png",
				responseId: "resp_123",
				callId: "ig_456",
				outputFormat: "png",
				revisedPrompt: "A tiny red square icon",
			},
			{ expanded: true },
		),
		"Prompt: A tiny red square icon\nFile: .pi/openai-codex-images/ig_456-resp_123.png",
	);
});

test("buildWebSearchActivityMessage surfaces the executed query and best sources", () => {
	assert.equal(
		buildWebSearchActivityMessage([
			{
				callId: "ws_123",
				status: "completed",
				query: "latest SpaceX launch",
				queries: ["latest SpaceX launch"],
				sources: [
					{ title: "SpaceX launches two Starlink satellite groups 19 hours apart", url: "https://www.space.com/example" },
					{ url: "https://example.com/fallback" },
				],
			},
		]),
		[
			"Web search results",
			"Queries:",
			"- latest SpaceX launch",
			"Sources:",
			"- SpaceX launches two Starlink satellite groups 19 hours apart — https://www.space.com/example",
			"- https://example.com/fallback",
		].join("\n"),
	);
});

test("buildWebSearchSummaryText collapses merged searches into one summary line", () => {
	assert.equal(buildWebSearchSummaryText([]), "Searched the web 0 times");
	assert.equal(
		buildWebSearchSummaryText([
			{ callId: "ws_123", queries: ["latest SpaceX launch"], sources: [] },
		]),
		"Searched the web once",
	);
	assert.equal(
		buildWebSearchSummaryText([
			{ callId: "ws_123", queries: ["a"], sources: [] },
			{ callId: "ws_456", queries: ["b"], sources: [] },
			{ callId: "ws_789", queries: ["c"], sources: [] },
		]),
		"Searched the web 3 times",
	);
});

test("saveOpenAICodexGeneratedImage writes the decoded image bytes into the workspace-local cache", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-codex-image-test-"));
	const encoded = Buffer.from("png-bytes").toString("base64");

	try {
		const saved = await saveOpenAICodexGeneratedImage(cwd, {
			responseId: "resp_123",
			callId: "ig_456",
			result: encoded,
			outputFormat: "png",
		});

		assert.equal(saved.relativePath, path.join(".pi", "openai-codex-images", "ig_456-resp_123.png"));
		assert.equal(saved.latestRelativePath, path.join(".pi", "openai-codex-images", "latest.png"));
		assert.deepEqual(await fs.readFile(saved.absolutePath), Buffer.from("png-bytes"));
		assert.deepEqual(await fs.readFile(getOpenAICodexLatestImagePath(cwd)), Buffer.from("png-bytes"));
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
