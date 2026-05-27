import type { SendSubagentMessageInput, SendSubagentMessageResult } from "@clanky/core";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";

export type AgentVoiceGatewayKind = "discord" | "slack-huddle" | "custom";
export type AgentVoiceFeature =
	| "audio-input"
	| "audio-output"
	| "video-input"
	| "video-output"
	| "screen-watch"
	| "screen-publish"
	| "music-playback";

export interface AgentVoiceTarget {
	serverId?: string;
	conversationId?: string;
	channelId?: string;
	displayName?: string;
}

export interface AgentRealtimeVoiceConfig {
	enabled: boolean;
	autoJoin?: boolean;
	wakeNames?: string[];
	participationEagerness?: number;
	videoFrameAutoAttachIntervalMs?: number;
}

export interface AgentVoiceGatewayStatus {
	active: boolean;
	enabled: boolean;
	platform: AgentVoiceGatewayKind;
	mode: "dynamic" | "fixed";
	target?: AgentVoiceTarget;
	features?: AgentVoiceFeature[];
	[key: string]: unknown;
}

export interface AgentVoiceGatewayHandle {
	stop(): Promise<void>;
	status(): AgentVoiceGatewayStatus | Record<string, unknown>;
	requestTextUtterance(text: string): void;
	setSubagentThinkingLevel?(level: ClankyThinkingLevel): number;
	sendSubagentMessage?(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined>;
}
