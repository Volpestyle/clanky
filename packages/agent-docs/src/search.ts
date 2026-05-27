import type { Token, Tokens } from "marked";

import { createSlugger, parseMarkdown } from "./markdown.js";
import type { Doc } from "./types.js";

export type SearchSection = {
	docSlug: string;
	docTitle: string;
	docGroup: Doc["group"];
	docSource: string;
	headingId: string | null;
	headingPath: string[];
	headingDepth: number;
	text: string;
	textLower: string;
};

export type MatchRange = { start: number; end: number };

export type SearchMatch = {
	section: SearchSection;
	score: number;
	titleRanges: MatchRange[];
	headingRanges: MatchRange[];
	snippet: string;
	snippetRanges: MatchRange[];
};

const MAX_SNIPPET_LENGTH = 180;

export type DocsSearch = (rawQuery: string, limit?: number) => SearchMatch[];

export function createDocsSearch(docs: readonly Doc[]): DocsSearch {
	const sections = buildIndex(docs);
	return (rawQuery: string, limit = 30) => searchSections(sections, rawQuery, limit);
}

function searchSections(sections: SearchSection[], rawQuery: string, limit = 30): SearchMatch[] {
	const tokens = tokenize(rawQuery);
	if (tokens.length === 0) {
		return [];
	}

	const queryLower = rawQuery.trim().toLowerCase();
	const matches: SearchMatch[] = [];

	for (const section of sections) {
		const titleLower = section.docTitle.toLowerCase();
		const headingText = section.headingPath.join(" › ");
		const headingLower = headingText.toLowerCase();

		const titleRanges: MatchRange[] = [];
		const headingRanges: MatchRange[] = [];
		const bodyRanges: MatchRange[] = [];

		let score = 0;
		let allMatched = true;

		for (const token of tokens) {
			const inTitle = findRanges(titleLower, token);
			const inHeading = findRanges(headingLower, token);
			const inBody = findRanges(section.textLower, token);

			if (inTitle.length === 0 && inHeading.length === 0 && inBody.length === 0) {
				allMatched = false;
				break;
			}

			if (inTitle.length > 0) {
				titleRanges.push(...inTitle);
				score += 120;
				if (titleLower.startsWith(token)) {
					score += 60;
				}
			}

			if (inHeading.length > 0) {
				headingRanges.push(...inHeading);
				score += section.headingDepth === 0 ? 100 : 70;
				if (headingLower.startsWith(token)) {
					score += 30;
				}
			}

			if (inBody.length > 0) {
				bodyRanges.push(...inBody);
				score += 6 + Math.min(inBody.length, 5) * 2;
			}
		}

		if (!allMatched) {
			continue;
		}

		if (queryLower.length > 1) {
			if (titleLower.includes(queryLower)) {
				score += 200;
			}
			if (headingLower.includes(queryLower)) {
				score += 120;
			}
			if (section.textLower.includes(queryLower)) {
				score += 40;
			}
		}

		if (section.headingDepth === 0) {
			score += 20;
		}

		const { snippet, ranges: snippetRanges } = buildSnippet(section.text, tokens, bodyRanges);

		matches.push({
			section,
			score,
			titleRanges: mergeRanges(titleRanges),
			headingRanges: mergeRanges(headingRanges),
			snippet,
			snippetRanges,
		});
	}

	matches.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		if (a.section.headingDepth !== b.section.headingDepth) {
			return a.section.headingDepth - b.section.headingDepth;
		}
		return a.section.docTitle.localeCompare(b.section.docTitle);
	});

	return matches.slice(0, limit);
}

export function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

