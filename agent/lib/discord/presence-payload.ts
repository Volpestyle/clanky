import type { FilePart, UserContent } from "ai";
import { createDataUrlFilePart } from "eve/client";
import type {
	DiscordAcceptanceReason,
	DiscordInboundAttachment,
	DiscordInboundMessage,
} from "./acceptance.ts";
import { guardedFetch } from "../net-guard.ts";
import { buildDiscordMediaFetchHeaders } from "./media.ts";
import { formatPresencePrompt, type DiscordHistoryEntry } from "./prompt.ts";

export interface PresenceSessionMessageOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	history?: readonly DiscordHistoryEntry[];
	maxInlineVisualAttachments?: number;
	maxInlineVisualAttachmentBytes?: number;
}

interface InlineAttachmentResult {
	files: FilePart[];
	notes: string[];
}

const DEFAULT_MAX_INLINE_VISUAL_ATTACHMENTS = 4;
const DEFAULT_MAX_INLINE_VISUAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export async function buildPresenceSessionMessage(
	message: DiscordInboundMessage,
	reason: DiscordAcceptanceReason,
	sender: string,
	options: PresenceSessionMessageOptions = {},
): Promise<string | UserContent> {
	const inline = await inlineVisualAttachments(message.attachments ?? [], options);
	const prompt = formatPresencePrompt(message, reason, sender, options.history ?? []);
	const text =
		inline.notes.length === 0
			? prompt
			: `${prompt}\n\nInline visual attachment transfer:\n${inline.notes.join("\n")}`;
	if (inline.files.length === 0) return text;
	return [{ type: "text", text }, ...inline.files];
}

async function inlineVisualAttachments(
	attachments: readonly DiscordInboundAttachment[],
	options: PresenceSessionMessageOptions,
): Promise<InlineAttachmentResult> {
	const maxCount = Math.max(0, Math.min(10, Math.floor(options.maxInlineVisualAttachments ?? DEFAULT_MAX_INLINE_VISUAL_ATTACHMENTS)));
	const maxBytes = Math.max(1, Math.floor(options.maxInlineVisualAttachmentBytes ?? DEFAULT_MAX_INLINE_VISUAL_ATTACHMENT_BYTES));
	const fetchImpl = options.fetchImpl ?? fetch;
	const env = options.env ?? process.env;
	const files: FilePart[] = [];
	const notes: string[] = [];
	for (const attachment of attachments) {
		if (!isVisualAttachment(attachment)) continue;
		if (files.length >= maxCount) {
			notes.push(`- not inlined ${attachmentLabel(attachment)}: inline attachment limit reached`);
			continue;
		}
		if (attachment.size !== undefined && attachment.size > maxBytes) {
			notes.push(`- not inlined ${attachmentLabel(attachment)}: ${attachment.size} bytes exceeds inline limit ${maxBytes}`);
			continue;
		}
		const downloaded = await fetchInlineAttachment(attachment, maxBytes, fetchImpl, env);
		if (downloaded.file === undefined) {
			notes.push(`- not inlined ${attachmentLabel(attachment)}: ${downloaded.reason}`);
			continue;
		}
		files.push(downloaded.file);
		notes.push(`- inlined ${attachmentLabel(attachment)} for direct visual inspection`);
	}
	return { files, notes };
}

async function fetchInlineAttachment(
	attachment: DiscordInboundAttachment,
	maxBytes: number,
	fetchImpl: typeof fetch,
	env: NodeJS.ProcessEnv,
): Promise<{ file?: FilePart; reason: string }> {
	try {
		const response = await guardedFetch(attachment.url, {
			fetchImpl,
			headersFor: (url) => buildDiscordMediaFetchHeaders(url.href, env),
		});
		if (!response.ok) return { reason: `download failed (${response.status})` };
		const contentLength = parseContentLength(response.headers.get("content-length"));
		if (contentLength !== undefined && contentLength > maxBytes) {
			return { reason: `${contentLength} bytes exceeds inline limit ${maxBytes}` };
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) return { reason: `${bytes.byteLength} bytes exceeds inline limit ${maxBytes}` };
		const mediaType = resolveAttachmentMediaType(attachment, response.headers.get("content-type"));
		if (!mediaType.toLowerCase().startsWith("image/")) return { reason: `downloaded media type ${mediaType} is not visual` };
		return {
			file: createDataUrlFilePart({
				bytes,
				mediaType,
				...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
			}),
			reason: "",
		};
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}
}

function isVisualAttachment(attachment: DiscordInboundAttachment): boolean {
	const lower = `${attachment.contentType ?? ""} ${attachment.filename ?? ""} ${attachment.url}`.toLowerCase();
	return lower.includes("image/") || /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(attachment.url) || /\.(png|jpe?g|gif|webp|avif)$/i.test(attachment.filename ?? "");
}

function resolveAttachmentMediaType(attachment: DiscordInboundAttachment, responseContentType: string | null): string {
	const fromResponse = responseContentType?.split(";")[0]?.trim();
	if (fromResponse !== undefined && fromResponse.length > 0) return fromResponse;
	const fromAttachment = attachment.contentType?.split(";")[0]?.trim();
	if (fromAttachment !== undefined && fromAttachment.length > 0) return fromAttachment;
	const lower = `${attachment.filename ?? ""} ${attachment.url}`.toLowerCase();
	if (lower.includes(".png")) return "image/png";
	if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
	if (lower.includes(".gif")) return "image/gif";
	if (lower.includes(".webp")) return "image/webp";
	if (lower.includes(".avif")) return "image/avif";
	return "application/octet-stream";
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function attachmentLabel(attachment: DiscordInboundAttachment): string {
	return attachment.filename === undefined ? `attachment ${attachment.id}` : `${attachment.filename} (${attachment.id})`;
}

export const __presencePayloadTestHooks = {
	isVisualAttachment,
	resolveAttachmentMediaType,
};
