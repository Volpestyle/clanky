import { normalizeInlineText, parseMemoryExtractionJson } from "../llm/llmHelpers.ts";
import {
  getBotName,
  getMemorySettings,
  getResolvedMemoryBinding
} from "../settings/agentStack.ts";

type MicroReflectionEntry = {
  timestampIso: string;
  timestampMs: number;
  author: string;
  authorId: string | null;
  isBot: boolean;
  content: string;
};

type MicroReflectionFact = {
  subject: string;
  subjectName: string;
  fact: string;
  type: string;
  confidence: number;
  evidence: string;
};

type MicroReflectionSettings = Record<string, unknown> & {
  memory?: {
    enabled?: boolean;
    reflection?: {
      enabled?: boolean;
    };
  };
};

type ExistingFactRow = {
  subject: string;
  fact: string;
  fact_type: string;
};

type MicroReflectionMemory = {
  loadExistingFactsForReflection?(args: {
    guildId: string;
    subjectIds: string[];
  }): ExistingFactRow[];
  rememberDirectiveLineDetailed(args: {
    line: string;
    sourceMessageId: string;
    userId: string | null;
    guildId: string;
    channelId?: string | null;
    sourceText?: string;
    scope?: string;
    subjectOverride?: string | null;
    factType?: string | null;
    confidence?: number | null;
    validationMode?: string;
    evidenceText?: string | null;
  }): Promise<{
    ok: boolean;
    reason?: string;
    factText?: string;
    subject?: string;
    isNew?: boolean;
  }>;
};

type MicroReflectionStore = {
  logAction(args: {
    kind: string;
    guildId?: string | null;
    channelId?: string | null;
    content: string;
    metadata?: Record<string, unknown> | null;
  }): void;
};

type MicroReflectionLlm = {
  callChatModel(
    provider: string,
    payload: {
      model: string;
      systemPrompt: string;
      userPrompt: string;
      temperature?: number;
      maxOutputTokens?: number;
      jsonSchema?: string;
    }
  ): Promise<{
    text?: string;
  }>;
};

const MICRO_REFLECTION_FACTS_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", enum: ["author", "bot", "lore"] },
          subjectName: { type: "string", maxLength: 80 },
          fact: { type: "string", minLength: 1, maxLength: 190 },
          type: { type: "string", enum: ["preference", "profile", "relationship", "project", "other"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: 220 }
        },
        required: ["subject", "subjectName", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
});

const MICRO_REFLECTION_MAX_FACTS = 8;
const MICRO_REFLECTION_MAX_ENTRIES = 80;
const MICRO_REFLECTION_MAX_TOTAL_CHARS = 9_000;

function normalizeMicroReflectionFacts(rawText: string, maxFacts: number): MicroReflectionFact[] {
  const parsed = parseMemoryExtractionJson(rawText);
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts: MicroReflectionFact[] = [];
  const validSubjects = new Set(["author", "bot", "lore"]);

  for (const item of rawFacts) {
    if (!item || typeof item !== "object") continue;

    const subject = String(item.subject || "").trim().toLowerCase();
    const fact = normalizeInlineText(item.fact, 190);
    const evidence = normalizeInlineText(item.evidence, 220);
    if (!validSubjects.has(subject) || !fact || !evidence) continue;

    facts.push({
      subject,
      subjectName: normalizeInlineText(item.subjectName, 80) || "",
      fact,
      type: String(item.type || "other").trim().toLowerCase() || "other",
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      evidence
    });
    if (facts.length >= maxFacts) break;
  }

  return facts;
}

