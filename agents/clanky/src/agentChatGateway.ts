import type { SendSubagentMessageInput, SendSubagentMessageResult } from "@clanky/core";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";

export type AgentChatGatewayKind = "discord" | "slack" | "telegram" | "sms" | "email" | "webhook" | "custom";
export type AgentChatCredentialKind = "bot-token" | "user-token" | "webhook" | "custom";
export type AgentChatConversationKind = "dm" | "channel" | "group" | "thread" | "custom";
export type AgentChatMessageKind = "text" | "image" | "video" | "audio" | "voice" | "document" | "sticker" | "custom";

export interface AgentChatConversation {
	id: string;
	kind: AgentChatConversationKind;
	threadId?: string;
	parentId?: string;
	serverId?: string;
	displayName?: string;
}

export interface AgentChatSender {
	id: string;
	username?: string;
	displayName?: string;
	isBot?: boolean;
}

export interface AgentChatAttachment {
	kind?: Exclude<AgentChatMessageKind, "text">;
	id?: string;
	url?: string;
	filename?: string;
	mime?: string;
	contentType?: string;
	caption?: string;
	metadata?: Record<string, unknown>;
}

export interface AgentChatInboundMessage {
	providerId?: string;
	providerKind?: AgentChatGatewayKind;
	credentialKind?: AgentChatCredentialKind;
	externalMessageId: string;
	conversation: AgentChatConversation;
	sender: AgentChatSender;
	text: string;
	kind?: AgentChatMessageKind;
	attachments: AgentChatAttachment[];
	mentionsSelf: boolean;
	replyToExternalMessageId?: string;
	receivedAt?: string;
	raw?: unknown;
}

export interface AgentChatSendMessageInput {
	conversation: AgentChatConversation;
	text: string;
	replyToExternalMessageId?: string;
	attachments?: AgentChatAttachment[];
	metadata?: Record<string, unknown>;
}

export interface AgentChatSendMessageResult {
	externalMessageId: string;
	chunked?: boolean;
	metadata?: Record<string, unknown>;
}

export interface AgentChatSendTypingInput {
	conversation: AgentChatConversation;
	metadata?: Record<string, unknown>;
}

export type AgentChatInboundHandler = (message: AgentChatInboundMessage) => void | Promise<void>;

export interface AgentChatGatewayProvider {
	id: string;
	kind: AgentChatGatewayKind;
	credentialKind: AgentChatCredentialKind;
	start(handler: AgentChatInboundHandler): Promise<void>;
	stop(): Promise<void>;
	sendMessage(input: AgentChatSendMessageInput): Promise<AgentChatSendMessageResult>;
	sendTyping?(input: AgentChatSendTypingInput): Promise<void>;
}

export interface AgentChatGatewayHandle {
	stop(): Promise<void>;
	setSubagentThinkingLevel(level: ClankyThinkingLevel): number;
	sendSubagentMessage?(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult | undefined>;
}
