import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { WebLink, WebMedia } from "./web.ts";
import { assertPublicHttpUrl } from "./net-guard.ts";
import { resolveClankyDataPath, resolveClankyHome } from "./paths.ts";

export type HeadlessWaitUntil = "domcontentloaded" | "load" | "networkidle";

export interface HeadlessViewport {
	width: number;
	height: number;
}

export interface WebRenderInput {
	url: string;
	waitUntil?: HeadlessWaitUntil;
	waitMs?: number;
	timeoutMs?: number;
	maxTextChars?: number;
	maxLinks?: number;
	maxMedia?: number;
	screenshot?: boolean;
	viewport?: HeadlessViewport;
}

export interface WebMeta {
	name: string;
	content: string;
}

export interface WebRenderResult {
	url: string;
	finalUrl: string;
	title?: string;
	text: string;
	truncated: boolean;
	links: WebLink[];
	media: WebMedia[];
	meta: WebMeta[];
	screenshotPath?: string;
}

export interface LoadedRenderedPage {
	finalUrl: string;
	title?: string;
	text: string;
	links: WebLink[];
	media: WebMedia[];
	meta: WebMeta[];
	screenshotPng?: Buffer;
}

export interface ResolvedWebRenderInput {
	url: string;
	waitUntil: HeadlessWaitUntil;
	waitMs: number;
	timeoutMs: number;
	maxTextChars: number;
	maxLinks: number;
	maxMedia: number;
	screenshot: boolean;
	viewport: HeadlessViewport;
}

export interface WebRenderOptions {
	env?: NodeJS.ProcessEnv;
	loadPage?(input: ResolvedWebRenderInput): Promise<LoadedRenderedPage>;
}

export interface WebCaptureFramesInput {
	url?: string;
	path?: string;
	waitUntil?: HeadlessWaitUntil;
	waitMs?: number;
	timeoutMs?: number;
	frameCount?: number;
	intervalMs?: number;
	autoplay?: boolean;
	clickSelector?: string;
	viewport?: HeadlessViewport;
}

export interface CapturedWebFrame {
	index: number;
	path: string;
	capturedAtMs: number;
	bytes: number;
}

export interface WebCaptureFramesResult {
	source: string;
	finalUrl: string;
	title?: string;
	frameCount: number;
	frames: CapturedWebFrame[];
	mediaState: WebMediaPlaybackState;
}

export interface WebMediaPlaybackState {
	videos: Array<{
		currentTime?: number;
		duration?: number;
		paused?: boolean;
		ended?: boolean;
		muted?: boolean;
		readyState?: number;
		width?: number;
		height?: number;
	}>;
}

export type FrameCaptureMediaKind = "image" | "video";

export interface LoadedFrameCapture {
	finalUrl: string;
	title?: string;
	frames: Array<{ capturedAtMs: number; png: Buffer }>;
	mediaState: WebMediaPlaybackState;
}

export interface ResolvedWebCaptureFramesInput {
	source: string;
	navigationUrl: string;
	waitUntil: HeadlessWaitUntil;
	waitMs: number;
	timeoutMs: number;
	frameCount: number;
	intervalMs: number;
	autoplay: boolean;
	clickSelector?: string;
	mediaKind?: FrameCaptureMediaKind;
	viewport: HeadlessViewport;
}

