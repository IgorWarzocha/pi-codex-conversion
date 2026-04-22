import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Image, Spacer, Text } from "@mariozechner/pi-tui";
import {
	calculateCost,
	createAssistantMessageEventStream,
	getEnvApiKey,
	supportsXhigh,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "./openai-responses-shared.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
export const IMAGE_SAVE_CONTEXT_MESSAGE_TYPE = "codex-image-generation-context";
export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";
const OPENAI_CODEX_IMAGE_DIR = path.join(".pi", "openai-codex-images");
const OPENAI_CODEX_LATEST_IMAGE_NAME = "latest.png";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);

interface SavedGeneratedImage {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId: string | undefined;
	callId: string;
	outputFormat: string;
	revisedPrompt?: string;
}

interface ImageDisplayMessageDetails {
	savedImages: SavedGeneratedImage[];
}

interface PendingImageDisplay {
	savedImage: SavedGeneratedImage;
	imageData: { data: string; mimeType: string };
}

interface SurfacedWebSearch {
	callId: string;
	status?: string;
	query?: string;
	queries: string[];
	sources: Array<{ title?: string; url: string }>;
}

interface CachedImagePreview {
	data: string;
	mimeType: string;
}

interface ResponsesBody {
	model: string;
	store: boolean;
	stream: boolean;
	instructions?: string;
	input: unknown;
	text: { verbosity: string };
	include: string[];
	prompt_cache_key?: string;
	tool_choice: "auto";
	parallel_tool_calls: boolean;
	temperature?: number;
	service_tier?: string;
	tools?: unknown[];
	reasoning?: {
		effort: string;
		summary: string;
	};
	[key: string]: unknown;
}

interface ResponseEnvelope {
	id?: string;
	status?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
	};
	service_tier?: string;
	error?: { message?: string };
	[key: string]: unknown;
}

type ServiceTier = ResponseCreateParamsStreaming["service_tier"];

interface StreamEventShape {
	type?: string;
	response?: ResponseEnvelope;
	item?: {
		id?: string;
		type?: string;
		result?: string | null;
		output_format?: string;
		revised_prompt?: string;
		status?: string;
		[key: string]: unknown;
	};
	code?: string;
	message?: string;
	[key: string]: unknown;
}

function sanitizeFilePart(value: string | undefined, fallback: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return fallback;
	return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shortenFilePart(value: string | undefined, fallback: string): string {
	const safe = sanitizeFilePart(value, fallback);
	const match = /^([a-zA-Z]+_)(.+)$/.exec(safe);
	const prefix = match?.[1] ?? "";
	const body = match?.[2] ?? safe;
	if (body.length <= 12) return `${prefix}${body}`;
	return `${prefix}${body.slice(0, 8)}-${body.slice(-4)}`;
}

export function getOpenAICodexImageDirectory(cwd: string): string {
	return path.join(cwd, OPENAI_CODEX_IMAGE_DIR);
}

export function getOpenAICodexImagePath(cwd: string, _responseId: string | undefined, callId: string, outputFormat?: string): string {
	const ext = (outputFormat ?? "png").toLowerCase();
	const safeCallId = shortenFilePart(callId, "image");
	return path.join(getOpenAICodexImageDirectory(cwd), `${safeCallId}.${ext}`);
}

export function getOpenAICodexLatestImagePath(cwd: string): string {
	return path.join(getOpenAICodexImageDirectory(cwd), OPENAI_CODEX_LATEST_IMAGE_NAME);
}

export function buildGeneratedImageContextMessage(savedImages: SavedGeneratedImage[]): string {
	if (savedImages.length === 1) {
		const image = savedImages[0];
		return `Native image_generation output saved to \`${image.relativePath}\`.`;
	}

	const lines = [
		"Native image_generation outputs saved to workspace-local files:",
		...savedImages.map((image) => `- \`${image.relativePath}\``),
	];
	return lines.join("\n");
}

export function buildGeneratedImageDisplayText(savedImage: SavedGeneratedImage, options?: { expanded?: boolean }): string {
	const lines: string[] = [];
	if (options?.expanded && savedImage.revisedPrompt) {
		lines.push(`Prompt: ${savedImage.revisedPrompt}`);
	}
	lines.push(`File: ${savedImage.relativePath}`);
	return lines.join("\n");
}

export async function saveOpenAICodexGeneratedImage(
	cwd: string,
	image: { responseId?: string; callId: string; result: string; outputFormat?: string; revisedPrompt?: string },
): Promise<SavedGeneratedImage> {
	const bytes = Buffer.from(image.result, "base64");
	const absolutePath = getOpenAICodexImagePath(cwd, image.responseId, image.callId, image.outputFormat);
	const latestAbsolutePath = getOpenAICodexLatestImagePath(cwd);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, bytes);
	await fs.writeFile(latestAbsolutePath, bytes);

	const relative = path.relative(cwd, absolutePath);
	const latestRelative = path.relative(cwd, latestAbsolutePath);
	const relativePath = relative && !relative.startsWith("..") ? relative : absolutePath;
	const latestRelativePath = latestRelative && !latestRelative.startsWith("..") ? latestRelative : latestAbsolutePath;

	return {
		absolutePath,
		relativePath,
		latestAbsolutePath,
		latestRelativePath,
		responseId: image.responseId,
		callId: image.callId,
		outputFormat: (image.outputFormat ?? "png").toLowerCase(),
		revisedPrompt: image.revisedPrompt,
	};
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function resolveCodexUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

function buildSSEHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId: string | undefined,
): Headers {
	const headers = new Headers(modelHeaders);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		headers.set(key, value);
	}

	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	headers.set("User-Agent", `pi (${os.platform()} ${os.release()}; ${os.arch()})`);

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) && effort === "minimal") return "low";
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

