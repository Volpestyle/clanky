import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listClankySkills } from "../agent/lib/skill-inventory.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repo = await mkdtemp(join(tmpdir(), "clanky-skills-"));

try {
	await mkdir(join(repo, "agent", "skills"), { recursive: true });
	await mkdir(join(repo, "skills", "clanky-operator"), { recursive: true });

	await writeFile(
		join(repo, "agent", "skills", "coding.md"),
		[
			"---",
			"description: Use when Clanky needs to delegate coding work.",
			"---",
			"",
			"# Coding",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(repo, "agent", "skills", "research.ts"),
		[
			"import { defineSkill } from \"eve/skills\";",
			"",
			"export default defineSkill({",
			"  description: \"Research unfamiliar topics before answering.\",",
			"  markdown: \"Gather evidence first.\"",
			"});",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(repo, "skills", "clanky-operator", "SKILL.md"),
		[
			"---",
			"name: clanky-operator",
			"description: \"Operate Clanky-specific workflows.\"",
			"when_to_use: Use when a workflow needs Clanky operator conventions.",
			"---",
			"",
			"# Operator",
		].join("\n"),
		"utf8",
	);

	const skills = await listClankySkills(repo);
	assert(skills.length === 3, "inventory should include flat, TypeScript, and packaged skills");
	assert(skills.map((skill) => skill.name).join(",") === "clanky-operator,coding,research", "inventory should sort as one name list");
	const coding = skills.find((skill) => skill.name === "coding");
	const research = skills.find((skill) => skill.name === "research");
	const operator = skills.find((skill) => skill.name === "clanky-operator");
	assert(coding !== undefined, "flat agent skill should be discovered");
	assert(coding.scope === "agent", "flat agent skill should be scoped as agent");
	assert(coding.description === "Use when Clanky needs to delegate coding work.", "frontmatter description should be parsed");
	assert(research !== undefined, "TypeScript skill should be discovered");
	assert(research.description === "Research unfamiliar topics before answering.", "TypeScript defineSkill description should be parsed");
	assert(operator !== undefined, "packaged skill should be discovered");
	assert(operator.scope === "bundled", "repo-level skill package should be scoped as bundled");
	assert(operator.path === join("skills", "clanky-operator", "SKILL.md"), "packaged skill path should be repo-relative");
	assert(operator.whenToUse === "Use when a workflow needs Clanky operator conventions.", "when_to_use should be parsed");
} finally {
	await rm(repo, { recursive: true, force: true });
}

console.log("clanky skills smoke OK");
