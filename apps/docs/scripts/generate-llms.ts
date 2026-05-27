import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DocGroup, type DocMeta, docsMeta } from "../src/docs-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsAppDir = resolve(scriptDir, "..");
const repoRoot = resolve(docsAppDir, "..", "..");
const publicDir = join(docsAppDir, "public");

const baseUrl = (process.env.LLMS_BASE_URL ?? "https://volpestyle.github.io/clanky").replace(/\/$/, "");
const siteTitle = "Clanky";
const siteBlurb =
	"Clanky is a stateful personal AI agent built on the Pi runtime, with Discord text + voice, scoped memory, subagents, and AgentRoom integration.";

const groupOrder: DocGroup[] = ["Start", "Setup", "Reference", "Operations", "Advanced", "Maintainer"];

function urlFor(slug: string): string {
	return `${baseUrl}/?doc=${slug}`;
}

function groupBy(metas: DocMeta[]): Map<DocGroup, DocMeta[]> {
	const map = new Map<DocGroup, DocMeta[]>();
	for (const g of groupOrder) map.set(g, []);
	for (const meta of metas) {
		map.get(meta.group)?.push(meta);
	}
	return map;
}

async function loadMarkdown(meta: DocMeta): Promise<string> {
	const abs = join(repoRoot, meta.source);
	return readFile(abs, "utf8");
}

async function buildLlmsTxt(grouped: Map<DocGroup, DocMeta[]>): Promise<string> {
	const lines: string[] = [];
	lines.push(`# ${siteTitle}`);
	lines.push("");
	lines.push(`> ${siteBlurb}`);
	lines.push("");
	for (const group of groupOrder) {
		const entries = grouped.get(group) ?? [];
		if (entries.length === 0) continue;
		lines.push(`## ${group}`);
		lines.push("");
		for (const meta of entries) {
			lines.push(`- [${meta.title}](${urlFor(meta.slug)}): ${meta.description}`);
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

async function buildLlmsFullTxt(grouped: Map<DocGroup, DocMeta[]>): Promise<string> {
	const sections: string[] = [];
	sections.push(`# ${siteTitle} — Full Docs`);
	sections.push("");
	sections.push(`> ${siteBlurb}`);
	sections.push("");
	sections.push(
		`Generated from the live docs site. Each section below is one page; see the heading and source path for context.`,
	);
	sections.push("");

	for (const group of groupOrder) {
		if (group === "Maintainer") continue;
		const entries = grouped.get(group) ?? [];
		if (entries.length === 0) continue;
		for (const meta of entries) {
			const markdown = await loadMarkdown(meta);
			sections.push("---");
			sections.push("");
			sections.push(`# ${meta.title}`);
			sections.push("");
			sections.push(`Source: \`${meta.source}\` · ${urlFor(meta.slug)}`);
			sections.push("");
			sections.push(markdown.trim());
			sections.push("");
		}
	}
	return `${sections.join("\n").trimEnd()}\n`;
}

async function main(): Promise<void> {
	await mkdir(publicDir, { recursive: true });
	const grouped = groupBy(docsMeta);

	const llmsTxt = await buildLlmsTxt(grouped);
	const llmsFullTxt = await buildLlmsFullTxt(grouped);

	const llmsTxtPath = join(publicDir, "llms.txt");
	const llmsFullPath = join(publicDir, "llms-full.txt");

	await writeFile(llmsTxtPath, llmsTxt, "utf8");
	await writeFile(llmsFullPath, llmsFullTxt, "utf8");

	const fullKb = Math.round((Buffer.byteLength(llmsFullTxt, "utf8") / 1024) * 10) / 10;
	console.log(`wrote ${llmsTxtPath}`);
	console.log(`wrote ${llmsFullPath} (${fullKb} KB)`);
}

await main();