function getServiceTierCostMultiplier(serviceTier: ServiceTier): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(usage: AssistantMessage["usage"], serviceTier: ServiceTier): void {
	const multiplier = getServiceTierCostMultiplier(serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(responseServiceTier: ServiceTier, requestServiceTier: ServiceTier): ServiceTier {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function createContextMessage(savedImages: SavedGeneratedImage[]): any {
	return {
		role: "custom",
		customType: IMAGE_SAVE_CONTEXT_MESSAGE_TYPE,
		content: buildGeneratedImageContextMessage(savedImages),
		display: false,
		details: { savedImages },
		timestamp: Date.now(),
	};
}

function buildRequestBody<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): ResponsesBody {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});

	const body: ResponsesBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: messages,
		text: { verbosity: ((options as { textVerbosity?: string } | undefined)?.textVerbosity ?? "medium") as string },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if ((options as { temperature?: number } | undefined)?.temperature !== undefined) {
		body.temperature = (options as { temperature?: number }).temperature;
	}

	const serviceTier = (options as { serviceTier?: string } | undefined)?.serviceTier;
	if (serviceTier !== undefined) {
		body.service_tier = serviceTier;
	}

	if (context.tools) {
		body.tools = convertResponsesTools(context.tools, { strict: null });
		const hasWebSearchTool = context.tools.some((tool) => tool.name === "web_search");
		if (hasWebSearchTool) {
			body.include.push("web_search_call.action.sources", "web_search_call.results");
		}
	}

	if (options?.reasoning !== undefined) {
		const requested = supportsXhigh(model) ? options.reasoning : options.reasoning === "xhigh" ? "high" : options.reasoning;
		body.reasoning = {
			effort: clampReasoningEffort(model.id, requested),
			summary: ((options as { reasoningSummary?: string } | undefined)?.reasoningSummary ?? "auto") as string,
		};
	}

	return body;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

async function* parseSSE(response: Response): AsyncIterable<StreamEventShape> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as StreamEventShape;
						} catch {
							// Ignore malformed SSE chunks and continue consuming the stream.
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignore cancellation errors
		}
		try {
			reader.releaseLock();
		} catch {
			// ignore lock release errors
		}
	}
}

