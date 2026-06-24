import { guardedFetch } from "./net-guard.ts";

export interface WebFetchInput {
	url: string;
	maxBytes?: number;
	maxTextChars?: number;
}

export interface WebSearchInput {
	query: string;
	limit?: number;
}

export interface WebLink {
	text: string;
	url: string;
}

export interface WebMedia {
	kind: "image" | "video" | "gif";
	url: string;
	alt?: string;
}

export interface WebFetchResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	text: string;
	truncated: boolean;
	links: WebLink[];
	media: WebMedia[];
}

export interface WebSearchResult {
	query: string;
	results: WebLink[];
}

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;

export async function fetchWebPage(input: WebFetchInput, fetchImpl: typeof fetch = fetch): Promise<WebFetchResult> {
	const url = normalizeHttpUrl(input.url);
	const maxBytes = Math.max(1, Math.min(10_000_000, Math.floor(input.maxBytes ?? DEFAULT_MAX_BYTES)));
	const maxTextChars = Math.max(1, Math.min(100_000, Math.floor(input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS)));
	const response = await guardedFetch(url, {
		fetchImpl,
		init: {
			headers: {
				"user-agent": "Clanky/0.1 (+https://github.com/Volpestyle/clanky)",
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
			},
		},
	});
	const contentType = response.headers.get("content-type") ?? undefined;
	const { bytes, overflowed } = await readBodyUpTo(response, maxBytes);
	const raw = bytes.toString("utf8");
	const parsed = parseWebContent(raw, response.url || url, maxTextChars);
	return {
		url,
		finalUrl: response.url || url,
		status: response.status,
		...(contentType === undefined ? {} : { contentType }),
		...parsed,
		truncated: overflowed || parsed.truncated,
	};
}

/**
 * Read the response body, stopping (and aborting the download) once maxBytes is
 * exceeded, so a hostile or huge public endpoint cannot OOM the process. Returns
 * the bytes capped at maxBytes plus whether more data was available.
 */
async function readBodyUpTo(response: Response, maxBytes: number): Promise<{ bytes: Buffer; overflowed: boolean }> {
	const body = response.body;
	if (body === null) {
		const all = Buffer.from(await response.arrayBuffer());
		return { bytes: all.subarray(0, maxBytes), overflowed: all.byteLength > maxBytes };
	}
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let overflowed = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
			total += value.byteLength;
			if (total > maxBytes) {
				overflowed = true;
				break;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), overflowed };
}

export async function searchWeb(input: WebSearchInput, fetchImpl: typeof fetch = fetch): Promise<WebSearchResult> {
	const query = input.query.trim();
	if (query.length === 0) throw new Error("web_search query must not be empty");
	const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 8)));
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const page = await fetchWebPage({ url, maxTextChars: 50_000 }, fetchImpl);
	const results = page.links
		.filter((link) => link.text.length > 0)
		.map((link) => ({ text: link.text, url: unwrapDuckDuckGoUrl(link.url) }))
		.filter((link) => !link.url.includes("duckduckgo.com/y.js"))
		.filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index)
		.slice(0, limit);
	return { query, results };
}

function parseWebContent(html: string, baseUrl: string, maxTextChars: number): Omit<WebFetchResult, "url" | "finalUrl" | "status" | "contentType"> {
	const title = decodeHtml(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim() ?? "");
	const links = extractLinks(html, baseUrl).slice(0, 100);
	const media = extractMedia(html, baseUrl).slice(0, 100);
	const cleaned = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	const text = decodeHtml(cleaned).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return {
		...(title.length === 0 ? {} : { title }),
		text: text.slice(0, maxTextChars),
		truncated: text.length > maxTextChars,
		links,
		media,
	};
}

function extractLinks(html: string, baseUrl: string): WebLink[] {
	const links: WebLink[] = [];
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const attrs = match[1] ?? "";
		const href = attr(attrs, "href");
		const url = href === undefined ? undefined : absolutizeUrl(href, baseUrl);
		if (url === undefined) continue;
		const text = decodeHtml((match[2] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
		links.push({ text, url });
	}
	return links;
}

function extractMedia(html: string, baseUrl: string): WebMedia[] {
	const media: WebMedia[] = [];
	for (const match of html.matchAll(/<(img|video|source)\b([^>]*)>/gi)) {
		const tag = (match[1] ?? "").toLowerCase();
		const attrs = match[2] ?? "";
		const src = attr(attrs, "src") ?? attr(attrs, "data-src");
		const url = src === undefined ? undefined : absolutizeUrl(src, baseUrl);
		if (url === undefined) continue;
		const kind = tag === "img" ? (/\.(gif)(\?|#|$)/i.test(url) ? "gif" : "image") : "video";
		const alt = attr(attrs, "alt");
		media.push({ kind, url, ...(alt === undefined ? {} : { alt: decodeHtml(alt) }) });
	}
	return media;
}

function attr(attrs: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`\\b${escaped}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
	return match?.[2] ?? match?.[3] ?? match?.[4];
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
	return pattern.exec(value)?.[1];
}

function normalizeHttpUrl(value: string): string {
	const trimmed = value.trim();
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must be http(s)");
	return parsed.toString();
}

function absolutizeUrl(value: string, baseUrl: string): string | undefined {
	try {
		const parsed = new URL(value, baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function unwrapDuckDuckGoUrl(value: string): string {
	try {
		const parsed = new URL(value);
		const uddg = parsed.searchParams.get("uddg");
		if (uddg !== null && uddg.length > 0) return new URL(uddg).toString();
		return parsed.toString();
	} catch {
		return value;
	}
}

function decodeHtml(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