export function highlightSegments(text: string, ranges: MatchRange[]): Array<{ text: string; highlight: boolean }> {
	if (ranges.length === 0) {
		return [{ text, highlight: false }];
	}

	const merged = mergeRanges(ranges);
	const segments: Array<{ text: string; highlight: boolean }> = [];
	let cursor = 0;

	for (const range of merged) {
		if (range.start > cursor) {
			segments.push({ text: text.slice(cursor, range.start), highlight: false });
		}
		segments.push({ text: text.slice(range.start, range.end), highlight: true });
		cursor = range.end;
	}

	if (cursor < text.length) {
		segments.push({ text: text.slice(cursor), highlight: false });
	}

	return segments;
}

function buildIndex(allDocs: readonly Doc[]): SearchSection[] {
	const result: SearchSection[] = [];

	for (const doc of allDocs) {
		const sectionsForDoc = sectionsFromDoc(doc);
		result.push(...sectionsForDoc);
	}

	return result;
}

function sectionsFromDoc(doc: Doc): SearchSection[] {
	const tokens = parseMarkdown(doc.markdown);
	const slugForHeading = createSlugger();

	const result: SearchSection[] = [];

	const headingStack: Array<{ text: string; depth: number; id: string }> = [];
	let currentSection: { headingId: string | null; depth: number; path: string[]; lines: string[] } = {
		headingId: null,
		depth: 0,
		path: [doc.title],
		lines: [doc.description],
	};

	function flush() {
		const text = currentSection.lines.join(" ").replace(/\s+/g, " ").trim();
		if (!text && currentSection.headingId === null) {
			return;
		}
		result.push({
			docSlug: doc.slug,
			docTitle: doc.title,
			docGroup: doc.group,
			docSource: doc.source,
			headingId: currentSection.headingId,
			headingPath: currentSection.path,
			headingDepth: currentSection.depth,
			text: text || doc.description,
			textLower: (text || doc.description).toLowerCase(),
		});
	}

	for (const token of tokens) {
		if (token.type === "heading") {
			const heading = token as Tokens.Heading;
			if (heading.depth === 1) {
				continue;
			}

			flush();

			const headingText = inlineText(heading.tokens ?? []);
			const id = slugForHeading(headingText);

			while (headingStack.length > 0) {
				const lastHeading = headingStack[headingStack.length - 1];
				if (!lastHeading || lastHeading.depth < heading.depth) {
					break;
				}
				headingStack.pop();
			}
			headingStack.push({ text: headingText, depth: heading.depth, id });

			currentSection = {
				headingId: id,
				depth: heading.depth - 1,
				path: [doc.title, ...headingStack.map((entry) => entry.text)],
				lines: [],
			};
		} else {
			const text = textFromBlock(token);
			if (text) {
				currentSection.lines.push(text);
			}
		}
	}

	flush();

	return result;
}

function textFromBlock(token: Token): string {
	switch (token.type) {
		case "paragraph":
			return inlineText((token as Tokens.Paragraph).tokens ?? []);
		case "blockquote":
			return (token as Tokens.Blockquote).tokens.map(textFromBlock).filter(Boolean).join(" ");
		case "list":
			return (token as Tokens.List).items
				.map((item) => item.tokens.map(textFromBlock).filter(Boolean).join(" "))
				.join(" ");
		case "code":
			return (token as Tokens.Code).text;
		case "table": {
			const table = token as Tokens.Table;
			const headerText = table.header.map((cell) => cell.text).join(" ");
			const rowText = table.rows.map((row) => row.map((cell) => cell.text).join(" ")).join(" ");
			return `${headerText} ${rowText}`;
		}
		case "html":
			return (token as Tokens.HTML).text.replace(/<[^>]+>/g, " ");
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? inlineText(text.tokens) : text.text;
		}
		default:
			return "";
	}
}