async function* mapCodexEvents(events: AsyncIterable<StreamEventShape>): AsyncIterable<StreamEventShape> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
		}

		if (type === "response.failed") {
			throw new Error(event.response?.error?.message || "Codex response failed");
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = event.response;
			yield {
				...event,
				type: "response.completed",
				response: response ? { ...response, status: normalizeCodexStatus(response.status) } : response,
			};
			return;
		}

		yield event;
	}
}

function normalizeCodexStatus(status: string | undefined): string | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

function getLatestUserText(context: Context): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			const trimmed = message.content.trim();
			if (trimmed) return trimmed;
			continue;
		}
		const text = message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

async function* captureGeneratedImages(
	events: AsyncIterable<StreamEventShape>,
	options: {
		cwd: string;
		requestPrompt?: string;
		onImageSaved: (image: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
	},
): AsyncIterable<StreamEventShape> {
	let responseId: string | undefined;

	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}

		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const callId = typeof event.item.id === "string" ? event.item.id : undefined;
			const result = typeof event.item.result === "string" ? event.item.result : undefined;
			if (callId && result) {
				try {
					const outputFormat = typeof event.item.output_format === "string" ? event.item.output_format : undefined;
					const saved = await saveOpenAICodexGeneratedImage(options.cwd, {
						responseId,
						callId,
						result,
						outputFormat,
						revisedPrompt:
							typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : options.requestPrompt,
					});
					options.onImageSaved(saved, {
						data: result,
						mimeType: `image/${(outputFormat ?? "png").toLowerCase()}`,
					});
				} catch (error) {
					console.warn("[pi-codex-conversion] Failed to save generated image", error);
				}
			}
		}

		if (event.type === "response.output_item.done" && event.item?.type === "web_search_call") {
			const search = extractWebSearch(event.item);
			if (search) {
				options.onWebSearchCaptured?.(search);
			}
		}

		yield event;
	}
}

function extractWebSearch(item: StreamEventShape["item"]): SurfacedWebSearch | undefined {
	if (!item || item.type !== "web_search_call") return undefined;
	const callId = typeof item.id === "string" ? item.id : undefined;
	if (!callId) return undefined;

	const action = typeof item.action === "object" && item.action !== null ? (item.action as Record<string, unknown>) : undefined;
	const query = typeof action?.query === "string" ? action.query : undefined;
	const queries = Array.isArray(action?.queries) ? action.queries.filter((value): value is string => typeof value === "string") : [];
	const sourceUrls = Array.isArray(action?.sources)
		? action.sources
				.map((source) => (typeof source === "object" && source !== null ? (source as Record<string, unknown>) : undefined))
				.map((source) => (typeof source?.url === "string" ? source.url : undefined))
				.filter((url): url is string => typeof url === "string")
		: [];

	const results = Array.isArray(item.results)
		? item.results
				.map((result) => (typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined))
				.filter((result): result is Record<string, unknown> => !!result)
		: [];

	const titledSources: Array<{ title?: string; url: string }> = [];
	for (const result of results) {
		if (typeof result.url !== "string") continue;
		titledSources.push({
			title: typeof result.title === "string" ? result.title : undefined,
			url: result.url,
		});
	}

	const seenUrls = new Set<string>();
	const sources: Array<{ title?: string; url: string }> = [];
	for (const source of titledSources) {
		if (seenUrls.has(source.url)) continue;
		seenUrls.add(source.url);
		sources.push(source);
	}
	for (const url of sourceUrls) {
		if (seenUrls.has(url)) continue;
		seenUrls.add(url);
		sources.push({ url });
	}

	return {
		callId,
		status: typeof item.status === "string" ? item.status : undefined,
		query,
		queries,
		sources,
	};
}

