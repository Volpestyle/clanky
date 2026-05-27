import agentroom from "../../../docs/AGENTROOM.md?raw";
import commandReference from "../../../docs/command-reference.md?raw";
import demo from "../../../docs/demo.md?raw";
import voiceArchitecture from "../../../docs/discord-voice-architecture.md?raw";
import voiceRunbook from "../../../docs/discord-voice-live-runbook.md?raw";
import firstTimeSetup from "../../../docs/first-time-setup.md?raw";
import liveGates from "../../../docs/live-gates.md?raw";
import memoryAndPrivacy from "../../../docs/memory-and-privacy.md?raw";
import memoryPlan from "../../../docs/memory-plan.md?raw";
import piFoundation from "../../../docs/pi-foundation.md?raw";
import plan from "../../../docs/plan.md?raw";
import startHere from "../../../docs/start-here.md?raw";
import troubleshooting from "../../../docs/troubleshooting.md?raw";
import usingClanky from "../../../docs/using-clanky.md?raw";
import audit from "../../../docs/v1-audit.md?raw";
import readme from "../../../README.md?raw";

export type DocGroup = "Start" | "Setup" | "Operations" | "Reference" | "Advanced" | "Maintainer";

export type Doc = {
	slug: string;
	title: string;
	description: string;
	source: string;
	group: DocGroup;
	markdown: string;
};

export const docs = [
	{
		slug: "start-here",
		title: "Start Here",
		description: "A new-user map of Clanky, the Pi foundation, profiles, connectors, and the docs path.",
		source: "docs/start-here.md",
		group: "Start",
		markdown: startHere,
	},
	{
		slug: "overview",
		title: "Overview",
		description: "Clanky's operating model, setup paths, bundled skills, and local development entry points.",
		source: "README.md",
		group: "Start",
		markdown: readme,
	},
	{
		slug: "pi-foundation",
		title: "Pi Foundation",
		description: "What Clanky inherits from Pi, what Clanky adds, and why Pi commands still matter.",
		source: "docs/pi-foundation.md",
		group: "Start",
		markdown: piFoundation,
	},
	{
		slug: "first-time-setup",
		title: "First-Time Setup",
		description: "Install, fresh-user onboarding, persistent profiles, model auth, and optional connector setup.",
		source: "docs/first-time-setup.md",
		group: "Setup",
		markdown: firstTimeSetup,
	},
	{
		slug: "using-clanky",
		title: "Using Clanky",
		description: "Day-to-day TUI, memory, Discord, voice, web/media, AgentRoom, skills, and MCP workflows.",
		source: "docs/using-clanky.md",
		group: "Setup",
		markdown: usingClanky,
	},
	{
		slug: "command-reference",
		title: "Command Reference",
		description: "CLI commands, inherited Pi slash commands, Clanky slash commands, and tool families.",
		source: "docs/command-reference.md",
		group: "Reference",
		markdown: commandReference,
	},
	{
		slug: "memory-and-privacy",
		title: "Memory And Privacy",
		description: "Profile-local state, credential storage, memory policy, Discord boundaries, and voice logs.",
		source: "docs/memory-and-privacy.md",
		group: "Reference",
		markdown: memoryAndPrivacy,
	},
	{
		slug: "troubleshooting",
		title: "Troubleshooting",
		description: "Profile, auth, Discord, voice, web, media, MCP, AgentRoom, and docs build fixes.",
		source: "docs/troubleshooting.md",
		group: "Reference",
		markdown: troubleshooting,
	},
	{
		slug: "agentroom",
		title: "AgentRoom Integration",
		description: "Room participation, gateway ownership, launch contract, and runtime environment boundaries.",
		source: "docs/AGENTROOM.md",
		group: "Operations",
		markdown: agentroom,
	},
	{
		slug: "live-gates",
		title: "Live Gates",
		description: "Credentialed checks for model auth, Discord text and voice, Linear, xAI media, and AgentRoom launch.",
		source: "docs/live-gates.md",
		group: "Operations",
		markdown: liveGates,
	},
	{
		slug: "discord-voice-live-runbook",
		title: "Discord Voice Live Runbook",
		description: "Preflight and copyable live validation commands for Discord voice, media, and Go Live checks.",
		source: "docs/discord-voice-live-runbook.md",
		group: "Operations",
		markdown: voiceRunbook,
	},
	{
		slug: "discord-voice-architecture",
		title: "Discord Voice Architecture",
		description:
			"End-to-end control-plane, media-plane, Realtime, and Pi delegation flow for Clanky's Discord voice agent.",
		source: "docs/discord-voice-architecture.md",
		group: "Advanced",
		markdown: voiceArchitecture,
	},
	{
		slug: "demo",
		title: "Demo Script",
		description: "Setup, interactive run, smoke checks, optional credentialed checks, and cleanup.",
		source: "docs/demo.md",
		group: "Setup",
		markdown: demo,
	},
	{
		slug: "memory-plan",
		title: "Memory Plan",
		description: "Profile-local memory direction and implementation notes.",
		source: "docs/memory-plan.md",
		group: "Maintainer",
		markdown: memoryPlan,
	},
	{
		slug: "plan",
		title: "Plan",
		description: "Architecture target, package layout, extension points, roadmap, risks, and success criteria.",
		source: "docs/plan.md",
		group: "Maintainer",
		markdown: plan,
	},
	{
		slug: "v1-audit",
		title: "v1 Audit",
		description: "Prompt-to-artifact checklist, roadmap audit, live gate preflight, and automated evidence.",
		source: "docs/v1-audit.md",
		group: "Maintainer",
		markdown: audit,
	},
] satisfies Doc[];

export const defaultDocSlug = "start-here";

export const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));

export const docsBySource = new Map(docs.map((doc) => [doc.source.toLowerCase(), doc]));
