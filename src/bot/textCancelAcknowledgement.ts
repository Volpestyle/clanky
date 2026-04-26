import { getBotName } from "../settings/agentStack.ts";

const TEXT_CANCEL_ACK_TIMEOUT_MS = 2_500;
const TEXT_CANCEL_ACK_MAX_CHARS = 220;

type TextCancelAcknowledgementLlm = {
  generate?: (args: {
    settings: unknown;
    systemPrompt: string;
    userPrompt: string;
    trace?: {
      guildId?: string | null;
      channelId?: string | null;
      userId?: string | null;
      source?: string | null;
      event?: string | null;
      messageId?: string | null;
    };
    signal?: AbortSignal;
  }) => Promise<{
    text?: string | null;
  } | null>;
};

function normalizeAcknowledgementText(text: unknown) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  if (!normalized || normalized === "[SKIP]") return null;
  return normalized.slice(0, TEXT_CANCEL_ACK_MAX_CHARS);
}

export async function generateTextCancelAcknowledgement({
  llm,
  settings,
  guildId = null,
  channelId = null,
  userId = null,
  messageId = null,
  authorName = "someone",
  cancelText = "",
  cancelledReplyCount = 0,
  cancelledQueuedReplyCount = 0,
  browserCancelled = false,
  swarmCancelledCount = 0
}: {
  llm?: TextCancelAcknowledgementLlm | null;
  settings: Record<string, unknown> | null;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  messageId?: string | null;
  authorName?: string | null;
  cancelText?: string | null;
  cancelledReplyCount?: number;
  cancelledQueuedReplyCount?: number;
  browserCancelled?: boolean;
  swarmCancelledCount?: number;
}) {
  if (typeof llm?.generate !== "function") return null;

  const signal = AbortSignal.timeout(TEXT_CANCEL_ACK_TIMEOUT_MS);
  const botName = getBotName(settings);
  const normalizedCancelText = String(cancelText || "").trim() || "stop";
  const normalizedAuthorName = String(authorName || "").trim() || "someone";
  const interruptedSystems = [
    cancelledReplyCount > 0 ? `${Math.max(0, Math.floor(cancelledReplyCount))} active text ${cancelledReplyCount === 1 ? "reply" : "replies"}` : null,
    cancelledQueuedReplyCount > 0 ? `${Math.max(0, Math.floor(cancelledQueuedReplyCount))} queued ${cancelledQueuedReplyCount === 1 ? "reply" : "replies"}` : null,
    browserCancelled ? "an active browser task" : null,
    swarmCancelledCount > 0 ? `${Math.max(0, Math.floor(swarmCancelledCount))} running code ${swarmCancelledCount === 1 ? "task" : "tasks"}` : null
  ].filter(Boolean);

  try {
    const generation = await llm.generate({
      settings,
      systemPrompt: [
        `You are ${botName}.`,
        "The user just cancelled work you were doing in a text chat.",
        "Reply with exactly one short natural acknowledgement.",
        "Do not continue, resume, summarize, or restart the cancelled task."
      ].join(" "),
      userPrompt: [
        `User: ${normalizedAuthorName}`,
        `Cancel message: "${normalizedCancelText}"`,
        `Interrupted work: ${interruptedSystems.length ? interruptedSystems.join(", ") : "none"}.`,
        "Write one brief conversational sentence acknowledging that you stopped."
      ].join("\n"),
      trace: {
        guildId,
        channelId,
        userId,
        source: "text_cancel_acknowledgement",
        event: "text_cancel_acknowledgement",
        messageId
      },
      signal
    });
    return normalizeAcknowledgementText(generation?.text);
  } catch {
    return null;
  }
}
