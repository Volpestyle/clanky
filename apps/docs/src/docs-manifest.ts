export type DocGroup = "Start" | "Setup" | "Operations" | "Reference" | "Advanced" | "Maintainer";

export type DocMeta = {
	slug: string;
	title: string;
	description: string;
	source: string;
	group: DocGroup;
};

export const docsMeta: DocMeta[] = [
	{
		slug: "start-here",
		title: "Start Here",
		description: "A new-user map of Clanky, the Pi foundation, profiles, connectors, and the docs path.",
		source: "docs/start-here.md",
		group: "Start",
	},
	{
		slug: "overview",
		title: "Overview",
		description: "Clanky's operating model, setup paths, bundled skills, and local development entry points.",
		source: "README.md",
		group: "Start",
	},
	{
		slug: "pi-foundation",
		title: "Pi Foundation",
		description: "What Clanky inherits from Pi, what Clanky adds, and why Pi commands still matter.",
		source: "docs/pi-foundation.md",
		group: "Start",
	},
	{
		slug: "first-time-setup",
		title: "First-Time Setup",
		description: "Install, fresh-user onboarding, persistent profiles, model auth, and optional connector setup.",
		source: "docs/first-time-setup.md",
		group: "Setup",
	},
	{
		slug: "configuration",
		title: "Configuration Model",
		description: "Profile-local source-of-truth, TUI editor, env override, and AgentRoom boundary rules.",
		source: "docs/configuration.md",
		group: "Setup",
	},
	{
		slug: "using-clanky",
		title: "Using Clanky",
		description: "Day-to-day TUI, memory, Discord, voice, web/media, AgentRoom, skills, and MCP workflows.",
		source: "docs/using-clanky.md",
		group: "Setup",
	},
	{
		slug: "command-reference",
		title: "Command Reference",
		description: "CLI commands, inherited Pi slash commands, Clanky slash commands, and tool families.",
		source: "docs/command-reference.md",
		group: "Reference",
	},
	{
		slug: "memory-and-privacy",
		title: "Memory And Privacy",
		description: "Profile-local state, credential storage, memory policy, Discord boundaries, and voice logs.",
		source: "docs/memory-and-privacy.md",
		group: "Reference",
	},
	{
		slug: "troubleshooting",
		title: "Troubleshooting",
		description: "Profile, auth, Discord, voice, web, media, MCP, AgentRoom, and docs build fixes.",
		source: "docs/troubleshooting.md",
		group: "Reference",
	},
	{
		slug: "agentroom",
		title: "AgentRoom Integration",
		description: "Room participation, gateway ownership, launch contract, and runtime environment boundaries.",
		source: "docs/AGENTROOM.md",
		group: "Operations",
	},
	{
		slug: "live-gates",
		title: "Live Gates",
		description: "Credentialed checks for model auth, Discord text and voice, Linear, xAI media, and AgentRoom launch.",
		source: "docs/qa/live-gates.md",
		group: "Operations",
	},
	{
		slug: "discord-voice-live-runbook",
		title: "Discord Voice Live Runbook",
		description: "Preflight and copyable live validation commands for Discord voice, media, and Go Live checks.",
		source: "docs/qa/discord-voice-live-runbook.md",
		group: "Operations",
	},
	{
		slug: "discord-voice-architecture",
		title: "Discord Voice Architecture",
		description:
			"End-to-end control-plane, media-plane, Realtime, and Pi delegation flow for Clanky's Discord voice agent.",
		source: "docs/discord-voice-architecture.md",
		group: "Advanced",
	},
	{
		slug: "memory-plan",
		title: "Memory Plan (archived)",
		description: "Historical profile-local memory direction and implementation notes.",
		source: "docs/archive/memory-plan.md",
		group: "Maintainer",
	},
	{
		slug: "plan",
		title: "v1 Plan (archived)",
		description: "Historical v1 daemon architecture, package layout, roadmap, and success criteria.",
		source: "docs/archive/plan.md",
		group: "Maintainer",
	},
	{
		slug: "v1-audit",
		title: "v1 Audit (archived)",
		description: "Historical prompt-to-artifact checklist, roadmap audit, and live gate preflight evidence.",
		source: "docs/archive/v1-audit.md",
		group: "Maintainer",
	},
];

export const defaultDocSlug = "start-here";
