import type { Doc, DocsSiteConfig, DocsSiteInput } from "./types.js";

export function defineDocsConfig(input: DocsSiteInput): DocsSiteConfig {
	const docs: Doc[] = input.docsMeta.map((meta) => {
		const markdown = input.markdownBySource[meta.source];
		if (markdown === undefined) {
			throw new Error(`No markdown registered for doc source "${meta.source}"`);
		}
		return { ...meta, markdown };
	});

	const defaultDocSlug = input.defaultDocSlug ?? docs[0]?.slug;
	if (!defaultDocSlug) {
		throw new Error("At least one documentation page is required.");
	}

	return {
		site: input.site,
		groups: input.groups,
		docs,
		defaultDocSlug,
	};
}

export function docsBySlug(docs: readonly Doc[]): Map<string, Doc> {
	return new Map(docs.map((doc) => [doc.slug, doc]));
}

export function docsBySource(docs: readonly Doc[]): Map<string, Doc> {
	return new Map(docs.map((doc) => [doc.source.toLowerCase(), doc]));
}
