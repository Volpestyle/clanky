import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getOpenAiCredentialStatus, resolveOpenAiApiKey } from "../openai-credentials.ts";
import { isRecord } from "../util/values.ts";
import { getXAiCredentialStatus, resolveXAiApiKey } from "../xai-credentials.ts";

export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type XAiImageResolution = "1k" | "2k";
export type XAiVideoResolution = "480p" | "720p";
export type MediaAspectRatio =
	| "1:1"
	| "16:9"
	| "9:16"
	| "4:3"
	| "3:4"
	| "3:2"
	| "2:3"
	| "2:1"
	| "1:2"
	| "19.5:9"
	| "9:19.5"
	| "20:9"
	| "9:20"
	| "auto";

export interface OpenAiImageGenerateInput {
	prompt: string;
	model?: string;
	n?: number;
	size?: string;
	quality?: ImageQuality;
	background?: "auto" | "opaque" | "transparent";
	outputFormat?: ImageOutputFormat;
	output_format?: ImageOutputFormat;
	outputCompression?: number;
	output_compression?: number;
	moderation?: "auto" | "low";
	outputDir?: string;
	output_dir?: string;
	filenamePrefix?: string;
	filename_prefix?: string;
}

export interface XAiImageGenerateInput {
	prompt: string;
	model?: string;
	n?: number;
	aspectRatio?: MediaAspectRatio;
	aspect_ratio?: MediaAspectRatio;
	resolution?: XAiImageResolution;
	responseFormat?: "url" | "b64_json";
	response_format?: "url" | "b64_json";
	outputDir?: string;
	output_dir?: string;
	filenamePrefix?: string;
	filename_prefix?: string;
	download?: boolean;
}

export interface XAiVideoGenerateInput {
	prompt: string;
	model?: string;
	duration?: number;
	aspectRatio?: MediaAspectRatio;
	aspect_ratio?: MediaAspectRatio;
	resolution?: XAiVideoResolution;
	outputDir?: string;
	output_dir?: string;
	filenamePrefix?: string;
	filename_prefix?: string;
	download?: boolean;
	pollIntervalMs?: number;
	poll_interval_ms?: number;
	timeoutMs?: number;
	timeout_ms?: number;
}

export interface MediaOperatorOptions {
	authStorage?: AuthStorage;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

export interface GeneratedMediaFile {
	index: number;
	path?: string;
	url?: string;
	bytes?: number;
	revisedPrompt?: string;
}

export interface OpenAiImageGenerateResult {
	provider: "openai";
	model: string;
	files: GeneratedMediaFile[];
	usage?: unknown;
}

export interface XAiImageGenerateResult {
	provider: "xai";
	model: string;
	files: GeneratedMediaFile[];
}

export interface XAiVideoGenerateResult {
	provider: "xai";
	model: string;
	requestId: string;
	status: string;
	url?: string;
	path?: string;
	duration?: number;
	respectModeration?: boolean;
	error?: unknown;
}

const DEFAULT_MEDIA_OUTPUT_DIR = "/tmp/clanky-media";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image-quality";
const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
const XAI_BASE_URL = "https://api.x.ai/v1";

export async function generateOpenAiImage(
	input: OpenAiImageGenerateInput,
	options: MediaOperatorOptions = {},
): Promise<OpenAiImageGenerateResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiKey = await resolveOpenAiApiKey(env, options.authStorage);
	if (apiKey === undefined) {
		throw new Error(
			"OpenAI credentials are required for openai_image_generate. Run /openai-login or set OPENAI_API_KEY/CLANKY_OPENAI_API_KEY.",
		);
	}
	const prompt = input.prompt.trim();
	if (prompt.length === 0) throw new Error("openai_image_generate prompt must not be empty.");

	const model = input.model?.trim() || env.CLANKY_OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL;
	const outputFormat = input.outputFormat ?? input.output_format ?? "png";
	const requestBody: Record<string, unknown> = {
		model,
		prompt,
	};
	assignDefined(requestBody, "n", input.n);
	assignDefined(requestBody, "size", input.size);
	assignDefined(requestBody, "quality", input.quality);
	assignDefined(requestBody, "background", input.background);
	assignDefined(requestBody, "output_format", outputFormat);
	assignDefined(requestBody, "output_compression", input.outputCompression ?? input.output_compression);
	assignDefined(requestBody, "moderation", input.moderation);

