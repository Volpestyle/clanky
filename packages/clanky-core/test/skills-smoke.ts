import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredSession, SessionRegistry } from "@clanky/core";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-skills-"));
const registry = new SessionRegistry({ homeDir });

try {
	await registry.start();

	const initial = registry.loadSkills();
	const initialNames = new Set(initial.skills.map((skill) => skill.name));
	for (const name of ["swarm-leader", "daily-digest", "linear-bridge", "pi-tui-coder"]) {
		if (!initialNames.has(name)) throw new Error(`Bundled skill ${name} was not loaded`);
	}
	for (const skill of initial.skills.filter((candidate) => initialNames.has(candidate.name))) {
		const content = await readFile(skill.filePath, "utf8");
		if (!content.includes("when_to_use:") || !content.includes("allowed_tools: []") || !content.includes("deps: []")) {
			throw new Error(`Bundled skill ${skill.name} is missing the full Clanky skill metadata shape`);
		}
	}

	const created = await registry.createSkill({
		name: "release-notes",
		description: "Summarize release changes.",
		body: "Write concise release notes from verified changes.",
	});
	if (!created.filePath.endsWith("release-notes/SKILL.md")) {
		throw new Error("Created profile skill had unexpected path");
	}
	const createdContent = await readFile(created.filePath, "utf8");
	if (
		!createdContent.includes('when_to_use: "Summarize release changes."') ||
		!createdContent.includes("allowed_tools: []") ||
		!createdContent.includes("deps: []")
	) {
		throw new Error("Created profile skill did not include the full Clanky skill metadata shape");
	}

	const afterCreate = registry.loadSkills();
	if (!afterCreate.skills.some((skill) => skill.name === "release-notes")) {
		throw new Error("Created profile skill was not visible to the loader");
	}

	registry.setAgentToolHandlers({
		swarmDispatch: async () => ({ ok: true }),
		swarmComplete: async () => ({ ok: true }),
	});
	const activeSession = await registry.createSession({ noTools: "all" });
	const systemPrompt = activeSession.session.systemPrompt;
	if (
		!systemPrompt.includes('<clanky_gateway_skill name="swarm-leader"') ||
		!systemPrompt.includes("Prefer `swarm_dispatch` over native subagents") ||
		!systemPrompt.includes("use `linear_link` to bind") ||
		!systemPrompt.includes("must include either `tracker_update` or `tracker_update_skipped`")
	) {
		throw new Error("Gateway session did not auto-load the swarm-leader skill instructions");
	}
	await activeSession.session.prompt("/skill add command-skill");
	await waitForSessionSkill(activeSession, "command-skill");
	if (!registry.loadSkills().skills.some((skill) => skill.name === "command-skill")) {
		throw new Error("/skill add command-skill did not create a profile-local skill");
	}
	const hotSkillDir = join(registry.paths.profileSkillsDir, "hot-swap");
	await mkdir(hotSkillDir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(hotSkillDir, "SKILL.md"),
		'---\nname: "hot-swap"\ndescription: "Loaded by the skill watcher."\n---\n\n# Hot Swap\n\nReload me.\n',
		{ mode: 0o600 },
	);
	await waitForSessionSkill(activeSession, "hot-swap");

	await registry.recordSkillUsage({ name: "release-notes", source: "smoke", sessionId: "session-1" });
	const usage = await registry.recordSkillUsage({
		name: "release-notes",
		source: "smoke",
		sessionId: "session-1",
		jobId: "job-1",
	});
	if (usage.useCount !== 2 || usage.jobId !== "job-1") {
		throw new Error("Skill usage did not update use count and metadata");
	}

	const removed = await registry.removeSkill("release-notes");
	if (removed === undefined) throw new Error("Profile skill was not removed");
	const afterRemove = registry.loadSkills();
	if (afterRemove.skills.some((skill) => skill.name === "release-notes")) {
		throw new Error("Removed profile skill was still visible to the loader");
	}

	console.log(
		JSON.stringify({
			bundled: initial.skills.length,
			created: created.name,
			hotReloaded: true,
			useCount: usage.useCount,
		}),
	);
} finally {
	await registry.dispose();
	await rm(homeDir, { force: true, recursive: true });
}

async function waitForSessionSkill(session: RegisteredSession, name: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (session.session.resourceLoader.getSkills().skills.some((skill) => skill.name === name)) return;
		await delay(50);
	}
	throw new Error(`Timed out waiting for live session skill reload: ${name}`);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
