import agentroom from "../../../docs/AGENTROOM.md?raw";
import memoryPlan from "../../../docs/archive/memory-plan.md?raw";
import plan from "../../../docs/archive/plan.md?raw";
import audit from "../../../docs/archive/v1-audit.md?raw";
import commandReference from "../../../docs/command-reference.md?raw";
import configuration from "../../../docs/configuration.md?raw";
import voiceArchitecture from "../../../docs/discord-voice-architecture.md?raw";
import firstTimeSetup from "../../../docs/first-time-setup.md?raw";
import memoryAndPrivacy from "../../../docs/memory-and-privacy.md?raw";
import piFoundation from "../../../docs/pi-foundation.md?raw";
import voiceRunbook from "../../../docs/qa/discord-voice-live-runbook.md?raw";
import liveGates from "../../../docs/qa/live-gates.md?raw";
import startHere from "../../../docs/start-here.md?raw";
import troubleshooting from "../../../docs/troubleshooting.md?raw";
import usingClanky from "../../../docs/using-clanky.md?raw";
import readme from "../../../README.md?raw";
import { type DocMeta, docsMeta } from "./docs-manifest";

export type { DocGroup, DocMeta } from "./docs-manifest";
export { defaultDocSlug } from "./docs-manifest";

export type Doc = DocMeta & { markdown: string };

const markdownBySource: Record<string, string> = {
	"docs/AGENTROOM.md": agentroom,
	"docs/archive/memory-plan.md": memoryPlan,
	"docs/archive/plan.md": plan,
	"docs/archive/v1-audit.md": audit,
	"docs/command-reference.md": commandReference,
	"docs/configuration.md": configuration,
	"docs/discord-voice-architecture.md": voiceArchitecture,
	"docs/first-time-setup.md": firstTimeSetup,
	"docs/memory-and-privacy.md": memoryAndPrivacy,
	"docs/pi-foundation.md": piFoundation,
	"docs/qa/discord-voice-live-runbook.md": voiceRunbook,
	"docs/qa/live-gates.md": liveGates,
	"docs/start-here.md": startHere,
	"docs/troubleshooting.md": troubleshooting,
	"docs/using-clanky.md": usingClanky,
	"README.md": readme,
};

export const docs: Doc[] = docsMeta.map((meta) => {
	const markdown = markdownBySource[meta.source];
	if (markdown === undefined) {
		throw new Error(`No markdown registered for doc source "${meta.source}"`);
	}
	return { ...meta, markdown };
});

export const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));

export const docsBySource = new Map(docs.map((doc) => [doc.source.toLowerCase(), doc]));