	const payload = await postJson(
		fetchImpl,
		"https://api.openai.com/v1/images/generations",
		apiKey.value,
		requestBody,
		signalOption(options.signal),
	);
	const files = await saveImageGenerationData(payload, {
		fetchImpl,
		outputDir: resolveOutputDir(input.outputDir ?? input.output_dir),
		filenamePrefix: input.filenamePrefix ?? input.filename_prefix ?? "openai-image",
		extension: outputFormat === "jpeg" ? "jpg" : outputFormat,
		...signalOption(options.signal),
		downloadUrls: true,
	});
	return {
		provider: "openai",
		model,
		files,
		usage: isRecord(payload) ? payload.usage : undefined,
	};
}

export async function generateXAiImage(
	input: XAiImageGenerateInput,
	options: MediaOperatorOptions = {},
): Promise<XAiImageGenerateResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiKey = await resolveXAiApiKey(env, options.authStorage);
	if (apiKey === undefined) {
		throw new Error("xAI credentials are required for xai_image_generate. Run /xai-login or set XAI_API_KEY.");
	}
	const prompt = input.prompt.trim();
	if (prompt.length === 0) throw new Error("xai_image_generate prompt must not be empty.");

	const model = input.model?.trim() || env.CLANKY_XAI_IMAGE_MODEL || DEFAULT_XAI_IMAGE_MODEL;
	const responseFormat = input.responseFormat ?? input.response_format ?? "b64_json";
	const requestBody: Record<string, unknown> = {
		model,
		prompt,
		response_format: responseFormat,
	};
	assignDefined(requestBody, "n", input.n);
	assignDefined(requestBody, "aspect_ratio", input.aspectRatio ?? input.aspect_ratio);
	assignDefined(requestBody, "resolution", input.resolution);

	const payload = await postJson(
		fetchImpl,
		`${XAI_BASE_URL}/images/generations`,
		apiKey.value,
		requestBody,
		signalOption(options.signal),
	);
	const files = await saveImageGenerationData(payload, {
		fetchImpl,
		outputDir: resolveOutputDir(input.outputDir ?? input.output_dir),
		filenamePrefix: input.filenamePrefix ?? input.filename_prefix ?? "xai-image",
		extension: "jpg",
		...signalOption(options.signal),
		downloadUrls: input.download !== false,
	});
	return { provider: "xai", model, files };
}

export async function generateXAiVideo(
	input: XAiVideoGenerateInput,
	options: MediaOperatorOptions = {},
): Promise<XAiVideoGenerateResult> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiKey = await resolveXAiApiKey(env, options.authStorage);
	if (apiKey === undefined) {
		throw new Error("xAI credentials are required for xai_video_generate. Run /xai-login or set XAI_API_KEY.");
	}
	const prompt = input.prompt.trim();
	if (prompt.length === 0) throw new Error("xai_video_generate prompt must not be empty.");

	const model = input.model?.trim() || env.CLANKY_XAI_VIDEO_MODEL || DEFAULT_XAI_VIDEO_MODEL;
	const requestBody: Record<string, unknown> = {
		model,
		prompt,
	};
	assignDefined(requestBody, "duration", input.duration);
	assignDefined(requestBody, "aspect_ratio", input.aspectRatio ?? input.aspect_ratio);
	assignDefined(requestBody, "resolution", input.resolution);

	const started = await postJson(
		fetchImpl,
		`${XAI_BASE_URL}/videos/generations`,
		apiKey.value,
		requestBody,
		signalOption(options.signal),
	);
	const requestId = readRequiredString(started, "request_id");
	const timeoutMs = input.timeoutMs ?? input.timeout_ms ?? 10 * 60 * 1000;
	const pollIntervalMs = input.pollIntervalMs ?? input.poll_interval_ms ?? 5000;
	const deadline = Date.now() + Math.max(1, timeoutMs);

	while (true) {
		const statusPayload = await getJson(
			fetchImpl,
			`${XAI_BASE_URL}/videos/${encodeURIComponent(requestId)}`,
			apiKey.value,
			signalOption(options.signal),
		);
		const status =
			isRecord(statusPayload) && typeof statusPayload.status === "string" ? statusPayload.status : "unknown";
		if (status === "done") {
			return await buildXAiVideoResult(statusPayload, {
				fetchImpl,
				model,
				requestId,
				outputDir: resolveOutputDir(input.outputDir ?? input.output_dir),
				filenamePrefix: input.filenamePrefix ?? input.filename_prefix ?? "xai-video",
				download: input.download !== false,
				...signalOption(options.signal),
			});
		}
		if (status === "failed" || status === "expired") {
			return {
				provider: "xai",
				model,
				requestId,
				status,
				error: isRecord(statusPayload) ? statusPayload.error : undefined,
			};
		}
		if (Date.now() >= deadline) {
			throw new Error(`xai_video_generate timed out while waiting for request ${requestId}.`);
		}
		await sleep(Math.max(100, pollIntervalMs), undefined, signalOption(options.signal));
	}
}