function inlineText(tokens: Token[]): string {
	return tokens
		.map((token) => {
			switch (token.type) {
				case "text":
					return (token as Tokens.Text).tokens
						? inlineText((token as Tokens.Text).tokens ?? [])
						: (token as Tokens.Text).text;
				case "codespan":
					return (token as Tokens.Codespan).text;
				case "strong":
					return inlineText((token as Tokens.Strong).tokens);
				case "em":
					return inlineText((token as Tokens.Em).tokens);
				case "del":
					return inlineText((token as Tokens.Del).tokens);
				case "link":
					return inlineText((token as Tokens.Link).tokens);
				case "image":
					return (token as Tokens.Image).text ?? "";
				case "br":
					return " ";
				case "escape":
					return (token as Tokens.Escape).text;
				default:
					return "";
			}
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function findRanges(haystack: string, needle: string): MatchRange[] {
	if (!needle) {
		return [];
	}

	const ranges: MatchRange[] = [];
	let from = 0;

	while (from <= haystack.length) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) {
			break;
		}
		ranges.push({ start: index, end: index + needle.length });
		from = index + Math.max(needle.length, 1);
	}

	return ranges;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
	if (ranges.length === 0) {
		return ranges;
	}

	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const first = sorted[0];
	if (!first) {
		return [];
	}

	const merged: MatchRange[] = [first];

	for (const next of sorted.slice(1)) {
		const last = merged[merged.length - 1];
		if (!last) {
			merged.push(next);
			continue;
		}
		if (next.start <= last.end) {
			last.end = Math.max(last.end, next.end);
		} else {
			merged.push(next);
		}
	}

	return merged;
}

function buildSnippet(
	text: string,
	tokens: string[],
	bodyRanges: MatchRange[],
): { snippet: string; ranges: MatchRange[] } {
	if (!text) {
		return { snippet: "", ranges: [] };
	}

	if (bodyRanges.length === 0) {
		const snippet = text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}…` : text;
		return { snippet, ranges: [] };
	}

	const allRanges = mergeRanges(bodyRanges);
	const bestWindow = pickBestWindow(allRanges, text.length);

	let start = expandToWordBoundary(text, bestWindow.start, -1);
	let end = expandToWordBoundary(text, bestWindow.end, 1);
	if (end > text.length) end = text.length;
	if (start < 0) start = 0;

	const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
	const prefix = start > 0 ? "… " : "";
	const suffix = end < text.length ? " …" : "";
	const snippet = `${prefix}${slice}${suffix}`;

	const snippetLower = snippet.toLowerCase();
	const ranges: MatchRange[] = [];
	for (const token of tokens) {
		for (const range of findRanges(snippetLower, token)) {
			ranges.push(range);
		}
	}

	return { snippet, ranges: mergeRanges(ranges) };
}

function pickBestWindow(ranges: MatchRange[], textLength: number): MatchRange {
	const halfWindow = Math.floor(MAX_SNIPPET_LENGTH / 2);
	const first = ranges[0];
	if (!first) {
		return { start: 0, end: Math.min(textLength, MAX_SNIPPET_LENGTH) };
	}

	let bestCount = 0;
	let bestStart = Math.max(0, first.start - halfWindow);

	for (const range of ranges) {
		const windowStart = Math.max(0, range.start - halfWindow);
		const windowEnd = Math.min(textLength, windowStart + MAX_SNIPPET_LENGTH);
		let count = 0;
		for (const other of ranges) {
			if (other.start >= windowStart && other.end <= windowEnd) {
				count += 1;
			}
		}
		if (count > bestCount) {
			bestCount = count;
			bestStart = windowStart;
		}
	}

	const start = bestStart;
	const end = Math.min(textLength, start + MAX_SNIPPET_LENGTH);
	return { start, end };
}

function expandToWordBoundary(text: string, index: number, direction: 1 | -1): number {
	if (index <= 0) return 0;
	if (index >= text.length) return text.length;

	const limit = direction === 1 ? Math.min(text.length, index + 20) : Math.max(0, index - 20);
	let cursor = index;
	while (cursor !== limit) {
		const char = text[cursor];
		if (!char) {
			break;
		}
		if (char === " " || char === "\n" || char === "\t") {
			return cursor;
		}
		cursor += direction;
	}
	return index;
}
