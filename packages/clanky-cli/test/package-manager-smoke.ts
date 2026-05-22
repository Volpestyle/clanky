import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = process.cwd();
const packageDirs = [rootDir];
for (const entry of await readdir(join(rootDir, "packages"), { withFileTypes: true })) {
	if (entry.isDirectory()) packageDirs.push(join(rootDir, "packages", entry.name));
}

const rootPackage = await readPackageJson(rootDir);
if (rootPackage.private !== true) throw new Error("Root package.json must remain private");
if (rootPackage.type !== "module") throw new Error("Root package.json must use ESM");
const rootVersion = stringProperty(rootPackage, "version", "Root package.json version");
if (rootPackage.dependencies !== undefined)
	throw new Error("Root package.json must remain tooling-only; use package dependencies");
const rootDevDependencies = rootPackage.devDependencies;
if (!isRecord(rootDevDependencies))
	throw new Error("Root package.json must define devDependencies for workspace tooling");
const packageManager = rootPackage.packageManager;
if (packageManager !== "pnpm@10.33.4") {
	throw new Error(`Root package.json must pin pnpm@10.33.4 in packageManager, got ${JSON.stringify(packageManager)}`);
}
const rootEngines = rootPackage.engines;
if (!isRecord(rootEngines) || typeof rootEngines.node !== "string" || !rootEngines.node.startsWith(">=22.")) {
	throw new Error(`Root package.json must pin the Node 22+ runtime, got ${JSON.stringify(rootEngines)}`);
}
const rootScripts = rootPackage.scripts;
if (!isRecord(rootScripts) || typeof rootScripts.check !== "string" || typeof rootScripts.smoke !== "string") {
	throw new Error("Root package.json must define check and smoke scripts");
}
assertIncludes(rootScripts.check, "biome check", "Root check script must run Biome");
assertIncludes(rootScripts.check, "tsgo --noEmit", "Root check script must run tsgo");
assertFullSmokeCoversFocusedSmokes(rootScripts);
if (typeof rootScripts.dev !== "string") throw new Error("Root package.json must define a dev script");
assertIncludes(rootScripts.dev, "tsx watch", "Root dev script must use tsx watch");
assertIncludes(rootScripts.dev, "clanky-cli/src/bin.ts start", "Root dev script must start the Clanky daemon");
const tsconfig = JSON.parse(await readFile(join(rootDir, "tsconfig.json"), "utf8")) as unknown;
if (!isRecord(tsconfig)) throw new Error("tsconfig.json must contain a JSON object");
if (tsconfig.extends !== "./tsconfig.base.json") throw new Error("tsconfig.json must extend tsconfig.base.json");
const tsconfigInclude = tsconfig.include;
if (
	!Array.isArray(tsconfigInclude) ||
	!tsconfigInclude.includes("packages/*/src/**/*.ts") ||
	!tsconfigInclude.includes("packages/*/test/**/*.ts")
) {
	throw new Error("tsconfig.json must typecheck package src and test TypeScript files");
}
const tsconfigBase = JSON.parse(await readFile(join(rootDir, "tsconfig.base.json"), "utf8")) as unknown;
if (!isRecord(tsconfigBase) || !isRecord(tsconfigBase.compilerOptions)) {
	throw new Error("tsconfig.base.json must contain compilerOptions");
}
const compilerOptions = tsconfigBase.compilerOptions;
const requiredCompilerOptions = new Map<string, unknown>([
	["target", "ES2024"],
	["module", "NodeNext"],
	["moduleResolution", "NodeNext"],
	["strict", true],
	["noUncheckedIndexedAccess", true],
	["exactOptionalPropertyTypes", true],
	["allowImportingTsExtensions", true],
	["isolatedModules", true],
	["verbatimModuleSyntax", true],
	["noEmit", true],
]);
for (const [option, expected] of requiredCompilerOptions) {
	if (compilerOptions[option] !== expected) {
		throw new Error(`tsconfig.base.json compilerOptions.${option} must be ${JSON.stringify(expected)}`);
	}
}
if (!existsSync(join(rootDir, "pnpm-lock.yaml"))) {
	throw new Error("pnpm-lock.yaml is required for reproducible installs");
}
const lockfile = await readFile(join(rootDir, "pnpm-lock.yaml"), "utf8");
assertLockfileMatchesPackage(lockfile, ".", rootPackage);
const workspaceConfig = await readFile(join(rootDir, "pnpm-workspace.yaml"), "utf8");
if (!workspaceConfig.includes('"packages/*"')) {
	throw new Error("pnpm-workspace.yaml must include packages/*");
}
assertIncludes(workspaceConfig, "minimumReleaseAge: 1440", "pnpm must delay newly published packages for 24h");
assertIncludes(workspaceConfig, "strictPeerDependencies: true", "pnpm must fail invalid peer dependency installs");
assertIncludes(workspaceConfig, "verifyStoreIntegrity: true", "pnpm must verify package store integrity");
assertIncludes(
	workspaceConfig,
	"onlyBuiltDependencies:",
	"pnpm must use an explicit dependency build-script allowlist",
);
const allowedBuiltDependencies = new Set(["@google/genai", "esbuild", "koffi", "protobufjs"]);
for (const dependency of allowedBuiltDependencies) {
	const workspaceDependencyName = dependency.includes("/") ? `"${dependency}"` : dependency;
	assertIncludes(
		workspaceConfig,
		`  - ${workspaceDependencyName}`,
		`pnpm dependency build-script allowlist must include ${workspaceDependencyName}`,
	);
}
const installScriptDependencies = await collectInstallScriptDependencyNames(join(rootDir, "node_modules", ".pnpm"));
for (const dependency of installScriptDependencies) {
	if (!allowedBuiltDependencies.has(dependency)) {
		throw new Error(`dependency install script is not explicitly allowed in pnpm-workspace.yaml: ${dependency}`);
	}
}
for (const dependency of allowedBuiltDependencies) {
	if (!installScriptDependencies.has(dependency)) {
		throw new Error(
			`pnpm dependency build-script allowlist is stale; no installed install script found for ${dependency}`,
		);
	}
}
for (const bunArtifact of ["bun.lockb", "bunfig.toml"]) {
	if (existsSync(join(rootDir, bunArtifact))) throw new Error(`Bun runtime artifact is not allowed: ${bunArtifact}`);
}
const forbiddenLockfiles = await collectForbiddenLockfiles(rootDir);
if (forbiddenLockfiles.length > 0) {
	throw new Error(`non-pnpm lockfiles are not allowed:\n${forbiddenLockfiles.join("\n")}`);
}
const vendoredPiDirs = await collectVendoredPiDirs(rootDir);
if (vendoredPiDirs.length > 0) {
	throw new Error(`vendored Pi directories are not allowed:\n${vendoredPiDirs.join("\n")}`);
}
const agentInstructions = await readFile(join(rootDir, "AGENTS.md"), "utf8");
assertIncludes(agentInstructions, "Use pnpm only", "AGENTS.md must require pnpm");
assertIncludes(
	agentInstructions,
	"Do not run `npm test`, `npm run build`, or generic npm commands.",
	"AGENTS.md must forbid npm commands",
);
assertIncludes(agentInstructions, "Do not patch or vendor Pi", "AGENTS.md must preserve the Pi package boundary");
assertIncludes(agentInstructions, "Do not reinvent `swarm-mcp`", "AGENTS.md must preserve the swarm boundary");
assertIncludes(agentInstructions, "`clanky-core` owns Pi integration", "AGENTS.md must document core ownership");
assertIncludes(agentInstructions, "`clanky-gateway` owns HTTP", "AGENTS.md must document gateway ownership");
assertIncludes(agentInstructions, "`clanky-swarm` owns `swarm-mcp`", "AGENTS.md must document swarm ownership");
assertIncludes(agentInstructions, "After code changes, run `pnpm check`.", "AGENTS.md must document check gate");
assertIncludes(
	agentInstructions,
	"Do not retry launchd bootstrap for `com.clanky.daemon` without explicit user approval.",
	"AGENTS.md must document launchd approval gate",
);