function buildMicroReflectionPrompts({
  trigger,
  authorNames,
  botName,
  maxFacts,
  conversationText
}: {
  trigger: string;
  authorNames: string;
  botName: string;
  maxFacts: number;
  conversationText: string;
}) {
  const systemPrompt = [
    `You are performing session-end micro-reflection for a ${trigger} conversation that just went quiet.`,
    "Review only this recent conversation excerpt and decide what deserves durable memory right now.",
    "Be selective. Prefer a few stable, useful facts over weak or noisy memories.",
    "Focus on durable preferences, identity, relationships, ongoing projects, and stable shared lore.",
    "Ignore fleeting reactions, one-off requests, jokes, tactical back-and-forth, and ephemeral chatter.",
    "Every fact must be grounded directly in the conversation excerpt.",
    "If multiple candidates say the same thing in different words, keep only the best version.",
    "Classify each fact subject as one of: author, bot, lore.",
    `Use subject=author for facts about a specific user. Include subjectName with the author's exact display name from the excerpt. Authors in this excerpt: ${authorNames}.`,
    `Use subject=bot only for explicit durable facts about ${botName} that were USER-ASSIGNED (e.g. nicknames, personality traits the user told it to adopt, or identity changes). Do NOT extract facts describing the bot's built-in capabilities or default behavior (responding to requests, playing music, answering questions, etc.) — those are inherent, not durable memories.`,
    "Use subject=lore for stable shared context not tied to one person.",
    `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<author display name if subject=author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"exact short quote"}]}.`,
    "If nothing should be saved, return {\"facts\":[]}."
  ].join("\n");

  const userPrompt = [`Max facts: ${maxFacts}`, `Conversation excerpt:\n${conversationText}`].join("\n\n");
  return { systemPrompt, userPrompt };
}

function buildBoundedConversationText(entries: MicroReflectionEntry[]) {
  const rows = Array.isArray(entries) ? entries : [];
  const bounded: MicroReflectionEntry[] = [];
  let totalChars = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const entry = rows[index];
    const author = normalizeInlineText(entry?.author, 80) || "unknown";
    const content = normalizeInlineText(entry?.content, 240);
    if (!content) continue;
    const line = `- ${author}: ${content}`;
    const nextTotal = totalChars + line.length + (bounded.length > 0 ? 1 : 0);
    if (bounded.length >= MICRO_REFLECTION_MAX_ENTRIES || nextTotal > MICRO_REFLECTION_MAX_TOTAL_CHARS) {
      break;
    }
    bounded.push({
      ...entry,
      author,
      content
    });
    totalChars = nextTotal;
  }

  const ordered = bounded.reverse();
  return {
    entries: ordered,
    text: ordered.map((entry) => `- ${entry.author}: ${entry.content}`).join("\n")
  };
}

