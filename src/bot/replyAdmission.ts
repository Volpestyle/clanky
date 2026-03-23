import { clamp } from "../utils.ts";
import { getBotName, getBotNameAliases } from "../settings/agentStack.ts";
import { getReplyPermissions } from "../settings/agentStack.ts";
import { isBotNameAddressed } from "../voice/voiceSessionHelpers.ts";
import type { Settings } from "../settings/settingsSchema.ts";
import {
  DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD
} from "./directAddressConfidence.ts";

export type ReplyAddressSignal = {
  direct: boolean;
  inferred: boolean;
  triggered: boolean;
  reason: string;
  confidence: number;
  threshold: number;
  confidenceSource: "llm" | "fallback" | "direct" | "exact_name";
};

export type TextAttentionMode = "ACTIVE" | "AMBIENT";
export type TextAttentionReason =
  | "direct_address"
  | "reply_to_bot"
  | "same_author_followup"
  | "cold_ambient";

export type TextAttentionState = {
  mode: TextAttentionMode;
  reason: TextAttentionReason;
  responseWindowSize: number;
  recentReplyWindowActive: boolean;
  latestBotMessageId: string | null;
};

export type ReplyAdmissionDecisionReason =
  | "force_respond"
  | "force_decision_loop"
  | "hard_address"
  | "unsolicited_replies_disabled"
  | "recent_reply_window"
  | "cold_ambient_llm_decides";

export type ReplyAdmissionDecision = {
  allow: boolean;
  reason: ReplyAdmissionDecisionReason;
  attentionState: TextAttentionState;
  allowUnsolicitedReplies: boolean;
  isReplyChannel: boolean;
};

type ReplyAdmissionRecentMessage = Record<string, unknown> & {
  message_id?: string;
  author_id?: string;
  is_bot?: boolean | number;
  referenced_message_id?: string | null;
};

type ReplyAdmissionAuthor = {
  id?: string;
};

type ReplyAdmissionReference = {
  messageId?: string;
  resolved?: {
    author?: ReplyAdmissionAuthor | null;
  } | null;
  resolvedMessage?: {
    author?: ReplyAdmissionAuthor | null;
  } | null;
};

type ReplyAdmissionMentionUsers = {
  has: (id: string | undefined) => boolean;
  size?: number;
};

type ReplyAdmissionMessage = {
  content?: string;
  mentions?: {
    users?: ReplyAdmissionMentionUsers | null;
    repliedUser?: ReplyAdmissionAuthor | null;
  } | null;
  reference?: ReplyAdmissionReference | null;
  referencedMessage?: {
    author?: ReplyAdmissionAuthor | null;
    id?: string;
  } | null;
  author?: ReplyAdmissionAuthor | null;
};

type ReplyAddressRuntime = {
  botUserId?: string | null;
  isDirectlyAddressed: (settings: Settings, message: ReplyAdmissionMessage) => boolean;
};

function hasBotMessageInRecentWindow({
  botUserId,
  recentMessages,
  windowSize = 5,
  triggerMessageId = null
}: {
  botUserId?: string | null;
  recentMessages?: ReplyAdmissionRecentMessage[];
  windowSize?: number;
  triggerMessageId?: string | null;
}) {
  const normalizedBotUserId = String(botUserId || "").trim();
  if (!normalizedBotUserId) return false;
  if (!Array.isArray(recentMessages) || !recentMessages.length) return false;

  const excludedMessageId = String(triggerMessageId || "").trim();
  const candidateMessages = excludedMessageId
    ? recentMessages.filter((row) => String(row?.message_id || "").trim() !== excludedMessageId)
    : recentMessages;

  const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
  return candidateMessages
    .slice(0, cappedWindow)
    .some((row) => isBotRecentMessage(row, normalizedBotUserId));
}