const expectedPlanModules = new Map([
	["packages/clanky-cli/src/commands/start.ts", "runStart"],
	["packages/clanky-cli/src/commands/status.ts", "runStatus"],
	["packages/clanky-cli/src/commands/stop.ts", "runStop"],
	["packages/clanky-cli/src/commands/install.ts", "runInstall"],
	["packages/clanky-cli/src/commands/send.ts", "runSend"],
	["packages/clanky-cli/src/commands/cron.ts", "runCron"],
	["packages/clanky-cli/src/commands/session.ts", "runSession"],
	["packages/clanky-cli/src/commands/swarm.ts", "runSwarm"],
	["packages/clanky-cli/src/commands/skill.ts", "runSkill"],
	["packages/clanky-cli/src/commands/task.ts", "runTask"],
	["packages/clanky-cli/src/commands/linear.ts", "runLinear"],
	["packages/clanky-cli/src/commands/profile.ts", "runProfile"],
	["packages/clanky-cli/src/commands/mcp.ts", "runMcp"],
	["packages/clanky-cli/src/commands/tui.ts", "runTui"],
	["packages/clanky-cli/src/commands/doctor.ts", "runDoctor"],
	["packages/clanky-core/src/daemon.ts", "startDaemon"],
	["packages/clanky-core/src/cron/scheduler.ts", "export class CronScheduler"],
	["packages/clanky-core/src/cron/jobs.ts", "export class CronJobStore"],
	["packages/clanky-core/src/cron/delivery.ts", "export async function deliverCronOutput"],
	["packages/clanky-core/src/export/session-html.ts", "new Worker"],
	["packages/clanky-core/src/export/session-html-worker.mjs", "Estimated tokens"],
	["packages/clanky-core/src/extension/clanky-ext.ts", 'from "../agent-tools.ts"'],
	["packages/clanky-core/src/profiles.ts", "getActiveProfile"],
	["packages/clanky-core/src/skills/loader.ts", "loadClankySkills"],
	["packages/clanky-core/src/state/index-db.ts", "export class SessionIndexStore"],
	["packages/clanky-core/src/state/sessions.ts", 'from "../session-registry.ts"'],
	["packages/clanky-core/src/skills/injector.ts", "formatSkillPrompt"],
	["packages/clanky-gateway/src/http.ts", "startHttpGateway"],
	["packages/clanky-gateway/src/mcp.ts", "startMcpServer"],
	["packages/clanky-gateway/src/routes/sessions.ts", "registerSessionRoutes"],
	["packages/clanky-gateway/src/routes/cron.ts", "registerCronRoutes"],
	["packages/clanky-gateway/src/routes/swarm.ts", "registerSwarmRoutes"],
	["packages/clanky-gateway/src/ws.ts", "GatewayEventHub"],
	["packages/clanky-swarm/src/client.ts", "SwarmMcpClient"],
	["packages/clanky-swarm/src/complete.ts", "normalizeSwarmCompleteInput"],
	["packages/clanky-swarm/src/dispatch.ts", "normalizeSwarmDispatchInput"],
	["packages/clanky-swarm/src/lifecycle.ts", "SwarmLeader"],
	["packages/clanky-swarm/src/linear.ts", "withLinearTrackerFallback"],
	["packages/clanky-swarm/src/lock-hook.ts", "decideSwarmFileLock"],
	["packages/clanky-swarm/src/message.ts", "normalizeSwarmMessageInput"],
	["packages/clanky-swarm/src/poller.ts", "swarmActivityChanges"],
	["packages/clanky-swarm/src/snapshot.ts", "SwarmSnapshotResult"],
	["packages/clanky-swarm/src/skill/SOUL.md", "swarm_dispatch"],
	["packages/clanky-tui/src/main.ts", "runDashboard"],
	["packages/clanky-tui/src/rpc-client.ts", "RpcChatClient"],
	["packages/clanky-tui/src/views/chat.ts", "runChat"],
	["packages/clanky-tui/src/views/dashboard.ts", "renderDashboard"],
	["packages/clanky-tui/src/views/swarm.ts", "renderSwarmView"],
]);
for (const [relativePath, expectedContent] of expectedPlanModules) {
	const absolutePath = join(rootDir, relativePath);
	if (!existsSync(absolutePath)) throw new Error(`Missing plan-aligned module: ${relativePath}`);
	const content = await readFile(absolutePath, "utf8");
	assertIncludes(content, expectedContent, `Plan-aligned module ${relativePath} must be wired to implementation code`);
}
const indexDbSource = await readFile(join(rootDir, "packages/clanky-core/src/state/index-db.ts"), "utf8");
assertIncludes(indexDbSource, "node:sqlite", "Index DB must use Node's built-in SQLite runtime");
assertIncludes(indexDbSource, "PRAGMA journal_mode = WAL", "Index DB must enable SQLite WAL mode");
assertIncludes(indexDbSource, "USING fts5", "Index DB must create an FTS5 search index");
const httpGatewaySource = await readFile(join(rootDir, "packages/clanky-gateway/src/http.ts"), "utf8");
assertIncludes(httpGatewaySource, 'from "hono"', "HTTP gateway must use Hono");
assertIncludes(httpGatewaySource, 'from "@hono/node-server"', "HTTP gateway must use Hono's Node server adapter");
assertIncludes(httpGatewaySource, "upgradeWebSocket", "HTTP gateway must wire Hono WebSocket upgrades");
assertIncludes(httpGatewaySource, "new Hono", "HTTP gateway must instantiate a Hono app");
const gatewayMcpSource = await readFile(join(rootDir, "packages/clanky-gateway/src/mcp.ts"), "utf8");
assertIncludes(gatewayMcpSource, "McpServer", "Gateway MCP entrypoint must use the MCP SDK server");
assertIncludes(
	gatewayMcpSource,
	"StdioServerTransport",
	"Gateway MCP entrypoint must use the MCP SDK stdio server transport",
);
const swarmMcpClientSource = await readFile(join(rootDir, "packages/clanky-swarm/src/client.ts"), "utf8");
assertIncludes(swarmMcpClientSource, "Client", "Swarm MCP client must use the MCP SDK client");
assertIncludes(
	swarmMcpClientSource,
	"StdioClientTransport",
	"Swarm MCP client must use the MCP SDK stdio client transport",
);
const pathsSource = await readFile(join(rootDir, "packages/clanky-core/src/paths.ts"), "utf8");
assertIncludes(pathsSource, "profile?: string", "Path resolution must expose profile as the tenancy dimension");
assertIncludes(
	pathsSource,
	'join(homeDir, "profiles", profile)',
	"Profile state must resolve under profiles/<profile>",
);
assertNotIncludes(pathsSource, "tenant", "Path resolution must not introduce tenant-level state");
assertNotIncludes(pathsSource, "userId", "Path resolution must not introduce per-user state");
const gatewayProtocolSource = await readFile(join(rootDir, "packages/clanky-gateway/src/protocol.ts"), "utf8");
assertIncludes(gatewayProtocolSource, "profile: string", "Gateway status must expose the active profile");
assertIncludes(gatewayProtocolSource, "profileDir: string", "Gateway status must expose the active profile dir");
assertNotIncludes(gatewayProtocolSource, "tenant", "Gateway protocol must not expose tenant-level state");
assertNotIncludes(gatewayProtocolSource, "userId", "Gateway protocol must not expose per-user state");
const sourceFiles = await collectSourceFiles(join(rootDir, "packages"));
for (const sourceFile of sourceFiles) {
	const source = await readFile(sourceFile, "utf8");
	assertNoUnfinishedMarkers(sourceFile, source);
	if (source.includes("@earendil-works/pi-agent-core")) {
		throw new Error(`Clanky must use published Pi facades, not pi-agent-core directly: ${sourceFile}`);
	}
	if (source.includes("@earendil-works/pi-ai") && !sourceFile.includes("packages/clanky-core/src/")) {
		throw new Error(`Only clanky-core source may use Pi provider runtime APIs: ${sourceFile}`);
	}
	if (source.includes("@earendil-works/pi-tui") && !sourceFile.includes("packages/clanky-tui/src/")) {
		throw new Error(`Only clanky-tui source may use Pi TUI primitives: ${sourceFile}`);
	}
	if (!source.includes("@earendil-works/pi-coding-agent") || sourceFile.includes("packages/clanky-core/src/")) {
		continue;
	}
	const isAllowedRpcTypeImport =
		sourceFile.endsWith("packages/clanky-gateway/src/pi-rpc.ts") ||
		sourceFile.endsWith("packages/clanky-tui/src/rpc-client.ts");
	const hasPiCodingAgentValueImport =
		/(?:^|\n)\s*import\s+(?!type\b)[^;]*\s+from\s+["']@earendil-works\/pi-coding-agent["'];/.test(source) ||
		/(?:^|\n)\s*import\s+["']@earendil-works\/pi-coding-agent["'];/.test(source);
	if (!isAllowedRpcTypeImport || !source.includes("import type ") || hasPiCodingAgentValueImport) {
		throw new Error(
			`Only core may use Pi coding-agent runtime APIs; non-core imports must be RPC type-only: ${sourceFile}`,
		);
	}
}
const checkedTypeScriptFiles = await collectCheckedTypeScriptFiles(join(rootDir, "packages"));
for (const sourceFile of checkedTypeScriptFiles) {
	const source = await readFile(sourceFile, "utf8");
	assertErasableTypeScriptSyntax(sourceFile, source);
}
const bundledSkillFiles = await collectMarkdownFiles(join(rootDir, "skills"));
for (const sourceFile of bundledSkillFiles) {
	const source = await readFile(sourceFile, "utf8");
	assertNoUnfinishedMarkers(sourceFile, source);
}

const expectedPackages = new Map([
	["@clanky/core", "packages/clanky-core"],
	["@clanky/gateway", "packages/clanky-gateway"],
	["@clanky/swarm", "packages/clanky-swarm"],
	["@clanky/tui", "packages/clanky-tui"],
	["@clanky/cli", "packages/clanky-cli"],
]);
const forbiddenV1Packages = new Map([
	["@clanky/telegram", "Telegram adapter is post-v1"],
	["@clanky/discord", "Discord adapter is post-v1"],
	["@clanky/slack", "Slack adapter is post-v1"],
	["@clanky/dataset", "Public dataset publishing is post-v1"],
	["@clanky/web", "Browser web dashboard is post-v1"],
	["@clanky/dashboard", "Browser web dashboard is post-v1; clanky-tui owns the v1 dashboard"],
	["@clanky/skill-archive", "Skill auto-archive is post-v1"],
]);
const allowedWorkspaceDependencies = new Map([
	["@clanky/core", new Set<string>()],
	["@clanky/swarm", new Set<string>()],
	["@clanky/gateway", new Set(["@clanky/core", "@clanky/swarm"])],
	["@clanky/tui", new Set(["@clanky/gateway"])],
	["@clanky/cli", new Set(["@clanky/core", "@clanky/gateway", "@clanky/tui"])],
]);
const requiredPiDependencies = new Map([
	["@clanky/core", new Set(["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"])],
	["@clanky/gateway", new Set(["@earendil-works/pi-coding-agent"])],
	["@clanky/tui", new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"])],
]);
const requiredDevPiDependencies = new Map([
	["@clanky/cli", new Set(["@earendil-works/pi-ai"])],
	["@clanky/gateway", new Set(["@earendil-works/pi-ai"])],
]);
const requiredMcpDependencies = new Map([
	["@clanky/gateway", new Set(["@modelcontextprotocol/sdk"])],
	["@clanky/swarm", new Set(["@modelcontextprotocol/sdk"])],
]);
const requiredPlanRuntimeDependencies = new Map([
	["@clanky/core", new Set(["chokidar"])],
	["@clanky/gateway", new Set(["@hono/node-server", "hono", "ws"])],
	["@clanky/tui", new Set(["ws"])],
]);
const packageNames = new Set<string>();

for (const dir of packageDirs) {
	const packageJson = await readPackageJson(dir);
	assertLockfileMatchesPackage(lockfile, importerNameForDir(dir), packageJson);
	if (dir !== rootDir) {
		const name = stringProperty(packageJson, "name", `${dir}/package.json name`);
		const version = stringProperty(packageJson, "version", `${dir}/package.json version`);
		if (version !== rootVersion) {
			throw new Error(`${name} must use lockstep version ${rootVersion}, got ${version}`);
		}
		packageNames.add(name);
		const forbiddenReason = forbiddenV1Packages.get(name);
		if (forbiddenReason !== undefined) throw new Error(`Unexpected post-v1 package ${name}: ${forbiddenReason}`);
		const expectedDir = expectedPackages.get(name);
		if (expectedDir === undefined) throw new Error(`Unexpected workspace package: ${name}`);
		if (dir !== join(rootDir, expectedDir)) throw new Error(`Workspace package ${name} is in unexpected dir: ${dir}`);
		if (packageJson.private !== true) throw new Error(`${name} must remain private for the v1 workspace`);
		if (packageJson.type !== "module") throw new Error(`${name} must be ESM`);
		assertPackageExport(name, packageJson);
		assertWorkspaceDependencies(name, packageJson, allowedWorkspaceDependencies.get(name) ?? new Set());
		assertPublishedPiDependencies(name, packageJson, requiredPiDependencies.get(name) ?? new Set());
		assertPublishedDevPiDependencies(name, packageJson, requiredDevPiDependencies.get(name) ?? new Set());
		assertPublishedMcpDependencies(name, packageJson, requiredMcpDependencies.get(name) ?? new Set());
		assertPublishedPlanRuntimeDependencies(name, packageJson, requiredPlanRuntimeDependencies.get(name) ?? new Set());
		if (name === "@clanky/cli") assertCliBin(packageJson);
	}
	const scripts = packageJson.scripts;
	if (scripts !== undefined && !isRecord(scripts)) throw new Error(`${dir}/package.json scripts must be an object`);
	if (isRecord(scripts)) {
		for (const [name, command] of Object.entries(scripts)) {
			if (typeof command !== "string") throw new Error(`${dir}/package.json script ${name} must be a string`);
			if (/\b(?:npm|npx)\b/.test(command)) {
				throw new Error(`${dir}/package.json script ${name} must use pnpm, not npm/npx: ${command}`);
			}
			if (/\bbun\b/i.test(command)) {
				throw new Error(`${dir}/package.json script ${name} must use Node/tsx, not Bun: ${command}`);
			}
		}
	}
	for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]) {
		const path = join(dir, lockfile);
		if (existsSync(path)) throw new Error(`non-pnpm lockfile is not allowed: ${path}`);
	}
	const dependencies = packageJson.dependencies;
	if (isRecord(dependencies) && "better-sqlite3" in dependencies) {
		throw new Error(`${dir}/package.json must use node:sqlite instead of a direct better-sqlite3 dependency`);
	}
	if (isRecord(dependencies) && "bun" in dependencies) {
		throw new Error(`${dir}/package.json must not depend on Bun for the Clanky runtime`);
	}
}
for (const name of expectedPackages.keys()) {
	if (!packageNames.has(name)) throw new Error(`Missing workspace package: ${name}`);
}

console.log(
	JSON.stringify({
		packageManager,
		version: rootVersion,
		packagesChecked: packageDirs.length,
		workspacePackages: packageNames.size,
		pnpmLock: true,
	}),
);

async function readPackageJson(dir: string): Promise<Record<string, unknown>> {
	const path = join(dir, "package.json");
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
	return parsed;
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSourceFiles(path)));
		} else if (entry.isFile() && path.includes("/src/") && path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

async function collectCheckedTypeScriptFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectCheckedTypeScriptFiles(path)));
		} else if (entry.isFile() && path.endsWith(".ts") && (path.includes("/src/") || path.includes("/test/"))) {
			files.push(path);
		}
	}
	return files;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownFiles(path)));
		} else if (entry.isFile() && path.endsWith(".md")) {
			files.push(path);
		}
	}
	return files;
}