export async function runMicroReflection({
  memory,
  store: _store,
  llm,
  settings,
  guildId,
  channelId = null,
  trigger,
  sourceMessageId,
  entries
}: {
  memory: MicroReflectionMemory;
  store: MicroReflectionStore;
  llm: MicroReflectionLlm;
  settings: MicroReflectionSettings;
  guildId: string;
  channelId?: string | null;
  trigger: "voice_session_end" | "text_channel_silence";
  sourceMessageId: string;
  entries: MicroReflectionEntry[];
}) {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return { ok: false, reason: "guild_required" as const };
  if (!settings?.memory?.enabled || !getMemorySettings(settings).reflection?.enabled) {
    return { ok: false, reason: "memory_reflection_disabled" as const };
  }

  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      timestampIso: String(entry?.timestampIso || "").trim(),
      timestampMs: Number(entry?.timestampMs) || 0,
      author: normalizeInlineText(entry?.author, 80) || "unknown",
      authorId: String(entry?.authorId || "").trim() || null,
      isBot: Boolean(entry?.isBot),
      content: normalizeInlineText(entry?.content, 240)
    }))
    .filter((entry) => entry.content)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const humanEntries = normalizedEntries.filter((entry) => !entry.isBot);
  const totalChars = normalizedEntries.reduce((sum, entry) => sum + entry.content.length, 0);
  if (normalizedEntries.length < 2 || humanEntries.length < 1 || totalChars < 80) {
    return { ok: false, reason: "conversation_too_small" as const };
  }

  const boundedConversation = buildBoundedConversationText(normalizedEntries);
  if (!boundedConversation.entries.length || !boundedConversation.text) {
    return { ok: false, reason: "conversation_empty" as const };
  }

  const botName = normalizeInlineText(getBotName(settings) || "the bot", 80) || "the bot";
  const authorList = [
    ...new Set(
      boundedConversation.entries
        .filter((entry) => !entry.isBot)
        .map((entry) => entry.author)
        .filter(Boolean)
    )
  ];
  const authorNames = authorList.join(", ");
  const nameToAuthorId = new Map<string, string>();
  for (const entry of boundedConversation.entries) {
    if (entry.isBot || !entry.authorId) continue;
    nameToAuthorId.set(entry.author.toLowerCase(), entry.authorId);
  }

  let existingFactsSummary = "";
  if (typeof memory.loadExistingFactsForReflection === "function") {
    const subjectIds = [
      ...new Set([
        ...boundedConversation.entries
          .filter((entry) => !entry.isBot)
          .map((entry) => String(entry.authorId || "").trim())
          .filter(Boolean),
        "__self__",
        "__lore__"
      ])
    ];
    const existingFacts = memory.loadExistingFactsForReflection({
      guildId: normalizedGuildId,
      subjectIds
    });
    if (existingFacts.length > 0) {
      const lines = existingFacts.map((fact) => `- [${fact.subject}] ${fact.fact}`);
      existingFactsSummary =
        "\n\nAlready in durable memory (do not duplicate; merge with the better wording if needed):\n" +
        lines.join("\n");
    }
  }

  const memoryBinding = getResolvedMemoryBinding(settings);
  const { systemPrompt, userPrompt } = buildMicroReflectionPrompts({
    trigger: trigger === "voice_session_end" ? "voice session" : "text channel",
    authorNames,
    botName,
    maxFacts: MICRO_REFLECTION_MAX_FACTS,
    conversationText: boundedConversation.text + existingFactsSummary
  });
  const response = await llm.callChatModel(memoryBinding.provider, {
    model: memoryBinding.model,
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxOutputTokens: 1_200,
    jsonSchema: MICRO_REFLECTION_FACTS_JSON_SCHEMA
  });
  const facts = normalizeMicroReflectionFacts(String(response?.text || ""), MICRO_REFLECTION_MAX_FACTS);
  if (!facts.length) {
    return { ok: true, reason: "no_facts_selected" as const, savedCount: 0 };
  }

  let savedCount = 0;
  const conversationGroundingText = boundedConversation.text;
  const fallbackSingleAuthorId = authorList.length === 1
    ? nameToAuthorId.get(authorList[0].toLowerCase()) || null
    : null;

  for (const fact of facts) {
    let scope: "user" | "self" | "lore" = "lore";
    if (fact.subject === "author") scope = "user";
    if (fact.subject === "bot") scope = "self";
    if (trigger === "text_channel_silence" && scope === "self") {
      continue;
    }

    let subjectOverride: string | null = null;
    let userId: string | null = null;
    if (scope === "user") {
      subjectOverride =
        nameToAuthorId.get(String(fact.subjectName || "").trim().toLowerCase()) ||
        fallbackSingleAuthorId ||
        null;
      userId = subjectOverride;
    }
    if (scope === "user" && !subjectOverride) {
      continue;
    }

    const saveResult = await memory.rememberDirectiveLineDetailed({
      line: fact.fact,
      sourceMessageId,
      userId,
      guildId: normalizedGuildId,
      channelId: String(channelId || "").trim() || null,
      sourceText: conversationGroundingText,
      scope,
      subjectOverride,
      factType: fact.type,
      confidence: fact.confidence,
      validationMode: "minimal",
      evidenceText: fact.evidence || null
    });
    if (saveResult?.ok) {
      savedCount += 1;
    }
  }

  return {
    ok: true,
    reason: "completed" as const,
    savedCount
  };
}
