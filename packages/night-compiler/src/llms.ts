import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocGroup, DocMeta, DocsLlmsConfig } from "./types.js";

export type GenerateLlmsFilesOptions = {
	docsMeta: DocMeta[];
	groups: DocGroup[];
	llms: DocsLlmsConfig;
	repoRoot: string;
	publicDir: string;
};

export async function generateLlmsFiles({
	docsMeta,
	groups,
	llms,
	repoRoot,
	publicDir,
}: GenerateLlmsFilesOptions): Promise<void> {
	await mkdir(publicDir, { recursive: true });
	const grouped = groupBy(docsMeta, groups);

	const llmsTxt = await buildLlmsTxt(grouped, groups, llms);
	const llmsFullTxt = await buildLlmsFullTxt(grouped, groups, llms, repoRoot);

	const llmsTxtPath = join(publicDir, "llms.txt");
	const llmsFullPath = join(publicDir, "llms-full.txt");

	await writeFile(llmsTxtPath, llmsTxt, "utf8");
	await writeFile(llmsFullPath, llmsFullTxt, "utf8");

	const fullKb = Math.round((Buffer.byteLength(llmsFullTxt, "utf8") / 1024) * 10) / 10;
	console.log(`wrote ${llmsTxtPath}`);
	console.log(`wrote ${llmsFullPath} (${fullKb} KB)`);
}

function urlFor(baseUrl: string, slug: string): string {
	return `${baseUrl.replace(/\/$/, "")}/?doc=${slug}`;
}

function groupBy(metas: DocMeta[], groupOrder: DocGroup[]): Map<DocGroup, DocMeta[]> {
	const map = new Map<DocGroup, DocMeta[]>();
	for (const group of groupOrder) {
		map.set(group, []);
	}
	for (const meta of metas) {
		if (!map.has(meta.group)) {
			map.set(meta.group, []);
		}
		map.get(meta.group)?.push(meta);
	}
	return map;
}

async function loadMarkdown(repoRoot: string, meta: DocMeta): Promise<string> {
	return readFile(join(repoRoot, meta.source), "utf8");
}

async function buildLlmsTxt(
	grouped: Map<DocGroup, DocMeta[]>,
	groupOrder: DocGroup[],
	llms: DocsLlmsConfig,
): Promise<string> {
	const lines: string[] = [];
	lines.push(`# ${llms.title ?? "Documentation"}`);
	lines.push("");
	lines.push(`> ${llms.blurb}`);
	lines.push("");
	for (const group of groupOrder) {
		const entries = grouped.get(group) ?? [];
		if (entries.length === 0) continue;
		lines.push(`## ${group}`);
		lines.push("");
		for (const meta of entries) {
			lines.push(`- [${meta.title}](${urlFor(llms.baseUrl, meta.slug)}): ${meta.description}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

async function buildLlmsFullTxt(
	grouped: Map<DocGroup, DocMeta[]>,
	groupOrder: DocGroup[],
	llms: DocsLlmsConfig,
	repoRoot: string,
): Promise<string> {
	const excluded = new Set(llms.excludeGroupsFromFull ?? []);
	const sections: string[] = [];
	sections.push(`# ${llms.title ?? "Documentation"} - Full Docs`);
	sections.push("");
	sections.push(`> ${llms.blurb}`);
	sections.push("");
	sections.push(
		"Generated from the live docs site. Each section below is one page; see the heading and source path for context.",
	);
	sections.push("");

	for (const group of groupOrder) {
		if (excluded.has(group)) continue;
		const entries = grouped.get(group) ?? [];
		if (entries.length === 0) continue;
		for (const meta of entries) {
			const markdown = await loadMarkdown(repoRoot, meta);
			sections.push("---");
			sections.push("");
			sections.push(`# ${meta.title}`);
			sections.push("");
			sections.push(`Source: \`${meta.source}\` - ${urlFor(llms.baseUrl, meta.slug)}`);
			sections.push("");
			sections.push(markdown.trim());
			sections.push("");
		}
	}
	return `${sections.join("\n").trimEnd()}\n`;
}