export function buildWebSearchActivityMessage(searches: SurfacedWebSearch[]): string {
	const sections = searches.map((search, index) => {
		const heading = searches.length > 1 ? `Web search results ${index + 1}` : "Web search results";
		const lines = [heading];
		const queries = search.queries.length > 0 ? search.queries : search.query ? [search.query] : [];
		if (queries.length > 0) {
			lines.push("Queries:");
			for (const query of queries) {
				lines.push(`- ${query}`);
			}
		}
		if (search.sources.length > 0) {
			lines.push("Sources:");
			for (const source of search.sources.slice(0, 5)) {
				lines.push(`- ${source.title ? `${source.title} — ` : ""}${source.url}`);
			}
		}
		return lines.join("\n");
	});

	return sections.join("\n\n");
}

export function buildWebSearchSummaryText(searches: SurfacedWebSearch[]): string {
	return searches.length === 1 ? "Searched the web once" : `Searched the web ${searches.length} times`;
}

function loadCachedImagePreview(savedImage: SavedGeneratedImage, imagePreviewCache: Map<string, CachedImagePreview>): CachedImagePreview | undefined {
	const cached = imagePreviewCache.get(savedImage.absolutePath);
	if (cached) return cached;
	try {
		const preview = {
			data: readFileSync(savedImage.absolutePath).toString("base64"),
			mimeType: `image/${savedImage.outputFormat}`,
		};
		imagePreviewCache.set(savedImage.absolutePath, preview);
		return preview;
	} catch {
		return undefined;
	}
}

function createInitialAssistantMessage<TApi extends Api>(model: Model<TApi>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createErrorMessage(message: AssistantMessage, error: unknown, aborted: boolean): AssistantMessage {
	for (const block of message.content) {
		if (typeof block === "object" && block !== null && "partialJson" in block) {
			delete (block as { partialJson?: string }).partialJson;
		}
	}
	message.stopReason = aborted ? "aborted" : "error";
	message.errorMessage = error instanceof Error ? error.message : String(error);
	return message;
}

function finalizeUsage<TApi extends Api>(model: Model<TApi>, output: AssistantMessage): void {
	calculateCost(model, output.usage);
	output.usage.cost.total = output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
}

function createCodexStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: {
		getCurrentCwd: () => string;
		onImageSaved?: (savedImage: SavedGeneratedImage, imageData: { data: string; mimeType: string }) => void;
		onWebSearchCaptured?: (search: SurfacedWebSearch) => void;
	},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output = createInitialAssistantMessage(model);
		const requestPrompt = getLatestUserText(context);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as ResponsesBody;
			}

			const headers = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const bodyJson = JSON.stringify(body);

			let response: Response | undefined;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					response = await fetch(resolveCodexUrl(model.baseUrl), {
						method: "POST",
						headers,
						body: bodyJson,
						signal: options?.signal,
					});

					await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}

					throw new Error(errorText || `${response.status} ${response.statusText}`);
				} catch (error) {
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}

					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < MAX_RETRIES) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });

			const tappedEvents = captureGeneratedImages(mapCodexEvents(parseSSE(response)), {
				cwd: deps.getCurrentCwd(),
				requestPrompt,
				onImageSaved: (image, imageData) => deps.onImageSaved?.(image, imageData),
				onWebSearchCaptured: (search) => deps.onWebSearchCaptured?.(search),
			});

			await processResponsesStream(tappedEvents as AsyncIterable<never>, output, stream, model, {
				serviceTier: (options as { serviceTier?: ServiceTier } | undefined)?.serviceTier,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing,
			});
			finalizeUsage(model, output);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: (options?.signal?.aborted ? "aborted" : "error") as "aborted" | "error",
				error: createErrorMessage(output, error, !!options?.signal?.aborted),
			});
			stream.end();
		}
	})();

	return stream;
}

