import { defineDynamic, defineSkill } from "eve/skills";
import { isAgentMdIngestionEnabled } from "../lib/agent-md.ts";
import { listClankySkills, listInheritedAgentSkillPackages } from "../lib/skill-inventory.ts";

export default defineDynamic({
	events: {
		"turn.started": async () => {
			if (!isAgentMdIngestionEnabled()) return null;
			const repo = process.env.CLANKY_REPO_DIR?.trim() || process.cwd();
			const localSkills = await listClankySkills(repo);
			const reservedNames = new Set(localSkills.map((skill) => skill.name));
			const packages = await listInheritedAgentSkillPackages({ reservedNames });
			if (packages.length === 0) return null;
			return Object.fromEntries(
				packages.map((skill) => [
					skill.runtimeName ?? skill.name,
					defineSkill({
						description: skill.description,
						markdown: skill.markdown,
						metadata: {
							scope: "inherited",
							source: skill.source ?? "codex",
							name: skill.name,
							path: skill.path,
						},
						...(Object.keys(skill.files).length === 0 ? {} : { files: skill.files }),
					}),
				]),
			);
		},
	},
});
