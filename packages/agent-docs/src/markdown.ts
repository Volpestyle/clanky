import { marked, type Token, type Tokens } from "marked";

export type Heading = {
	id: string;
	text: string;
	depth: number;
};

const tagPattern = /<[^>]*>/g;
const entityPattern = /&(amp|lt|gt|quot|#39);/g;

const entities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
};

export function stripLeadingTitle(markdown: string) {
	return markdown.replace(/^# .*(?:\r?\n)+/, "");
}

export function extractHeadings(markdown: string) {
	const slugForHeading = createSlugger();
	const tokens = marked.lexer(markdown);
	return tokens.filter(isHeadingToken).flatMap((token) => {
		if (token.depth < 2 || token.depth > 3) {
			return [];
		}

		return [
			{
				id: slugForHeading(token.text),
				text: token.text,
				depth: token.depth,
			},
		];
	});
}

export function parseMarkdown(markdown: string) {
	return marked.lexer(markdown);
}

export function createSlugger() {
	const counters = new Map<string, number>();
	return (value: string) => uniqueSlug(value, counters);
}

function isHeadingToken(token: Token): token is Tokens.Heading {
	return token.type === "heading";
}

function uniqueSlug(value: string, counters: Map<string, number>) {
	const base = slugify(value);
	const count = counters.get(base) ?? 0;
	counters.set(base, count + 1);
	return count === 0 ? base : `${base}-${count + 1}`;
}

function slugify(value: string) {
	const slug = decodeEntities(value)
		.replace(tagPattern, "")
		.toLowerCase()
		.trim()
		.replace(/`/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return slug || "section";
}

function decodeEntities(value: string) {
	return value.replace(entityPattern, (_match, entity: string) => entities[entity] ?? _match);
}
