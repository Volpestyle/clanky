import agentroom from "../../../docs/AGENTROOM.md?raw";
import demo from "../../../docs/demo.md?raw";
import voiceArchitecture from "../../../docs/discord-voice-architecture.md?raw";
import voiceRunbook from "../../../docs/discord-voice-live-runbook.md?raw";
import liveGates from "../../../docs/live-gates.md?raw";
import memoryPlan from "../../../docs/memory-plan.md?raw";
import plan from "../../../docs/plan.md?raw";
import audit from "../../../docs/v1-audit.md?raw";
import readme from "../../../README.md?raw";

export type DocGroup = "Start" | "Operations" | "Planning" | "Evidence";

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
		slug: "overview",
		title: "Overview",
		description: "Clanky's operating model, setup paths, bundled skills, and local development entry points.",
		source: "README.md",
		group: "Start",
		markdown: readme,
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
		group: "Operations",
		markdown: voiceArchitecture,
	},
	{
		slug: "demo",
		title: "Demo Script",
		description: "Setup, interactive run, smoke checks, optional credentialed checks, and cleanup.",
		source: "docs/demo.md",
		group: "Start",
		markdown: demo,
	},
	{
		slug: "memory-plan",
		title: "Memory Plan",
		description: "Profile-local memory direction and implementation notes.",
		source: "docs/memory-plan.md",
		group: "Planning",
		markdown: memoryPlan,
	},
	{
		slug: "plan",
		title: "Plan",
		description: "Architecture target, package layout, extension points, roadmap, risks, and success criteria.",
		source: "docs/plan.md",
		group: "Planning",
		markdown: plan,
	},
	{
		slug: "v1-audit",
		title: "v1 Audit",
		description: "Prompt-to-artifact checklist, roadmap audit, live gate preflight, and automated evidence.",
		source: "docs/v1-audit.md",
		group: "Evidence",
		markdown: audit,
	},
] satisfies Doc[];

export const defaultDocSlug = "overview";

export const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));

export const docsBySource = new Map(docs.map((doc) => [doc.source.toLowerCase(), doc]));