export function getMediaBackendStatus(options: { authStorage?: AuthStorage; env?: NodeJS.ProcessEnv } = {}): unknown {
	const env = options.env ?? process.env;
	const openAiStatus = getOpenAiCredentialStatus(env, options.authStorage);
	const xaiStatus = getXAiCredentialStatus(env, options.authStorage);
	return {
		outputDir: DEFAULT_MEDIA_OUTPUT_DIR,
		openaiImages: {
			available: openAiStatus.available,
			model: env.CLANKY_OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL,
			apiKeySource: openAiStatus.activeSource,
			acceptedApiKeySources: ["CLANKY_OPENAI_API_KEY", "OPENAI_API_KEY", "stored openai AuthStorage credential"],
		},
		xaiImagineImages: {
			available: xaiStatus.available,
			model: env.CLANKY_XAI_IMAGE_MODEL || DEFAULT_XAI_IMAGE_MODEL,
			apiKeySource: xaiStatus.activeSource,
			acceptedApiKeySources: ["XAI_API_KEY", "stored xai AuthStorage credential"],
		},
		xaiImagineVideos: {
			available: xaiStatus.available,
			model: env.CLANKY_XAI_VIDEO_MODEL || DEFAULT_XAI_VIDEO_MODEL,
			apiKeySource: xaiStatus.activeSource,
			acceptedApiKeySources: ["XAI_API_KEY", "stored xai AuthStorage credential"],
		},
	};
}

async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	apiKey: string,
	body: Record<string, unknown>,
	options: { signal?: AbortSignal },
): Promise<unknown> {
	const init: RequestInit = {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	};
	if (options.signal !== undefined) init.signal = options.signal;
	const response = await fetchImpl(url, init);
	return await readJsonResponse(response, url);
}

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	apiKey: string,
	options: { signal?: AbortSignal },
): Promise<unknown> {
	const init: RequestInit = {
		headers: {
			authorization: `Bearer ${apiKey}`,
		},
	};
	if (options.signal !== undefined) init.signal = options.signal;
	const response = await fetchImpl(url, init);
	return await readJsonResponse(response, url);
}

async function readJsonResponse(response: Response, url: string): Promise<unknown> {
	const rawText = await response.text();
	let payload: unknown;
	try {
		payload = rawText.length > 0 ? JSON.parse(rawText) : {};
	} catch {
		payload = { raw: rawText };
	}
	if (!response.ok) {
		throw new Error(`${url} failed (${response.status}): ${summarizeApiError(payload)}`);
	}
	return payload;
}

async function saveImageGenerationData(
	payload: unknown,
	options: {
		fetchImpl: typeof fetch;
		outputDir: string;
		filenamePrefix: string;
		extension: string;
		signal?: AbortSignal;
		downloadUrls: boolean;
	},
): Promise<GeneratedMediaFile[]> {
	const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
	if (data.length === 0) throw new Error("Image generation response did not contain data.");
	await mkdir(options.outputDir, { recursive: true });
	const files: GeneratedMediaFile[] = [];
	for (let index = 0; index < data.length; index += 1) {
		const item = data[index];
		if (!isRecord(item)) continue;
		const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
		const b64Json = typeof item.b64_json === "string" ? item.b64_json : undefined;
		const url = typeof item.url === "string" ? item.url : undefined;
		if (b64Json !== undefined) {
			const bytes = Buffer.from(b64Json, "base64");
			const path = join(options.outputDir, `${safeFilename(options.filenamePrefix)}-${index + 1}.${options.extension}`);
			await writeFile(path, bytes);
			files.push({ index, path, bytes: bytes.byteLength, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) });
			continue;
		}
		if (url !== undefined && options.downloadUrls) {
			const downloaded = await downloadUrl(options.fetchImpl, url, {
				outputDir: options.outputDir,
				filenamePrefix: `${options.filenamePrefix}-${index + 1}`,
				fallbackExtension: options.extension,
				...signalOption(options.signal),
			});
			files.push({ index, url, ...downloaded, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) });
			continue;
		}
		if (url !== undefined) {
			files.push({ index, url, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) });
		}
	}
	if (files.length === 0) throw new Error("Image generation response did not contain b64_json or url outputs.");
	return files;
}