async function collectForbiddenLockfiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectForbiddenLockfiles(path)));
		} else if (
			entry.isFile() &&
			(entry.name === "package-lock.json" ||
				entry.name === "npm-shrinkwrap.json" ||
				entry.name === "yarn.lock" ||
				entry.name === "bun.lockb" ||
				entry.name === "bunfig.toml")
		) {
			files.push(path);
		}
	}
	return files;
}

async function collectVendoredPiDirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const dirs: string[] = [];
	const forbiddenNames = new Set(["pi", "pi-mono", "pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]);
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		if (forbiddenNames.has(entry.name)) {
			dirs.push(path);
			continue;
		}
		dirs.push(...(await collectVendoredPiDirs(path)));
	}
	return dirs;
}

async function collectInstallScriptDependencyNames(dir: string): Promise<Set<string>> {
	const packageJsonFiles = await collectPackageJsonFiles(dir);
	const dependencyNames = new Set<string>();
	for (const packageJsonFile of packageJsonFiles) {
		const parsed = JSON.parse(await readFile(packageJsonFile, "utf8")) as unknown;
		if (!isRecord(parsed)) continue;
		const name = parsed.name;
		if (typeof name !== "string" || name.length === 0) continue;
		const scripts = parsed.scripts;
		if (!isRecord(scripts)) continue;
		for (const scriptName of ["preinstall", "install", "postinstall"]) {
			if (typeof scripts[scriptName] === "string") dependencyNames.add(name);
		}
	}
	return dependencyNames;
}

