import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FilePart, UserContent } from "ai";

export interface TuiAttachmentMessageOptions {
	cwd?: string;
	maxAttachments?: number;
	maxBytesPerAttachment?: number;
}

export interface TuiAttachmentDirective {
	line: number;
	kind: "file" | "image";
	rawPath: string;
}

export interface ParsedTuiAttachmentPrompt {
	text: string;
	directives: TuiAttachmentDirective[];
}

const DEFAULT_MAX_ATTACHMENTS = 8;
const DEFAULT_MAX_BYTES_PER_ATTACHMENT = 25 * 1024 * 1024;
const ATTACHMENT_LINE_PATTERN = /^\s*@(file|image)\s+(.+?)\s*$/iu;
const DEFAULT_ATTACHMENT_TEXT = "Inspect the attached file(s).";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_PASTE_BUFFER = 1 << 20;

// Bracketed-paste rewriter for terminal drag-and-drop. eve enables bracketed
// paste and inserts pasted text verbatim, so a file dragged from Finder lands
// as a raw (quoted/escaped) path. This intercepts the paste before eve sees it
// and, when the payload is one-or-more existing local file paths, rewrites it
// into canonical `@image`/`@file` attachment lines that the prompt parser above
// already understands. Non-path pastes pass through untouched. The returned
// closure is stateful: it buffers partial pastes split across stdin chunks.
export function createDroppedPathPasteRewriter(options: TuiAttachmentMessageOptions = {}): (text: string) => string {
	let buffer = "";
	return (text: string): string => {
		buffer += text;
		let out = "";
		for (;;) {
			const start = buffer.indexOf(PASTE_START);
			if (start === -1) {
				out += buffer;
				buffer = "";
				break;
			}
			out += buffer.slice(0, start);
			const end = buffer.indexOf(PASTE_END, start + PASTE_START.length);
			if (end === -1) {
				buffer = buffer.slice(start);
				if (buffer.length > MAX_PASTE_BUFFER) {
					out += buffer;
					buffer = "";
				}
				break;
			}
			const inner = buffer.slice(start + PASTE_START.length, end);
			buffer = buffer.slice(end + PASTE_END.length);
			const rewritten = rewriteDroppedPathsToDirectives(inner, options);
			out += `${PASTE_START}${rewritten ?? inner}${PASTE_END}`;
		}
		return out;
	};
}

// Convert a raw paste payload into isolated attachment directive lines, or null
// if it does not look like a clean file drop (leave such pastes verbatim).
export function rewriteDroppedPathsToDirectives(pasted: string, options: TuiAttachmentMessageOptions = {}): string | null {
	const trimmed = pasted.trim();
	if (trimmed.length === 0) return null;
	if (/[\r\n]/u.test(trimmed)) return null;
	const tokens = tokenizeDroppedPaths(trimmed);
	if (tokens.length === 0) return null;
	const maxAttachments = clampInteger(options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS, 1, DEFAULT_MAX_ATTACHMENTS);
	if (tokens.length > maxAttachments) return null;
	const directives: string[] = [];
	for (const token of tokens) {
		const directive = classifyDroppedToken(token, options.cwd);
		if (directive === null) return null;
		directives.push(directive);
	}
	// Surround with newlines so each directive sits on its own line regardless of
	// what the user has already typed, then leaves the caret on a fresh line.
	return `\n${directives.join("\n")}\n`;
}

function classifyDroppedToken(token: string, cwd: string | undefined): string | null {
	if (!looksLikeDroppedPath(token)) return null;
	const path = resolveAttachmentPath(token, cwd);
	if (!isExistingFileSync(path)) return null;
	const kind = isImageExtension(path) ? "image" : "file";
	return `@${kind} ${path}`;
}

