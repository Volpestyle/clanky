export type DocGroup = string;

export type DocMeta = {
	slug: string;
	title: string;
	description: string;
	source: string;
	group: DocGroup;
};

export type Doc = DocMeta & { markdown: string };

export type DocsLogoConfig = {
	src: string;
	srcSet?: string;
	width?: number;
	height?: number;
	alt?: string;
};

export type DocsLlmsConfig = {
	baseUrl: string;
	title?: string;
	blurb: string;
	excludeGroupsFromFull?: string[];
};

export type DocsSiteLink = {
	id: string;
	label: string;
	href: string;
	description?: string;
	metaLabel?: string;
	parentId?: string;
	relationLabel?: string;
};

export type DocsSiteInfo = {
	id: string;
	title: string;
	description: string;
	badge?: string;
	logo?: DocsLogoConfig;
	llms?: DocsLlmsConfig;
	siteLinks?: DocsSiteLink[];
};

export type DocsSiteConfig = {
	site: DocsSiteInfo;
	groups: DocGroup[];
	docs: Doc[];
	defaultDocSlug: string;
};

export type DocsSiteInput = {
	site: DocsSiteInfo;
	groups: DocGroup[];
	docsMeta: DocMeta[];
	markdownBySource: Record<string, string>;
	defaultDocSlug?: string;
};
