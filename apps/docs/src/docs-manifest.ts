import {
	createAgentWorkspaceSiteLinks,
	type DocGroup,
	type DocMeta,
	type DocsSiteInfo,
} from "@volpestyle/night-compiler";

export const site: DocsSiteInfo = {
	id: "clanky-docs",
	title: "Clanky Docs",
	description:
		"Clanky is a personal Pi agent for local work, profile memory, communication gateways, voice/media adapters, skills, and AgentRoom participation.",
	badge: "localhost",
	logo: {
		src: "branding/clanky-icon-32.png",
		srcSet: "branding/clanky-icon-32.png 1x, branding/clanky-icon-64.png 2x, branding/clanky-icon-128.png 4x",
		width: 32,
		height: 32,
	},
	llms: {
		baseUrl: "https://volpestyle.github.io/docs/clanky",
		title: "Clanky",
		blurb:
			"Clanky is a personal Pi agent for local work, profile memory, communication gateways, voice/media adapters, skills, and AgentRoom participation. Discord is today's concrete text/voice adapter, not the product boundary. Start with the Pi TUI and use references only when you need exact commands.",
	},
	siteLinks: createAgentWorkspaceSiteLinks(),
};

export const groups: DocGroup[] = ["Start", "Setup", "Operations", "Reference", "Advanced"];

export const docsMeta: DocMeta[] = [
	{
		slug: "start-here",
		title: "Start Here",
		description:
			"What users can do, what Clanky should handle, and the mental model for Pi, profiles, communication gateways, voice/media, and AgentRoom.",
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
		description:
			"Day-to-day TUI, memory, communication gateways, voice/media, AgentRoom, skills, and connected tool workflows.",
		source: "docs/using-clanky.md",
		group: "Operations",
	},
	{
		slug: "communication-gateways",
		title: "Communication Gateways",
		description:
			"Clanky's chat and voice/media gateway abstraction, ownership model, subagent routing, and why Discord is one adapter.",
		source: "docs/communication-gateways.md",
		group: "Operations",
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
		description: "Profile-local state, credential storage, memory policy, gateway boundaries, and voice logs.",
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
		group: "Advanced",
	},
	{
		slug: "discord-voice-live-runbook",
		title: "Discord Voice Live Runbook",
		description: "Preflight and copyable live validation commands for Discord voice, media, and Go Live checks.",
		source: "docs/qa/discord-voice-live-runbook.md",
		group: "Advanced",
	},
	{
		slug: "discord-voice-architecture",
		title: "Discord Voice Architecture",
		description:
			"End-to-end control-plane, media-plane, Realtime, and Pi delegation flow for Clanky's Discord voice agent.",
		source: "docs/discord-voice-architecture.md",
		group: "Advanced",
	},
];

export const defaultDocSlug = "start-here";