function getResponseWindowMessageCount(eagerness: unknown) {
  const normalized = clamp(Number(eagerness) || 0, 0, 100);
  if (normalized <= 0) return 0;
  if (normalized <= 20) return 1;
  if (normalized <= 40) return 2;
  if (normalized <= 60) return 4;
  if (normalized <= 80) return 6;
  return 8;
}

export function hasStartupFollowupAfterMessage({
  botUserId,
  messages,
  messageIndex,
  triggerMessageId,
  windowSize = 5
}: {
  botUserId?: string | null;
  messages?: ReplyAdmissionMessage[];
  messageIndex: number;
  triggerMessageId?: string | null;
  windowSize?: number;
}) {
  const normalizedBotUserId = String(botUserId || "").trim();
  if (!normalizedBotUserId) return false;
  if (!Array.isArray(messages) || !messages.length) return false;
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) return false;

  const triggerId = String(triggerMessageId || "").trim();
  const startIndex = messageIndex + 1;

  if (triggerId) {
    for (let index = startIndex; index < messages.length; index += 1) {
      const candidate = messages[index];
      if (String(candidate?.author?.id || "").trim() !== normalizedBotUserId) continue;

      const referencedId = String(
        candidate?.reference?.messageId || candidate?.referencedMessage?.id || ""
      ).trim();
      if (referencedId && referencedId === triggerId) {
        return true;
      }
    }
  }

  const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
  const endIndex = Math.min(messages.length, startIndex + cappedWindow);
  for (let index = startIndex; index < endIndex; index += 1) {
    if (String(messages[index]?.author?.id || "").trim() === normalizedBotUserId) {
      return true;
    }
  }

  return false;
}

function getCandidateRecentMessages({
  recentMessages,
  triggerMessageId = null,
  windowSize = 5
}: {
  recentMessages?: ReplyAdmissionRecentMessage[];
  triggerMessageId?: string | null;
  windowSize?: number;
}) {
  if (!Array.isArray(recentMessages) || !recentMessages.length) return [];

  const excludedMessageId = String(triggerMessageId || "").trim();
  const candidateMessages = excludedMessageId
    ? recentMessages.filter((row) => String(row?.message_id || "").trim() !== excludedMessageId)
    : recentMessages;

  const cappedWindow = clamp(Math.floor(windowSize), 1, 50);
  return candidateMessages.slice(0, cappedWindow);
}

function isBotRecentMessage(row: ReplyAdmissionRecentMessage | null | undefined, botUserId?: string | null) {
  const normalizedBotUserId = String(botUserId || "").trim();
  if (normalizedBotUserId && String(row?.author_id || "").trim() === normalizedBotUserId) {
    return true;
  }
  return row?.is_bot === true || row?.is_bot === 1;
}

function resolveRecentMessageAuthorId(
  messages: ReplyAdmissionRecentMessage[],
  messageId?: string | null
) {
  const normalizedMessageId = String(messageId || "").trim();
  if (!normalizedMessageId) return null;
  const row = messages.find((candidate) => String(candidate?.message_id || "").trim() === normalizedMessageId);
  const authorId = String(row?.author_id || "").trim();
  return authorId || null;
}



