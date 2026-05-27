import type { Doc, DocsSiteConfig, DocsSiteInput, DocsSiteLink } from "./types.js";

type ImportMetaWithEnv = ImportMeta & {
	env?: Record<string, string | undefined>;
};

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

	const site = input.site.siteLinks
		? {
				...input.site,
				siteLinks: input.site.siteLinks.map(resolveSiteLinkHref),
			}
		: input.site;

	return {
		site,
		groups: input.groups,
		docs,
		defaultDocSlug,
	};
}

function resolveSiteLinkHref(link: DocsSiteLink): DocsSiteLink {
	const localHref = docsLinkOverride(link.id);
	return localHref ? { ...link, href: localHref } : link;
}

function docsLinkOverride(siteId: string): string | undefined {
	const normalizedId = siteId
		.replace(/-docs$/, "")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	const keys = [`VITE_${normalizedId}_DOCS_URL`, `VITE_DOCS_${normalizedId}_URL`, `DOCS_${normalizedId}_URL`];
	for (const key of keys) {
		const value = runtimeEnv(key);
		if (value) {
			return value;
		}
	}
}

function runtimeEnv(key: string): string | undefined {
	const viteEnv = (import.meta as ImportMetaWithEnv).env;
	return viteEnv?.[key] ?? (typeof process !== "undefined" ? process.env[key] : undefined);
}

export function docsBySlug(docs: readonly Doc[]): Map<string, Doc> {
	return new Map(docs.map((doc) => [doc.slug, doc]));
}

export function docsBySource(docs: readonly Doc[]): Map<string, Doc> {
	return new Map(docs.map((doc) => [doc.source.toLowerCase(), doc]));
}
