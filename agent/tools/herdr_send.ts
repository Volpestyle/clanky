import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";

type HerdrSendTarget =
	| { kind: "agent"; target: string }
	| { kind: "pane"; paneId: string };

type NormalizedHerdrSend = {
	target: HerdrSendTarget;
	text?: string;
	keys: string[];
};

type AgentGetResult = {
	agent?: {
		pane_id?: unknown;
	};
	pane_id?: unknown;
};

export function normalizeHerdrSend(input: {
	agent?: string;
	pane?: string;
	text?: string;
	keys?: readonly string[];
}): NormalizedHerdrSend {
	const agent = nonEmpty(input.agent);
	const pane = nonEmpty(input.pane);
	const text = input.text !== undefined && input.text.length > 0 ? input.text : undefined;
	const keys = (input.keys ?? []).map(normalizeKey).filter((key) => key.length > 0);
	if (agent === undefined && pane === undefined) throw new Error("herdr_send requires agent or pane");
	if (text === undefined && keys.length === 0) throw new Error("herdr_send requires text or keys");
	return {
		target: agent !== undefined ? { kind: "agent", target: agent } : { kind: "pane", paneId: pane ?? "" },
		text,
		keys,
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeKey(key: string): string {
	switch (key.trim().toLowerCase()) {
		case "":
			return "";
		case "enter":
		case "return":
			return "Enter";
		case "esc":
		case "escape":
			return "Escape";
		case "tab":
			return "Tab";
		default:
			return key.trim();
	}
}

async function resolveAgentPaneId(target: string): Promise<string> {
	const result = (await herdrRequest("agent.get", { target })) as AgentGetResult;
	const paneId = result.agent?.pane_id ?? result.pane_id;
	if (typeof paneId !== "string" || paneId.length === 0) {
		throw new Error(`could not resolve pane id for agent '${target}'`);
	}
	return paneId;
}

export default defineTool({
	needsApproval: never(),
	description:
		"Send text or discrete keys to a live herdr agent/pane on the host. Use to unblock or steer visible workers. To submit text to an interactive worker, pass text and keys: [\"Enter\"] in the same call.",
	inputSchema: z.object({
		agent: z.string().optional().describe("agent name, for example clanky:codex; omit or leave blank when using pane"),
		pane: z.string().optional().describe("pane id; omit or leave blank when using agent"),
		text: z.string().optional().describe("literal text to send; combine with keys: [\"Enter\"] to submit"),
		keys: z.array(z.string()).optional().describe("discrete keys such as Enter, Escape, or Tab; works with agent or pane"),
	}),
	async execute(input) {
		const send = normalizeHerdrSend(input);
		if (send.target.kind === "agent" && send.keys.length === 0) {
			return herdrRequest("agent.send", { target: send.target.target, text: send.text });
		}

		const paneId = send.target.kind === "agent" ? await resolveAgentPaneId(send.target.target) : send.target.paneId;
		if (send.text !== undefined) {
			await herdrRequest("pane.send_text", { pane_id: paneId, text: send.text });
			if (send.keys.length === 0) return { type: "ok" };
		}
		return herdrRequest("pane.send_keys", { pane_id: paneId, keys: send.keys });
	},
});