function resolveRecentReplyWindowState({
  botUserId,
  message,
  recentMessages,
  windowSize = 5,
  triggerMessageId = null,
  triggerAuthorId = null,
  triggerReferenceMessageId = null
}: {
  botUserId?: string | null;
  message?: ReplyAdmissionMessage | null;
  recentMessages?: ReplyAdmissionRecentMessage[];
  windowSize?: number;
  triggerMessageId?: string | null;
  triggerAuthorId?: string | null;
  triggerReferenceMessageId?: string | null;
}) {
  const normalizedBotUserId = String(botUserId || "").trim();
  const normalizedTriggerAuthorId = String(triggerAuthorId || "").trim() || null;
  const normalizedTriggerReferenceMessageId = String(triggerReferenceMessageId || "").trim() || null;
  if (!normalizedBotUserId) {
    return {
      active: false,
      reason: "cold_ambient" as const,
      latestBotMessageId: null
    };
  }

  const windowMessages = getCandidateRecentMessages({
    recentMessages,
    triggerMessageId,
    windowSize
  });
  if (!windowMessages.length) {
    return {
      active: false,
      reason: "cold_ambient" as const,
      latestBotMessageId: null
    };
  }

  if (normalizedTriggerReferenceMessageId) {
    const referencedBotMessage = windowMessages.find((row) =>
      String(row?.message_id || "").trim() === normalizedTriggerReferenceMessageId &&
      isBotRecentMessage(row, normalizedBotUserId)
    );
    if (referencedBotMessage) {
      return {
        active: true,
        reason: "reply_to_bot" as const,
        latestBotMessageId: String(referencedBotMessage.message_id || "").trim() || null
      };
    }
  }

  const latestBotMessageIndex = windowMessages.findIndex((row) => isBotRecentMessage(row, normalizedBotUserId));
  if (latestBotMessageIndex === -1) {
    return {
      active: false,
      reason: "cold_ambient" as const,
      latestBotMessageId: null
    };
  }

  const latestBotMessage = windowMessages[latestBotMessageIndex];
  const latestBotMessageId = String(latestBotMessage?.message_id || "").trim() || null;
  if (!normalizedTriggerAuthorId) {
    return {
      active: false,
      reason: "cold_ambient" as const,
      latestBotMessageId
    };
  }

  const newerMessages = windowMessages.slice(0, latestBotMessageIndex);
  const conflictingNewerHumanMessage = newerMessages.some((row) => {
    const authorId = String(row?.author_id || "").trim();
    return authorId && !isBotRecentMessage(row, normalizedBotUserId) && authorId !== normalizedTriggerAuthorId;
  });
  if (conflictingNewerHumanMessage) {
    return {
      active: false,
      reason: "cold_ambient" as const,
      latestBotMessageId
    };
  }

  const latestBotReplyTargetId = resolveRecentMessageAuthorId(
    windowMessages,
    String(latestBotMessage?.referenced_message_id || "").trim() || null
  );
  const immediateOlderHumanMessage = windowMessages
    .slice(latestBotMessageIndex + 1)
    .find((row) => {
      const authorId = String(row?.author_id || "").trim();
      return authorId && !isBotRecentMessage(row, normalizedBotUserId);
    });
  const immediateOlderHumanAuthorId = String(immediateOlderHumanMessage?.author_id || "").trim() || null;

  if (
    latestBotReplyTargetId === normalizedTriggerAuthorId ||
    immediateOlderHumanAuthorId === normalizedTriggerAuthorId
  ) {
    return {
      active: true,
      reason: "same_author_followup" as const,
      latestBotMessageId
    };
  }

  return {
    active: false,
    reason: "cold_ambient" as const,
    latestBotMessageId
  };
}

export function resolveTextAttentionState({
  botUserId,
  settings,
  message,
  recentMessages,
  addressSignal,
  triggerMessageId = null,
  triggerAuthorId = null,
  triggerReferenceMessageId = null,
  windowSize = 5
}: {
  botUserId?: string | null;
  settings: Settings;
  message?: ReplyAdmissionMessage | null;
  recentMessages?: ReplyAdmissionRecentMessage[];
  addressSignal?: Partial<ReplyAddressSignal> | null;
  triggerMessageId?: string | null;
  triggerAuthorId?: string | null;
  triggerReferenceMessageId?: string | null;
  windowSize?: number;
}): TextAttentionState {
  const responseWindowSize = getResponseWindowMessageCount(
    settings?.interaction?.activity?.responseWindowEagerness
  );
  if (isHardAddressSignal(addressSignal)) {
    return {
      mode: "ACTIVE",
      reason: "direct_address",
      responseWindowSize,
      recentReplyWindowActive: false,
      latestBotMessageId: null
    };
  }

  if (responseWindowSize <= 0) {
    return {
      mode: "AMBIENT",
      reason: "cold_ambient",
      responseWindowSize,
      recentReplyWindowActive: false,
      latestBotMessageId: null
    };
  }

  const recentWindow = resolveRecentReplyWindowState({
    botUserId,
    message,
    recentMessages,
    windowSize: Math.min(responseWindowSize, clamp(Math.floor(windowSize), 1, 50)),
    triggerMessageId,
    triggerAuthorId,
    triggerReferenceMessageId
  });
  if (recentWindow.active) {
    return {
      mode: "ACTIVE",
      reason: recentWindow.reason,
      responseWindowSize,
      recentReplyWindowActive: true,
      latestBotMessageId: recentWindow.latestBotMessageId
    };
  }

  return {
    mode: "AMBIENT",
    reason: "cold_ambient",
    responseWindowSize,
    recentReplyWindowActive: false,
    latestBotMessageId: recentWindow.latestBotMessageId
  };
}