async function collectPackageJsonFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectPackageJsonFiles(path)));
		} else if (entry.isFile() && entry.name === "package.json") {
			files.push(path);
		}
	}
	return files;
}

function assertNoUnfinishedMarkers(sourceFile: string, source: string): void {
	const bannedPatterns = [
		{ pattern: /\bTODO\b/, message: "TODO marker is not allowed in implementation artifacts" },
		{ pattern: /\bFIXME\b/, message: "FIXME marker is not allowed in implementation artifacts" },
		{ pattern: /\bstub\b/i, message: "stub marker is not allowed in implementation artifacts" },
		{ pattern: /\bplaceholder\b/i, message: "placeholder marker is not allowed in implementation artifacts" },
		{ pattern: /\bnot implemented\b/i, message: "not implemented marker is not allowed in implementation artifacts" },
		{ pattern: /throw new Error\(["'`](?:TODO|Not implemented)/, message: "unfinished throw marker is not allowed" },
	];
	for (const { pattern, message } of bannedPatterns) {
		if (pattern.test(source)) throw new Error(`${message}: ${sourceFile}`);
	}
}

function assertErasableTypeScriptSyntax(sourceFile: string, source: string): void {
	const bannedPatterns = [
		{ pattern: /:\s*any\b/, message: "explicit any type annotations are not allowed" },
		{ pattern: /\bas\s+any\b/, message: "any casts are not allowed" },
		{ pattern: /<\s*any\s*>/, message: "angle-bracket any casts are not allowed" },
		{
			pattern: /\b(?:Array|Promise|ReadonlyArray|Set|Map|Record)<[^>\n]*\bany\b/,
			message: "generic any types are not allowed",
		},
		{ pattern: /\bimport\s*\(/, message: "dynamic or inline imports are not allowed" },
		{ pattern: /^\s*(?:export\s+)?enum\s+/m, message: "TypeScript enum declarations are not erasable" },
		{ pattern: /^\s*(?:export\s+)?namespace\s+/m, message: "TypeScript namespace declarations are not erasable" },
		{ pattern: /^\s*(?:declare\s+)?module\s+["']/m, message: "TypeScript module declarations are not erasable" },
		{ pattern: /\bimport\s+\w+\s*=/, message: "import equals syntax is not erasable" },
		{ pattern: /\bexport\s*=/, message: "export equals syntax is not erasable" },
		{
			pattern: /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w+/,
			message: "constructor parameter properties are not erasable",
		},
	];
	for (const { pattern, message } of bannedPatterns) {
		if (pattern.test(source)) throw new Error(`${message}: ${sourceFile}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIncludes(value: string, expected: string, message: string): void {
	if (!value.includes(expected)) throw new Error(`${message}: missing ${expected}`);
}

function assertNotIncludes(value: string, unexpected: string, message: string): void {
	if (value.includes(unexpected)) throw new Error(`${message}: found ${unexpected}`);
}

function assertFullSmokeCoversFocusedSmokes(rootScripts: Record<string, unknown>): void {
	const smoke = rootScripts.smoke;
	if (typeof smoke !== "string") throw new Error("Root smoke script must be a string");
	for (const [name, command] of Object.entries(rootScripts)) {
		if (!name.startsWith("smoke:")) continue;
		if (typeof command !== "string") throw new Error(`Root script ${name} must be a string`);
		if (!smoke.includes(`pnpm ${name}`)) throw new Error(`Root smoke script must include ${name}`);
	}
}

function assertLockfileMatchesPackage(lockfile: string, importer: string, packageJson: Record<string, unknown>): void {
	const block = lockfileImporterBlock(lockfile, importer);
	for (const key of ["dependencies", "devDependencies"] as const) {
		const manifestNames = dependencyNames(packageJson, key);
		const lockfileNames = lockfileDependencyNames(block, key);
		for (const dependency of manifestNames) {
			if (!lockfileNames.has(dependency)) {
				throw new Error(`Lockfile importer ${importer} ${key} must include ${dependency}`);
			}
		}
		for (const dependency of lockfileNames) {
			if (!manifestNames.has(dependency)) {
				throw new Error(`Lockfile importer ${importer} has stale ${key} entry: ${dependency}`);
			}
		}
	}
}

function lockfileImporterBlock(lockfile: string, importer: string): string {
	const startMarker = `\n  ${importer}:\n`;
	const start = lockfile.indexOf(startMarker);
	if (start === -1) throw new Error(`pnpm-lock.yaml is missing importer: ${importer}`);
	const blockStart = start + startMarker.length;
	const end = lockfile.indexOf("\n  packages/", blockStart);
	const nextImporter = lockfile.slice(blockStart).search(/\n {2}[^ \n][^:\n]*:\n/);
	if (nextImporter === -1) return end === -1 ? lockfile.slice(blockStart) : lockfile.slice(blockStart, end);
	const importerEnd = blockStart + nextImporter;
	if (end !== -1 && end < importerEnd) return lockfile.slice(blockStart, end);
	return lockfile.slice(blockStart, importerEnd);
}

function lockfileDependencyBlock(importerBlock: string, key: "dependencies" | "devDependencies"): string {
	const marker = `    ${key}:\n`;
	const start = importerBlock.indexOf(marker);
	if (start === -1) return "";
	const blockStart = start + marker.length;
	const nextSection = importerBlock.slice(blockStart).search(/\n {4}[^ \n][^:\n]*:\n/);
	if (nextSection === -1) return importerBlock.slice(blockStart);
	return importerBlock.slice(blockStart, blockStart + nextSection);
}

function lockfileDependencyNames(importerBlock: string, key: "dependencies" | "devDependencies"): Set<string> {
	const block = lockfileDependencyBlock(importerBlock, key);
	const names = new Set<string>();
	for (const match of block.matchAll(/^ {6}(?:'([^']+)'|([^ :\n][^:\n]*)):/gm)) {
		const name = match[1] ?? match[2];
		if (name !== undefined) names.add(name);
	}
	return names;
}

function dependencyNames(packageJson: Record<string, unknown>, key: "dependencies" | "devDependencies"): Set<string> {
	const dependencies = packageJson[key];
	if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`package.json ${key} must be an object`);
	return new Set(isRecord(dependencies) ? Object.keys(dependencies) : []);
}

function importerNameForDir(dir: string): string {
	if (dir === rootDir) return ".";
	return `packages/${dir.slice(join(rootDir, "packages").length + 1)}`;
}

function stringProperty(value: Record<string, unknown>, key: string, label: string): string {
	const property = value[key];
	if (typeof property !== "string" || property.length === 0) throw new Error(`${label} must be a non-empty string`);
	return property;
}

function assertPackageExport(name: string, packageJson: Record<string, unknown>): void {
	const exportsValue = packageJson.exports;
	if (!isRecord(exportsValue)) throw new Error(`${name} must define package exports`);
	const rootExport = exportsValue["."];
	if (!isRecord(rootExport)) throw new Error(`${name} must export "."`);
	if (rootExport.types !== "./src/index.ts" && !(name === "@clanky/cli" && rootExport.types === "./src/bin.ts")) {
		throw new Error(`${name} must export source types`);
	}
	if (rootExport.import !== "./src/index.ts" && !(name === "@clanky/cli" && rootExport.import === "./src/bin.ts")) {
		throw new Error(`${name} must export source import entry`);
	}
}

function assertWorkspaceDependencies(
	name: string,
	packageJson: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): void {
	const dependencies = packageJson.dependencies;
	if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`${name} dependencies must be an object`);
	if (!isRecord(dependencies)) return;
	for (const dependency of Object.keys(dependencies)) {
		if (!dependency.startsWith("@clanky/")) continue;
		if (!allowed.has(dependency)) {
			throw new Error(`${name} has disallowed workspace dependency: ${dependency}`);
		}
		if (dependencies[dependency] !== "workspace:*") {
			throw new Error(`${name} dependency ${dependency} must use workspace:*`);
		}
	}
}

function assertPublishedPiDependencies(
	name: string,
	packageJson: Record<string, unknown>,
	required: ReadonlySet<string>,
): void {
	const dependencies = packageJson.dependencies;
	if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`${name} dependencies must be an object`);
	if (!isRecord(dependencies)) {
		if (required.size > 0) throw new Error(`${name} is missing required Pi dependencies`);
		return;
	}
	for (const dependency of required) {
		if (!(dependency in dependencies)) throw new Error(`${name} is missing required Pi dependency: ${dependency}`);
	}
	for (const [dependency, version] of Object.entries(dependencies)) {
		if (!dependency.startsWith("@earendil-works/pi-")) continue;
		if (!required.has(dependency)) {
			throw new Error(`${name} has unexpected production Pi dependency: ${dependency}`);
		}
		if (typeof version !== "string") throw new Error(`${name} dependency ${dependency} must use a string version`);
		if (/^(?:workspace:|file:|link:|\/|\.\.\/)/.test(version)) {
			throw new Error(`${name} dependency ${dependency} must use a published package version, not ${version}`);
		}
		if (!/^\^?\d+\.\d+\.\d+/.test(version)) {
			throw new Error(`${name} dependency ${dependency} must use a semver package range, got ${version}`);
		}
	}
}

function assertPublishedDevPiDependencies(
	name: string,
	packageJson: Record<string, unknown>,
	required: ReadonlySet<string>,
): void {
	const devDependencies = packageJson.devDependencies;
	if (devDependencies !== undefined && !isRecord(devDependencies)) {
		throw new Error(`${name} devDependencies must be an object`);
	}
	if (!isRecord(devDependencies)) {
		if (required.size > 0) throw new Error(`${name} is missing required test-only Pi dependencies`);
		return;
	}
	for (const dependency of required) {
		if (!(dependency in devDependencies))
			throw new Error(`${name} is missing required test-only Pi dependency: ${dependency}`);
	}
	for (const [dependency, version] of Object.entries(devDependencies)) {
		if (!dependency.startsWith("@earendil-works/pi-")) continue;
		if (!required.has(dependency)) {
			throw new Error(`${name} has unexpected test-only Pi dependency: ${dependency}`);
		}
		if (typeof version !== "string") throw new Error(`${name} devDependency ${dependency} must use a string version`);
		if (/^(?:workspace:|file:|link:|\/|\.\.\/)/.test(version)) {
			throw new Error(`${name} devDependency ${dependency} must use a published package version, not ${version}`);
		}
		if (!/^\^?\d+\.\d+\.\d+/.test(version)) {
			throw new Error(`${name} devDependency ${dependency} must use a semver package range, got ${version}`);
		}
	}
}

function assertPublishedMcpDependencies(
	name: string,
	packageJson: Record<string, unknown>,
	required: ReadonlySet<string>,
): void {
	const dependencies = packageJson.dependencies;
	if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`${name} dependencies must be an object`);
	if (!isRecord(dependencies)) {
		if (required.size > 0) throw new Error(`${name} is missing required MCP SDK dependencies`);
		return;
	}
	for (const dependency of required) {
		if (!(dependency in dependencies)) throw new Error(`${name} is missing required MCP SDK dependency: ${dependency}`);
	}
	const version = dependencies["@modelcontextprotocol/sdk"];
	if (version === undefined) return;
	if (typeof version !== "string") throw new Error(`${name} @modelcontextprotocol/sdk dependency must be a string`);
	if (/^(?:workspace:|file:|link:|\/|\.\.\/)/.test(version)) {
		throw new Error(
			`${name} @modelcontextprotocol/sdk dependency must use a published package version, not ${version}`,
		);
	}
	if (!/^\^?\d+\.\d+\.\d+/.test(version)) {
		throw new Error(`${name} @modelcontextprotocol/sdk dependency must use a semver package range, got ${version}`);
	}
}

function assertPublishedPlanRuntimeDependencies(
	name: string,
	packageJson: Record<string, unknown>,
	required: ReadonlySet<string>,
): void {
	const dependencies = packageJson.dependencies;
	if (dependencies !== undefined && !isRecord(dependencies)) throw new Error(`${name} dependencies must be an object`);
	if (!isRecord(dependencies)) {
		if (required.size > 0) throw new Error(`${name} is missing required plan runtime dependencies`);
		return;
	}
	for (const dependency of required) {
		const version = dependencies[dependency];
		if (version === undefined) throw new Error(`${name} is missing required plan runtime dependency: ${dependency}`);
		if (typeof version !== "string") throw new Error(`${name} dependency ${dependency} must use a string version`);
		if (/^(?:workspace:|file:|link:|\/|\.\.\/)/.test(version)) {
			throw new Error(`${name} dependency ${dependency} must use a published package version, not ${version}`);
		}
		if (!/^\^?\d+\.\d+\.\d+/.test(version)) {
			throw new Error(`${name} dependency ${dependency} must use a semver package range, got ${version}`);
		}
	}
}

function assertCliBin(packageJson: Record<string, unknown>): void {
	const bin = packageJson.bin;
	if (!isRecord(bin)) throw new Error("@clanky/cli must expose a bin map");
	if (bin.clanky !== "./src/bin.ts") throw new Error("@clanky/cli bin must point clanky to ./src/bin.ts");
}