async function buildXAiVideoResult(
	payload: unknown,
	options: {
		fetchImpl: typeof fetch;
		model: string;
		requestId: string;
		outputDir: string;
		filenamePrefix: string;
		download: boolean;
		signal?: AbortSignal;
	},
): Promise<XAiVideoGenerateResult> {
	const video = isRecord(payload) && isRecord(payload.video) ? payload.video : undefined;
	const url = typeof video?.url === "string" ? video.url : undefined;
	const duration = typeof video?.duration === "number" ? video.duration : undefined;
	const respectModeration = typeof video?.respect_moderation === "boolean" ? video.respect_moderation : undefined;
	const result: XAiVideoGenerateResult = {
		provider: "xai",
		model: isRecord(payload) && typeof payload.model === "string" ? payload.model : options.model,
		requestId: options.requestId,
		status: "done",
		...(url === undefined ? {} : { url }),
		...(duration === undefined ? {} : { duration }),
		...(respectModeration === undefined ? {} : { respectModeration }),
	};
	if (url !== undefined && options.download) {
		const downloaded = await downloadUrl(options.fetchImpl, url, {
			outputDir: options.outputDir,
			filenamePrefix: options.filenamePrefix,
			fallbackExtension: "mp4",
			...signalOption(options.signal),
		});
		if (downloaded.path !== undefined) result.path = downloaded.path;
	}
	return result;
}

async function downloadUrl(
	fetchImpl: typeof fetch,
	url: string,
	options: { outputDir: string; filenamePrefix: string; fallbackExtension: string; signal?: AbortSignal },
): Promise<{ path?: string; bytes?: number }> {
	await mkdir(options.outputDir, { recursive: true });
	const init: RequestInit = {};
	if (options.signal !== undefined) init.signal = options.signal;
	const response = await fetchImpl(url, init);
	if (!response.ok) return {};
	const arrayBuffer = await response.arrayBuffer();
	const contentType = response.headers.get("content-type") ?? "";
	const extension = extensionFromContentType(contentType) ?? options.fallbackExtension;
	const bytes = Buffer.from(arrayBuffer);
	const path = join(options.outputDir, `${safeFilename(options.filenamePrefix)}.${extension}`);
	await writeFile(path, bytes);
	return { path, bytes: bytes.byteLength };
}

function resolveOutputDir(raw: string | undefined): string {
	return resolve(raw?.trim() || DEFAULT_MEDIA_OUTPUT_DIR);
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

function readRequiredString(payload: unknown, key: string): string {
	if (!isRecord(payload) || typeof payload[key] !== "string" || payload[key].length === 0) {
		throw new Error(`Response missing required ${key}.`);
	}
	return payload[key];
}

function safeFilename(value: string): string {
	const safe = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return safe.length > 0 ? safe.slice(0, 80) : "media";
}

function extensionFromContentType(contentType: string): string | undefined {
	if (contentType.includes("image/png")) return "png";
	if (contentType.includes("image/jpeg")) return "jpg";
	if (contentType.includes("image/webp")) return "webp";
	if (contentType.includes("video/mp4")) return "mp4";
	if (contentType.includes("video/webm")) return "webm";
	return undefined;
}

function summarizeApiError(value: unknown): string {
	if (isRecord(value)) {
		const error = value.error;
		if (isRecord(error)) {
			const message = error.message;
			if (typeof message === "string") return message;
		}
		if (typeof value.raw === "string") return value.raw.slice(0, 500);
	}
	try {
		return JSON.stringify(value).slice(0, 500);
	} catch {
		return String(value);
	}
}