export function shouldAttemptReplyDecision({
  botUserId,
  settings,
  message,
  recentMessages,
  addressSignal,
  isReplyChannel = false,
  forceRespond = false,
  forceDecisionLoop = false,
  triggerMessageId = null,
  triggerAuthorId = null,
  triggerReferenceMessageId = null,
  windowSize = 5
}: {
  botUserId?: string | null;
  settings: Settings;
  message?: ReplyAdmissionMessage | null;
  recentMessages?: ReplyAdmissionRecentMessage[];
  addressSignal?: Partial<ReplyAddressSignal> | null;
  isReplyChannel?: boolean;
  forceRespond?: boolean;
  forceDecisionLoop?: boolean;
  triggerMessageId?: string | null;
  triggerAuthorId?: string | null;
  triggerReferenceMessageId?: string | null;
  windowSize?: number;
}) {
  return evaluateReplyAdmissionDecision({
    botUserId,
    settings,
    message,
    recentMessages,
    addressSignal,
    isReplyChannel,
    forceRespond,
    forceDecisionLoop,
    triggerMessageId,
    triggerAuthorId,
    triggerReferenceMessageId,
    windowSize
  }).allow;
}

export function evaluateReplyAdmissionDecision({
  botUserId,
  settings,
  message,
  recentMessages,
  addressSignal,
  isReplyChannel = false,
  forceRespond = false,
  forceDecisionLoop = false,
  triggerMessageId = null,
  triggerAuthorId = null,
  triggerReferenceMessageId = null,
  windowSize = 5
}: {
  botUserId?: string | null;
  settings: Settings;
  message?: ReplyAdmissionMessage | null;
  recentMessages?: ReplyAdmissionRecentMessage[];
  addressSignal?: Partial<ReplyAddressSignal> | null;
  isReplyChannel?: boolean;
  forceRespond?: boolean;
  forceDecisionLoop?: boolean;
  triggerMessageId?: string | null;
  triggerAuthorId?: string | null;
  triggerReferenceMessageId?: string | null;
  windowSize?: number;
}): ReplyAdmissionDecision {
  const allowUnsolicitedReplies = getReplyPermissions(settings).allowUnsolicitedReplies;
  const attentionState = resolveTextAttentionState({
    botUserId,
    settings,
    message,
    recentMessages,
    addressSignal,
    triggerMessageId,
    triggerAuthorId,
    triggerReferenceMessageId,
    windowSize
  });

  if (forceRespond) {
    return {
      allow: true,
      reason: "force_respond",
      attentionState,
      allowUnsolicitedReplies,
      isReplyChannel: Boolean(isReplyChannel)
    };
  }

  if (forceDecisionLoop) {
    return {
      allow: true,
      reason: "force_decision_loop",
      attentionState,
      allowUnsolicitedReplies,
      isReplyChannel: Boolean(isReplyChannel)
    };
  }

  if (isHardAddressSignal(addressSignal)) {
    return {
      allow: true,
      reason: "hard_address",
      attentionState,
      allowUnsolicitedReplies,
      isReplyChannel: Boolean(isReplyChannel)
    };
  }

  if (!allowUnsolicitedReplies) {
    return {
      allow: false,
      reason: "unsolicited_replies_disabled",
      attentionState,
      allowUnsolicitedReplies,
      isReplyChannel: Boolean(isReplyChannel)
    };
  }

  if (attentionState.recentReplyWindowActive) {
    return {
      allow: true,
      reason: "recent_reply_window",
      attentionState,
      allowUnsolicitedReplies,
      isReplyChannel: Boolean(isReplyChannel)
    };
  }

  // No probabilistic gate — always let the LLM see the message and decide
  // whether to respond or [SKIP]. Eagerness is communicated via prompt context.
  return {
    allow: true,
    reason: "cold_ambient_llm_decides",
    attentionState,
    allowUnsolicitedReplies,
    isReplyChannel: Boolean(isReplyChannel)
  };
}