export interface WebCaptureFramesOptions {
	env?: NodeJS.ProcessEnv;
	capturePage?(input: ResolvedWebCaptureFramesInput): Promise<LoadedFrameCapture>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_CHARS = 25_000;
const DEFAULT_VIEWPORT: HeadlessViewport = { width: 1365, height: 900 };

export async function renderWebPage(input: WebRenderInput, options: WebRenderOptions = {}): Promise<WebRenderResult> {
	const resolved = resolveWebRenderInput(input);
	const loaded = await (options.loadPage ?? loadPageWithPlaywright)(resolved);
	const text = normalizeWhitespace(loaded.text);
	const truncated = text.length > resolved.maxTextChars;
	const result: WebRenderResult = {
		url: resolved.url,
		finalUrl: loaded.finalUrl,
		...(loaded.title?.trim() ? { title: loaded.title.trim() } : {}),
		text: text.slice(0, resolved.maxTextChars),
		truncated,
		links: dedupeLinks(loaded.links).slice(0, resolved.maxLinks),
		media: dedupeMedia(loaded.media).slice(0, resolved.maxMedia),
		meta: dedupeMeta(loaded.meta).slice(0, 50),
	};
	if (loaded.screenshotPng !== undefined) {
		result.screenshotPath = await writeScreenshot(resolved.url, loaded.screenshotPng, options.env);
	}
	return result;
}

export async function captureWebFrames(
	input: WebCaptureFramesInput,
	options: WebCaptureFramesOptions = {},
): Promise<WebCaptureFramesResult> {
	const resolved = resolveWebCaptureFramesInput(input);
	const loaded = await (options.capturePage ?? captureFramesWithPlaywright)(resolved);
	const frames: CapturedWebFrame[] = [];
	for (let index = 0; index < loaded.frames.length; index += 1) {
		const frame = loaded.frames[index];
		if (frame === undefined) continue;
		const path = await writeFrameCapture(resolved.source, index + 1, frame.png, options.env);
		frames.push({ index: index + 1, path, capturedAtMs: frame.capturedAtMs, bytes: frame.png.byteLength });
	}
	return {
		source: resolved.source,
		finalUrl: loaded.finalUrl,
		...(loaded.title?.trim() ? { title: loaded.title.trim() } : {}),
		frameCount: frames.length,
		frames,
		mediaState: loaded.mediaState,
	};
}

function resolveWebRenderInput(input: WebRenderInput): ResolvedWebRenderInput {
	const url = normalizeHttpUrl(input.url);
	const width = Math.max(320, Math.min(3840, Math.floor(input.viewport?.width ?? DEFAULT_VIEWPORT.width)));
	const height = Math.max(240, Math.min(2160, Math.floor(input.viewport?.height ?? DEFAULT_VIEWPORT.height)));
	return {
		url,
		waitUntil: input.waitUntil ?? "domcontentloaded",
		waitMs: Math.max(0, Math.min(10_000, Math.floor(input.waitMs ?? 750))),
		timeoutMs: Math.max(1_000, Math.min(120_000, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS))),
		maxTextChars: Math.max(1, Math.min(100_000, Math.floor(input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS))),
		maxLinks: Math.max(0, Math.min(300, Math.floor(input.maxLinks ?? 100))),
		maxMedia: Math.max(0, Math.min(300, Math.floor(input.maxMedia ?? 100))),
		screenshot: input.screenshot === true,
		viewport: { width, height },
	};
}

function resolveWebCaptureFramesInput(input: WebCaptureFramesInput): ResolvedWebCaptureFramesInput {
	const hasUrl = input.url !== undefined && input.url.trim().length > 0;
	const hasPath = input.path !== undefined && input.path.trim().length > 0;
	if (hasUrl === hasPath) throw new Error("web_capture_frames requires exactly one of url or path.");
	const source = hasUrl ? input.url?.trim() ?? "" : resolve(input.path?.trim() ?? "");
	if (!hasUrl) {
		const home = resolveClankyHome();
		if (source !== home && !source.startsWith(home + sep)) {
			throw new Error("web_capture_frames local path must be inside the Clanky data directory");
		}
	}
	const navigationUrl = hasUrl ? normalizeHttpUrl(source) : pathToFileURL(source).toString();
	const mediaKind = classifyFrameCaptureMediaSource(source);
	const width = Math.max(320, Math.min(3840, Math.floor(input.viewport?.width ?? DEFAULT_VIEWPORT.width)));
	const height = Math.max(240, Math.min(2160, Math.floor(input.viewport?.height ?? DEFAULT_VIEWPORT.height)));
	const clickSelector = input.clickSelector?.trim();
	return {
		source,
		navigationUrl,
		waitUntil: input.waitUntil ?? "domcontentloaded",
		waitMs: Math.max(0, Math.min(10_000, Math.floor(input.waitMs ?? 750))),
		timeoutMs: Math.max(1_000, Math.min(120_000, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS))),
		frameCount: Math.max(1, Math.min(12, Math.floor(input.frameCount ?? 4))),
		intervalMs: Math.max(0, Math.min(10_000, Math.floor(input.intervalMs ?? 1_000))),
		autoplay: input.autoplay !== false,
		...(clickSelector === undefined || clickSelector.length === 0 ? {} : { clickSelector }),
		...(mediaKind === undefined ? {} : { mediaKind }),
		viewport: { width, height },
	};
}

