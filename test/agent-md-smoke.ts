import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAgentMdInstructions,
	collectAgentMdFiles,
	parseAgentMdToggle,
} from "../agent/lib/agent-md.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = await mkdtemp(join(tmpdir(), "clanky-agent-md-"));
try {
	const project = join(tempRoot, "project");
	const packageDir = join(project, "packages", "app");
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(tempRoot, "AGENTS.md"), "home rules\n", "utf8");
	await writeFile(join(project, "agent.md"), "project rules\n", "utf8");
	await writeFile(join(packageDir, "AGENTS.md"), "app rules\n", "utf8");
	await writeFile(join(packageDir, "empty.md"), "", "utf8");

	const files = await collectAgentMdFiles({ root: packageDir });
	assert(files.length === 3, `expected three agent files, got ${files.length}`);
	assert(files[0]?.path === join(tempRoot, "AGENTS.md"), "parent-most file should load first");
	assert(files[1]?.path === join(project, "agent.md"), "middle project file should load second");
	assert(files[2]?.path === join(packageDir, "AGENTS.md"), "leaf project file should load last");

	const fromFileRoot = await collectAgentMdFiles({ root: join(packageDir, "index.ts") });
	assert(fromFileRoot.map((file) => file.path).join("\n") === files.map((file) => file.path).join("\n"), "file roots should scan from their containing directory");

	const markdown = buildAgentMdInstructions(files);
	const homeIndex = markdown.indexOf("home rules");
	const projectIndex = markdown.indexOf("project rules");
	const appIndex = markdown.indexOf("app rules");
	assert(homeIndex !== -1 && projectIndex !== -1 && appIndex !== -1, "formatted instructions should include all files");
	assert(homeIndex < projectIndex && projectIndex < appIndex, "formatted instructions should preserve parent-to-leaf order");

	assert(parseAgentMdToggle("on") === true, "on should enable ingestion");
	assert(parseAgentMdToggle("enabled") === true, "enabled should enable ingestion");
	assert(parseAgentMdToggle("0") === false, "0 should disable ingestion");
	assert(parseAgentMdToggle("maybe") === undefined, "unknown values should not parse");
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

console.log("agent-md-smoke: ok");