export async function getReplyAddressSignal(
  runtime: ReplyAddressRuntime,
  settings: Settings,
  message: ReplyAdmissionMessage,
  recentMessages: ReplyAdmissionRecentMessage[] = []
): Promise<ReplyAddressSignal> {
  const referencedAuthorId = resolveReferencedAuthorId(message, recentMessages);
  const directByPlatform =
    runtime.isDirectlyAddressed(settings, message) ||
    Boolean(referencedAuthorId && referencedAuthorId === runtime.botUserId);
  const exactNameReason = resolveExactNameReason(settings, message);
  const inferredByExactName = Boolean(exactNameReason);
  const threshold = DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD;
  const scoredThreshold = clamp(Number(threshold) || DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD, 0.4, 0.95);
  const direct = Boolean(directByPlatform || inferredByExactName);
  const reason = direct
    ? directByPlatform
      ? "direct"
      : exactNameReason || "name_exact"
    : "llm_decides";
  const confidence = directByPlatform
    ? 1
    : inferredByExactName
      ? 0.95
      : 0;

  return {
    direct: Boolean(direct),
    inferred: Boolean(inferredByExactName),
    triggered: Boolean(direct),
    reason,
    confidence,
    threshold: scoredThreshold,
    confidenceSource: directByPlatform
      ? "direct"
      : inferredByExactName
        ? "exact_name"
        : "fallback"
  };
}

function resolveReferencedAuthorId(
  message: ReplyAdmissionMessage,
  recentMessages: ReplyAdmissionRecentMessage[] = []
) {
  const referenceId = String(message.reference?.messageId || "").trim();
  if (!referenceId) return null;

  const fromRecent = recentMessages.find((row) => String(row.message_id) === referenceId)?.author_id;
  if (fromRecent) return String(fromRecent);

  const fromResolved =
    message.reference?.resolved?.author?.id ||
    message.reference?.resolvedMessage?.author?.id ||
    message.referencedMessage?.author?.id;

  return fromResolved ? String(fromResolved) : null;
}

function resolveExactNameReason(settings: Settings, message: ReplyAdmissionMessage) {
  const transcript = String(message?.content || "");
  const botName = getBotName(settings).trim();
  if (botName && isBotNameAddressed({ transcript, botName })) {
    return "name_exact";
  }

  const aliases = getBotNameAliases(settings);
  for (const alias of aliases) {
    const normalizedAlias = String(alias || "").trim();
    if (!normalizedAlias) continue;
    if (botName && normalizedAlias.toLowerCase() === botName.toLowerCase()) continue;
    if (isBotNameAddressed({ transcript, botName: normalizedAlias })) {
      return "name_alias";
    }
  }

  return null;
}

function isHardAddressSignal(addressSignal: Partial<ReplyAddressSignal> | null = null) {
  if (!addressSignal || typeof addressSignal !== "object") return false;
  if (!addressSignal.triggered) return false;
  const reason = String(addressSignal.reason || "")
    .trim()
    .toLowerCase();
  return reason === "direct" || reason === "name_exact" || reason === "name_alias";
}