async function loadPageWithPlaywright(input: ResolvedWebRenderInput): Promise<LoadedRenderedPage> {
	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			viewport: input.viewport,
			userAgent: "Clanky/0.1 HeadlessBrowser (+https://github.com/Volpestyle/clanky)",
		});
		const page = await context.newPage();
		await assertPublicHttpUrl(input.url);
		await page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
		if (input.waitMs > 0) await page.waitForTimeout(input.waitMs);
		const snapshot = await page.evaluate<RenderedDomSnapshot>(() => {
			function absoluteUrl(value: string | null): string | null {
				if (value === null || value.trim().length === 0) return null;
				try {
					const parsed = new URL(value, document.baseURI);
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
					return parsed.toString();
				} catch {
					return null;
				}
			}
			function kindFor(url: string, declaredType: string | null): "image" | "gif" | "video" {
				const lower = `${declaredType ?? ""} ${url}`.toLowerCase();
				if (lower.includes("image/gif") || /\.(gif)(\?|#|$)/i.test(url)) return "gif";
				if (lower.includes("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return "video";
				return "image";
			}
			const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).flatMap((node) => {
				const url = absoluteUrl(node.getAttribute("href"));
				if (url === null) return [];
				return [{ text: node.innerText.replace(/\s+/g, " ").trim(), url }];
			});
			const media: WebMedia[] = [];
			for (const node of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
				const url = absoluteUrl(node.currentSrc || node.src || node.getAttribute("src"));
				if (url === null) continue;
				const alt = node.alt.trim();
				media.push({
					kind: kindFor(url, node.getAttribute("type")),
					url,
					...(alt.length === 0 ? {} : { alt }),
				});
			}
			for (const node of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) {
				const url = absoluteUrl(node.currentSrc || node.src || node.getAttribute("src"));
				const poster = absoluteUrl(node.poster || node.getAttribute("poster"));
				if (url !== null) media.push({ kind: "video", url });
				if (poster !== null) media.push({ kind: "image", url: poster, alt: "video poster" });
			}
			for (const node of Array.from(document.querySelectorAll<HTMLSourceElement>("source[src]"))) {
				const url = absoluteUrl(node.src || node.getAttribute("src"));
				if (url === null) continue;
				media.push({ kind: kindFor(url, node.type), url });
			}
			const meta: WebMeta[] = [];
			for (const node of Array.from(document.querySelectorAll<HTMLMetaElement>("meta[property], meta[name]"))) {
				const name = node.getAttribute("property") ?? node.getAttribute("name");
				const content = node.content.trim();
				if (name === null || content.length === 0) continue;
				meta.push({ name, content });
				if (name === "og:image" || name === "twitter:image") {
					const url = absoluteUrl(content);
					if (url !== null) media.push({ kind: kindFor(url, "image"), url });
				}
				if (name === "og:video" || name === "twitter:player") {
					const url = absoluteUrl(content);
					if (url !== null) media.push({ kind: "video", url });
				}
			}
			return {
				title: document.title,
				text: document.body?.innerText ?? "",
				links,
				media,
				meta,
			};
		});
		const screenshotPng = input.screenshot ? await page.screenshot({ fullPage: true, type: "png" }) : undefined;
		const finalUrl = page.url();
		await context.close();
		return {
			finalUrl,
			...snapshot,
			...(screenshotPng === undefined ? {} : { screenshotPng }),
		};
	} catch (error) {
		throw enrichPlaywrightError(error);
	} finally {
		await browser?.close().catch(() => undefined);
	}
}

async function captureFramesWithPlaywright(input: ResolvedWebCaptureFramesInput): Promise<LoadedFrameCapture> {
	let browser: Browser | undefined;
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			viewport: input.viewport,
			userAgent: "Clanky/0.1 HeadlessBrowser (+https://github.com/Volpestyle/clanky)",
		});
		const page = await context.newPage();
		if (input.navigationUrl.startsWith("http:") || input.navigationUrl.startsWith("https:")) {
			await assertPublicHttpUrl(input.navigationUrl);
		}
		await page.goto(input.navigationUrl, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
		if (input.mediaKind !== undefined) {
			await page.setContent(buildFrameCaptureMediaHtml(input.navigationUrl, input.mediaKind), {
				waitUntil: "domcontentloaded",
				timeout: input.timeoutMs,
			});
		}
		if (input.waitMs > 0) await page.waitForTimeout(input.waitMs);
		if (input.clickSelector !== undefined) {
			await page.locator(input.clickSelector).first().click({ timeout: Math.min(input.timeoutMs, 5_000) }).catch(() => undefined);
		}
		if (input.autoplay) await attemptPagePlayback(page);
		const startedAt = Date.now();
		const frames: Array<{ capturedAtMs: number; png: Buffer }> = [];
		for (let index = 0; index < input.frameCount; index += 1) {
			if (index > 0 && input.intervalMs > 0) await page.waitForTimeout(input.intervalMs);
			const capturedAtMs = Date.now() - startedAt;
			const png = await page.screenshot({ fullPage: false, type: "png" });
			frames.push({ capturedAtMs, png });
		}
		const mediaState = await readMediaPlaybackState(page);
		const title = await page.title();
		const finalUrl = page.url();
		await context.close();
		return { finalUrl, title, frames, mediaState };
	} catch (error) {
		throw enrichPlaywrightError(error);
	} finally {
		await browser?.close().catch(() => undefined);
	}
}

async function attemptPagePlayback(page: Page): Promise<void> {
	await page.evaluate(() => {
		for (const video of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) {
			video.muted = true;
			void video.play().catch(() => undefined);
		}
	});
}