export function registerOpenAICodexCustomProvider(pi: ExtensionAPI, options: { getCurrentCwd: () => string }): void {
	const pendingImageDisplays: PendingImageDisplay[] = [];
	const pendingImageContextNotes: SavedGeneratedImage[] = [];
	const pendingWebSearches: SurfacedWebSearch[] = [];
	const imagePreviewCache = new Map<string, CachedImagePreview>();
	let pendingFlushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushPendingMessages = () => {
		pendingFlushTimer = undefined;

		const images = pendingImageDisplays.splice(0, pendingImageDisplays.length);
		const searches = pendingWebSearches.splice(0, pendingWebSearches.length);

		for (const { savedImage, imageData } of images) {
			imagePreviewCache.set(savedImage.absolutePath, imageData);
			pi.sendMessage(
				{
					customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
					content: [{ type: "text", text: buildGeneratedImageDisplayText(savedImage, { expanded: false }) }],
					display: true,
					details: { savedImages: [savedImage] } satisfies ImageDisplayMessageDetails,
				},
				{ triggerTurn: false },
			);
		}

		if (pendingImageContextNotes.length > 0) {
			const savedImages = pendingImageContextNotes.splice(0, pendingImageContextNotes.length);
			pi.sendMessage(
				{
					customType: IMAGE_SAVE_CONTEXT_MESSAGE_TYPE,
					content: buildGeneratedImageContextMessage(savedImages),
					display: false,
					details: { savedImages },
				},
				{ triggerTurn: false },
			);
		}

		if (searches.length > 0) {
			pi.sendMessage(
				{
					customType: WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
					content: buildWebSearchActivityMessage(searches),
					display: true,
					details: { searches },
				},
				{ triggerTurn: false },
			);
		}
	};

	const schedulePendingMessageFlush = () => {
		if (pendingFlushTimer || (pendingImageDisplays.length === 0 && pendingWebSearches.length === 0)) {
			return;
		}
		pendingFlushTimer = setTimeout(flushPendingMessages, 0);
	};

	const clearPendingMessages = () => {
		if (pendingFlushTimer) {
			clearTimeout(pendingFlushTimer);
			pendingFlushTimer = undefined;
		}
		pendingImageDisplays.length = 0;
		pendingImageContextNotes.length = 0;
		pendingWebSearches.length = 0;
		imagePreviewCache.clear();
	};

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: (model, context, streamOptions) =>
			createCodexStream(model, context, streamOptions, {
				getCurrentCwd: options.getCurrentCwd,
				onImageSaved: (savedImage, imageData) => {
					pendingImageDisplays.push({ savedImage, imageData });
					pendingImageContextNotes.push(savedImage);
				},
				onWebSearchCaptured: (search) => {
					pendingWebSearches.push(search);
				},
			}),
	});

	pi.on("session_start", async () => {
		clearPendingMessages();
	});

	pi.on("session_shutdown", async () => {
		if (pendingImageDisplays.length > 0 || pendingImageContextNotes.length > 0 || pendingWebSearches.length > 0) {
			flushPendingMessages();
		}
		clearPendingMessages();
	});

	pi.on("agent_end", async () => {
		schedulePendingMessageFlush();
	});

	pi.on("context", async (event) => {
		if (pendingImageContextNotes.length === 0) return undefined;
		return {
			messages: [...event.messages, createContextMessage(pendingImageContextNotes)],
		};
	});

	pi.registerMessageRenderer<ImageDisplayMessageDetails>(IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[image_generation]")), 0, 0));
		const savedImage = message.details?.savedImages?.[0];
		const textContent = savedImage
			? buildGeneratedImageDisplayText(savedImage, { expanded: options.expanded })
			: typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
		box.addChild(new Text(`\n${theme.fg("customMessageText", textContent)}`, 0, 0));
		if (savedImage) {
			const preview = loadCachedImagePreview(savedImage, imagePreviewCache);
			if (preview) {
				box.addChild(new Spacer(1));
				box.addChild(
					new Image(preview.data, preview.mimeType, { fallbackColor: (text) => theme.fg("customMessageText", text) }, { maxWidthCells: 60 }),
				);
			}
		}
		return box;
	});

	pi.registerMessageRenderer<{ searches?: SurfacedWebSearch[] }>(WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const searches = message.details?.searches ?? [];
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(buildWebSearchSummaryText(searches))), 0, 0));
		if (options.expanded) {
			const content = typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
			box.addChild(new Text(`\n${theme.fg("customMessageText", content)}`, 0, 0));
		}
		return box;
	});
}
