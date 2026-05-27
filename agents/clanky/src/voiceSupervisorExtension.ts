import {
	type AgentToolResult,
	defineTool,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface VoiceSupervisorDelegateInput {
	title: string;
	prompt: string;
	workerKey?: string;
	reason?: string;
}

export interface VoiceSupervisorDelegateResult {
	delegated: boolean;
	subagentId: string;
	kind: string;
	title: string;
	queuedAt: string;
	sessionId?: string;
	sessionFile?: string;
	response?: string;
	error?: string;
}

export interface VoiceSupervisorDelegateHandle {
	delegateToSubagent?: (input: VoiceSupervisorDelegateInput) => Promise<VoiceSupervisorDelegateResult>;
}

const voiceDelegateToSubagentSchema = Type.Object({
	title: Type.String(),
	prompt: Type.String(),
	workerKey: Type.Optional(Type.String()),
	worker_key: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
});

type VoiceDelegateToSubagentParams = {
	title: string;
	prompt: string;
	workerKey?: string;
	worker_key?: string;
	reason?: string;
};

export function createVoiceSupervisorExtensionFactory(handle: VoiceSupervisorDelegateHandle): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createVoiceDelegateToSubagentTool(handle));
	};
}

function createVoiceDelegateToSubagentTool(
	handle: VoiceSupervisorDelegateHandle,
): ToolDefinition<typeof voiceDelegateToSubagentSchema> {
	return defineTool({
		name: "voice_delegate_to_subagent",
		label: "Voice Delegate To Subagent",
		description:
			"Privileged voice supervisor tool: run a general-purpose Clanky subagent for bounded work while the voice worker keeps coordinating the Discord conversation.",
		promptSnippet:
			"voice_delegate_to_subagent: privileged voice supervisor only; delegate bounded work to a general Clanky subagent.",
		promptGuidelines: [
			"Use only from the Discord voice supervisor worker.",
			"Use a stable worker_key when continuing a specialist thread; omit it for a one-off worker.",
			"General subagents have normal Clanky tools but cannot spawn child subagents.",
			"For long work that should become the foreground user's concern, use delegate_to_main_worker instead.",
		],
		parameters: voiceDelegateToSubagentSchema,
		async execute(_toolCallId, params) {
			const delegate = handle.delegateToSubagent;
			if (delegate === undefined) throw new Error("Discord voice supervisor delegation is not active.");
			const input = normalizeVoiceDelegateToSubagentParams(params);
			return objectToolResult(await delegate(input));
		},
	});
}

function normalizeVoiceDelegateToSubagentParams(params: VoiceDelegateToSubagentParams): VoiceSupervisorDelegateInput {
	const title = params.title.trim();
	const prompt = params.prompt.trim();
	if (title.length === 0) throw new Error("voice_delegate_to_subagent requires a non-empty title.");
	if (prompt.length === 0) throw new Error("voice_delegate_to_subagent requires a non-empty prompt.");
	const workerKey = cleanOptionalString(params.workerKey ?? params.worker_key);
	const reason = cleanOptionalString(params.reason);
	return {
		title,
		prompt,
		...(workerKey === undefined ? {} : { workerKey }),
		...(reason === undefined ? {} : { reason }),
	};
}

function cleanOptionalString(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function objectToolResult(value: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}
