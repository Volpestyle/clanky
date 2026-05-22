export type TelegramParseMode = "MarkdownV2" | "HTML" | "none";

const MARKDOWN_V2_ESCAPES = ["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!"];

export function escapeMarkdownV2(text: string): string {
	let result = "";
	let i = 0;
	while (i < text.length) {
		const codeFenceMatch = /^```([\s\S]*?)```/.exec(text.slice(i));
		if (codeFenceMatch !== null) {
			result += escapeMarkdownV2CodeBlock(codeFenceMatch[0]);
			i += codeFenceMatch[0].length;
			continue;
		}
		const inlineCodeMatch = /^`([^`\n]+)`/.exec(text.slice(i));
		if (inlineCodeMatch !== null) {
			result += escapeMarkdownV2InlineCode(inlineCodeMatch[0]);
			i += inlineCodeMatch[0].length;
			continue;
		}
		const ch = text[i] ?? "";
		if (MARKDOWN_V2_ESCAPES.includes(ch)) result += `\\${ch}`;
		else result += ch;
		i += 1;
	}
	return result;
}

function escapeMarkdownV2CodeBlock(block: string): string {
	const inner = block.slice(3, block.length - 3);
	const escaped = inner.replace(/[`\\]/g, (ch) => `\\${ch}`);
	return `\`\`\`${escaped}\`\`\``;
}

function escapeMarkdownV2InlineCode(block: string): string {
	const inner = block.slice(1, block.length - 1);
	const escaped = inner.replace(/[`\\]/g, (ch) => `\\${ch}`);
	return `\`${escaped}\``;
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>]/g, (ch) => {
		if (ch === "&") return "&amp;";
		if (ch === "<") return "&lt;";
		return "&gt;";
	});
}

export function applyParseMode(text: string, mode: TelegramParseMode): string {
	if (mode === "MarkdownV2") return escapeMarkdownV2(text);
	if (mode === "HTML") return escapeHtml(text);
	return text;
}

export function telegramParseModeOption(mode: TelegramParseMode): "MarkdownV2" | "HTML" | undefined {
	if (mode === "MarkdownV2") return "MarkdownV2";
	if (mode === "HTML") return "HTML";
	return undefined;
}

const TELEGRAM_HARD_MAX = 4096;

export function splitForTelegram(text: string, max: number): string[] {
	const cap = Math.min(max, TELEGRAM_HARD_MAX);
	if (text.length <= cap) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > cap) {
		const slice = telegramSlice(remaining, cap);
		chunks.push(slice);
		remaining = remaining.slice(slice.length);
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

function telegramSlice(text: string, max: number): string {
	if (text.length <= max) return text;
	const fence = findOpenCodeFenceTelegram(text, max);
	if (fence !== undefined && fence > 0) return text.slice(0, fence);
	const lastNewline = text.lastIndexOf("\n", max);
	if (lastNewline > max * 0.5) return text.slice(0, lastNewline + 1);
	const lastSpace = text.lastIndexOf(" ", max);
	if (lastSpace > max * 0.5) return text.slice(0, lastSpace + 1);
	return text.slice(0, max);
}

function findOpenCodeFenceTelegram(text: string, before: number): number | undefined {
	const segment = text.slice(0, before);
	const matches = segment.match(/```/g);
	if (matches === null || matches.length % 2 === 0) return undefined;
	const last = segment.lastIndexOf("```");
	return last === -1 ? undefined : last;
}

export function stripCursor(text: string, cursor: string): string {
	return text.endsWith(cursor) ? text.slice(0, text.length - cursor.length) : text;
}