function isExistingFileSync(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function looksLikeDroppedPath(token: string): boolean {
	const unquoted = stripMatchingQuotes(token.trim());
	const unescaped = unquoted.replace(/\\(.)/gu, "$1");
	return (
		unescaped.startsWith("/") ||
		unescaped === "~" ||
		unescaped.startsWith("~/") ||
		unescaped.startsWith("file://")
	);
}

function isImageExtension(path: string): boolean {
	const mediaType = mediaTypeFromExtension(extname(path).toLowerCase());
	return mediaType !== undefined && isImageMediaType(mediaType);
}

// Shell-style split that keeps quotes/backslash escapes inside each token so
// resolveAttachmentPath can unwrap them. Returns [] on an unterminated quote.
function tokenizeDroppedPaths(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "\"" | "'" | null = null;
	let started = false;
	for (let index = 0; index < input.length; index += 1) {
		const ch = input[index] ?? "";
		if (quote !== null) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			const next = input[index + 1];
			if (next !== undefined) {
				current += next;
				index += 1;
			}
			started = true;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			current += ch;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (quote !== null) return [];
	if (started) tokens.push(current);
	return tokens;
}

export function parseTuiAttachmentPrompt(prompt: string): ParsedTuiAttachmentPrompt {
	const textLines: string[] = [];
	const directives: TuiAttachmentDirective[] = [];
	const lines = prompt.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const match = ATTACHMENT_LINE_PATTERN.exec(line);
		if (match === null) {
			textLines.push(line);
			continue;
		}
		const kind = match[1]?.toLowerCase() === "image" ? "image" : "file";
		const rawPath = match[2]?.trim() ?? "";
		directives.push({ line: index + 1, kind, rawPath });
	}
	return { text: textLines.join("\n").trim(), directives };
}

export async function buildTuiAttachmentMessage(
	prompt: string,
	options: TuiAttachmentMessageOptions = {},
): Promise<string | UserContent> {
	const parsed = parseTuiAttachmentPrompt(prompt);
	if (parsed.directives.length === 0) return prompt;
	const maxAttachments = clampInteger(options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS, 1, DEFAULT_MAX_ATTACHMENTS);
	const maxBytes = clampInteger(
		options.maxBytesPerAttachment ?? DEFAULT_MAX_BYTES_PER_ATTACHMENT,
		1,
		DEFAULT_MAX_BYTES_PER_ATTACHMENT,
	);
	if (parsed.directives.length > maxAttachments) {
		throw new Error(`Too many attachments (${parsed.directives.length}); maximum is ${maxAttachments}.`);
	}
	const files = await Promise.all(parsed.directives.map((directive) => readAttachmentFile(directive, options.cwd, maxBytes)));
	const text = parsed.text.length === 0 ? DEFAULT_ATTACHMENT_TEXT : parsed.text;
	return [{ type: "text", text }, ...files];
}

async function readAttachmentFile(
	directive: TuiAttachmentDirective,
	cwd: string | undefined,
	maxBytes: number,
): Promise<FilePart> {
	const path = resolveAttachmentPath(directive.rawPath, cwd);
	const info = await stat(path).catch((error: unknown) => {
		throw new Error(`Attachment on line ${directive.line} is not readable: ${path} (${errorMessage(error)})`);
	});
	if (!info.isFile()) throw new Error(`Attachment on line ${directive.line} is not a file: ${path}`);
	if (info.size > maxBytes) {
		throw new Error(`Attachment on line ${directive.line} is too large (${info.size} bytes); maximum is ${maxBytes}.`);
	}
	const bytes = await readFile(path);
	const mediaType = mediaTypeFor(path, bytes);
	if (directive.kind === "image" && !isImageMediaType(mediaType)) {
		throw new Error(`Attachment on line ${directive.line} is not a supported image file: ${path}`);
	}
	return {
		type: "file",
		data: `data:${mediaType};base64,${bytes.toString("base64")}`,
		mediaType,
		filename: basename(path),
	};
}

function resolveAttachmentPath(rawPath: string, cwd: string | undefined): string {
	const unquoted = stripMatchingQuotes(rawPath.trim());
	const unescaped = unquoted.replace(/\\([\\ "'()[\]{}&;!#$`])/gu, "$1");
	if (unescaped.startsWith("file://")) return fileURLToPath(unescaped);
	const expanded = unescaped === "~" ? homedir() : unescaped.startsWith("~/") ? `${homedir()}${unescaped.slice(1)}` : unescaped;
	return isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded);
}

function stripMatchingQuotes(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	return (first === "\"" && last === "\"") || (first === "'" && last === "'") ? value.slice(1, -1) : value;
}

function mediaTypeFor(path: string, bytes: Buffer): string {
	const magic = mediaTypeFromMagic(bytes);
	if (magic !== undefined) return magic;
	return mediaTypeFromExtension(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function mediaTypeFromMagic(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
		return "image/webp";
	}
	if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
		const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
		if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
		if (["mif1", "msf1"].includes(brand)) return "image/heif";
	}
	if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
	return undefined;
}

function mediaTypeFromExtension(extension: string): string | undefined {
	switch (extension) {
		case ".avif":
			return "image/avif";
		case ".csv":
			return "text/csv";
		case ".gif":
			return "image/gif";
		case ".html":
		case ".htm":
			return "text/html";
		case ".heic":
			return "image/heic";
		case ".heif":
			return "image/heif";
		case ".jpeg":
		case ".jpg":
			return "image/jpeg";
		case ".json":
			return "application/json";
		case ".md":
		case ".txt":
		case ".log":
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
		case ".css":
		case ".yaml":
		case ".yml":
			return "text/plain";
		case ".pdf":
			return "application/pdf";
		case ".png":
			return "image/png";
		case ".svg":
			return "image/svg+xml";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

function isImageMediaType(mediaType: string): boolean {
	return mediaType.startsWith("image/");
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
