import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const roots = ["README.md", "docs"];
const files = [];

function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry));
    }
    return;
  }
  if (path.endsWith(".md")) {
    files.push(path);
  }
}

function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

function normalizeLinkTarget(rawTarget) {
  let target = String(rawTarget || "").trim();
  if (!target) return null;

  const titleSuffixMatch = target.match(/^(.*?)(?:\s+["'][^"']*["'])$/);
  if (titleSuffixMatch) {
    target = titleSuffixMatch[1].trim();
  }

  if (
    !target ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#") ||
    target.startsWith("/")
  ) {
    return null;
  }

  target = target.split("#")[0].split("?")[0].trim();
  return target || null;
}

for (const root of roots) {
  walk(root);
}

const broken = [];

for (const file of files) {
  const text = stripFencedCodeBlocks(readFileSync(file, "utf8"));
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matches = line.matchAll(/!?\[[^\]]+\]\(([^)]+)\)/g);
    for (const match of matches) {
      const target = normalizeLinkTarget(match[1]);
      if (!target) continue;
      const resolved = resolve(dirname(file), target);
      if (!existsSync(resolved)) {
        broken.push(`${file}:${index + 1} -> ${match[1]}`);
      }
    }
  }
}

if (broken.length > 0) {
  console.error("Broken local markdown links:");
  for (const entry of broken) {
    console.error(`- ${entry}`);
  }
  process.exit(1);
}

console.log(`Docs links OK (${files.length} markdown files checked).`);