function classifyFrameCaptureMediaSource(source: string): FrameCaptureMediaKind | undefined {
	const path = normalizedSourcePath(source);
	if (path === undefined) return undefined;
	if (/\.(png|jpe?g|webp|avif|gif)$/i.test(path)) return "image";
	if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return "video";
	return undefined;
}

function normalizedSourcePath(source: string): string | undefined {
	const trimmed = source.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return decodeURIComponent(new URL(trimmed).pathname).toLowerCase();
	} catch {
		try {
			return decodeURIComponent(trimmed).toLowerCase();
		} catch {
			return trimmed.toLowerCase();
		}
	}
}

function buildFrameCaptureMediaHtml(url: string, mediaKind: FrameCaptureMediaKind): string {
	const escapedUrl = escapeHtmlAttribute(url);
	const media =
		mediaKind === "video"
			? `<video src="${escapedUrl}" autoplay muted playsinline controls></video>`
			: `<img src="${escapedUrl}" alt="media artifact">`;
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		"<title>Media capture</title>",
		"<style>",
		"html,body{margin:0;width:100%;height:100%;background:#050505;overflow:hidden;}",
		"body{display:flex;align-items:center;justify-content:center;}",
		"img,video{max-width:100vw;max-height:100vh;width:auto;height:auto;object-fit:contain;}",
		"video{background:#050505;}",
		"</style>",
		"</head>",
		"<body>",
		media,
		"</body>",
		"</html>",
	].join("");
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

async function readMediaPlaybackState(
	page: Page,
): Promise<WebMediaPlaybackState> {
	return await page.evaluate<WebMediaPlaybackState>(() => ({
		videos: Array.from(document.querySelectorAll<HTMLVideoElement>("video")).map((video) => ({
			currentTime: Number.isFinite(video.currentTime) ? video.currentTime : undefined,
			duration: Number.isFinite(video.duration) ? video.duration : undefined,
			paused: video.paused,
			ended: video.ended,
			muted: video.muted,
			readyState: video.readyState,
			width: video.videoWidth || undefined,
			height: video.videoHeight || undefined,
		})),
	}));
}

interface RenderedDomSnapshot {
	title?: string;
	text: string;
	links: WebLink[];
	media: WebMedia[];
	meta: WebMeta[];
}

function enrichPlaywrightError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("Executable doesn't exist") || message.includes("browserType.launch")) {
		return new Error(`${message}\nInstall the headless browser with: pnpm exec playwright install chromium`);
	}
	return error instanceof Error ? error : new Error(message);
}

async function writeScreenshot(url: string, bytes: Buffer, env: NodeJS.ProcessEnv | undefined): Promise<string> {
	const dir = resolveClankyDataPath("headless-browser/screenshots", env);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const hostname = safeFilename(new URL(url).hostname || "page");
	const path = join(dir, `${Date.now()}-${hostname}-${randomUUID()}.png`);
	await writeFile(path, bytes, { mode: 0o600 });
	return path;
}

async function writeFrameCapture(source: string, index: number, bytes: Buffer, env: NodeJS.ProcessEnv | undefined): Promise<string> {
	const dir = resolveClankyDataPath("headless-browser/frames", env);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const label = safeFilename(sourceLabel(source));
	const path = join(dir, `${Date.now()}-${label}-${String(index).padStart(2, "0")}-${randomUUID()}.png`);
	await writeFile(path, bytes, { mode: 0o600 });
	return path;
}

function normalizeHttpUrl(value: string): string {
	const parsed = new URL(value.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must be http(s)");
	return parsed.toString();
}

function sourceLabel(source: string): string {
	try {
		const parsed = new URL(source);
		return parsed.hostname || basename(parsed.pathname) || "media";
	} catch {
		return basename(source) || "media";
	}
}

function normalizeWhitespace(value: string): string {
	return value.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupeLinks(links: readonly WebLink[]): WebLink[] {
	const seen = new Set<string>();
	const out: WebLink[] = [];
	for (const link of links) {
		if (seen.has(link.url)) continue;
		seen.add(link.url);
		out.push({ text: link.text.trim(), url: link.url });
	}
	return out;
}

function dedupeMedia(media: readonly WebMedia[]): WebMedia[] {
	const seen = new Set<string>();
	const out: WebMedia[] = [];
	for (const item of media) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		out.push(item);
	}
	return out;
}

function dedupeMeta(meta: readonly WebMeta[]): WebMeta[] {
	const seen = new Set<string>();
	const out: WebMeta[] = [];
	for (const item of meta) {
		const name = item.name.trim();
		const content = item.content.trim();
		if (name.length === 0 || content.length === 0) continue;
		const key = `${name}\0${content}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, content });
	}
	return out;
}

function safeFilename(value: string): string {
	const safe = basename(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.length === 0 ? "page" : safe.slice(0, 80);
}
