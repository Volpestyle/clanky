import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage"
]);

async function collectTypeScriptModules(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      files.push(...(await collectTypeScriptModules(rootDir, fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;

    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".spec.ts")) continue;
    if (relativePath === "app.ts") continue;

    files.push(fullPath);
  }

  return files;
}

async function main() {
  const srcDir = path.resolve(process.cwd(), "src");
  const modulePaths = await collectTypeScriptModules(srcDir);

  for (const modulePath of modulePaths.sort()) {
    await import(pathToFileURL(modulePath).href);
  }
}

main().catch((error) => {
  console.error("Backend module parse check failed:", error);
  process.exit(1);
});
