import fs from "node:fs/promises";
import path from "node:path";
import { clampInt, normalizeInlineText, parseMemoryExtractionJson } from "../llm/llmHelpers.ts";
import { estimateUsdCost } from "../llm/pricing.ts";
import {
  getBotName,
  getMemorySettings,
  getPersonaSettings,
  getResolvedMemoryBinding,
  getResolvedOrchestratorBinding,
  getReplyGenerationSettings
} from "../settings/agentStack.ts";
import { parseDailyEntryLineWithScope } from "./memoryHelpers.ts";

type ParsedEntry = {
  timestampIso: string;
  timestampMs: number;
  author: string;
  authorId: string | null;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  isVoice: boolean;
  content: string;
};

type ReflectionFact = {
  subject: string;
  subjectName: string;
  fact: string;
  type: string;
  confidence: number;
  evidence: string;
  supersedes?: string;
};

type ReflectionSaveResult = ReflectionFact & {
  scope: string;
  subjectOverride: string | null;
  userId: string | null;
  status: "saved" | "skipped";
  saveReason: string;
  storedFact: string | null;
  storedSubject: string | null;
};

type ReflectionUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type ReflectionModelResponse = {
  text?: string;
  usage?: Partial<ReflectionUsage> | null;
};

type ReflectionPassMetadata = {
  name: "direct";
  provider: string;
  model: string;
  usdCost: number;
  usage: ReflectionUsage;
  rawResponseText: string;
  factCount: number;
};

type ReflectionSettings = {
  botName?: string;
  llm?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    pricing?: Record<string, number>;
  };
  memoryLlm?: {
    provider?: string;
    model?: string;
  };
  memory?: {
    enabled?: boolean;
    reflection?: {
      enabled?: boolean;
      maxFactsPerReflection?: number;
    };
  };
};

type ReflectionStore = {
  logAction(args: {
    kind: string;
    guildId?: string | null;
    content: string;
    usdCost?: number;
    metadata?: Record<string, unknown>;
  }): void;
  hasReflectionBeenCompleted(dateKey: string, guildId: string): boolean;
};

type ExistingFactRow = {
  id?: number;
  subject: string;
  fact: string;
  fact_type: string;
};

type ReflectionMemory = {
  memoryDirPath: string;
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
    supersedesFactText?: string | null;
  }): Promise<{
    ok: boolean;
    reason?: string;
    factText?: string;
    subject?: string;
    isNew?: boolean;
  }>;
};

type ReflectionLlm = {
  resolveProviderAndModel(llmSettings: Record<string, unknown>): {
    provider: string;
    model: string;
  };
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
  ): Promise<ReflectionModelResponse>;
};

const REFLECTION_FACTS_JSON_SCHEMA = JSON.stringify({
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
          evidence: { type: "string", minLength: 1, maxLength: 220 },
          supersedes: { type: "string", maxLength: 200 }
        },
        required: ["subject", "subjectName", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
});

function normalizeReflectionUsage(usage: Partial<ReflectionUsage> | null | undefined): ReflectionUsage {
  return {
    inputTokens: Math.max(0, Number(usage?.inputTokens) || 0),
    outputTokens: Math.max(0, Number(usage?.outputTokens) || 0),
    cacheWriteTokens: Math.max(0, Number(usage?.cacheWriteTokens) || 0),
    cacheReadTokens: Math.max(0, Number(usage?.cacheReadTokens) || 0)
  };
}

function addReflectionUsage(target: ReflectionUsage, next: ReflectionUsage) {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.cacheWriteTokens += next.cacheWriteTokens;
  target.cacheReadTokens += next.cacheReadTokens;
}

function normalizeReflectionFacts(rawText: string, maxFacts: number): ReflectionFact[] {
  const parsed = parseMemoryExtractionJson(rawText);
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts: ReflectionFact[] = [];
  const validSubjects = new Set(["author", "bot", "lore"]);

  for (const item of rawFacts) {
    if (!item || typeof item !== "object") continue;

    const subject = String(item.subject || "").trim().toLowerCase();
    const fact = normalizeInlineText(item.fact, 190);
    const evidence = normalizeInlineText(item.evidence, 220);
    if (!validSubjects.has(subject) || !fact || !evidence) continue;

    const supersedes = normalizeInlineText(item.supersedes, 200) || "";
    facts.push({
      subject,
      subjectName: normalizeInlineText(item.subjectName, 80) || "",
      fact,
      type: String(item.type || "other").trim().toLowerCase() || "other",
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      evidence,
      ...(supersedes ? { supersedes } : {})
    });
    if (facts.length >= maxFacts) break;
  }

  return facts;
}

function buildReflectionOnePassPrompts({
  dateKey,
  maxFacts,
  authorNames,
  normalizedBotName,
  persona,
  journalText
}: {
  dateKey: string;
  maxFacts: number;
  authorNames: string;
  normalizedBotName: string;
  persona: string;
  journalText: string;
}) {
  const systemPrompt = [
    `You are ${normalizedBotName}. It's the end of ${dateKey} and you're looking back at today's conversations.`,
    persona ? `Your persona: ${persona}` : "",
    "",
    "Think about what happened today like a real friend would. What stuck with you? What would you want to remember next time you talk to these people?",
    "",
    "The things worth remembering:",
    "- Something someone revealed about their life — a relationship, a struggle, a win, a change in their situation",
    "- A preference or opinion they feel strongly about (not just mentioned in passing)",
    "- An inside joke, a shared moment, a callback that would make a future conversation better",
    "- When someone's vibe shifted — they opened up, got real, or showed a side of themselves you hadn't seen",
    "- Something they asked you to remember or a way they want you to be",
    "",
    "Don't bother saving:",
    "- Mundane back-and-forth that won't matter tomorrow",
    "- Things you already know (check the existing facts below if provided)",
    "- Stuff that's basically the same fact worded differently — merge into the best version using the supersedes field (set supersedes to the exact existing fact text being replaced)",
    "- Anything about your own built-in capabilities — you already know what you can do",
    "",
    "For each fact, note who it's about:",
    `- subject=author for facts about a specific person. Set subjectName to their exact display name. Authors today: ${authorNames}.`,
    `- subject=bot only when a user explicitly told ${normalizedBotName} something about itself (a nickname, a personality trait to adopt, an identity thing). Not your default behavior.`,
    "- subject=lore for shared context that isn't about one person (server lore, group dynamics, recurring bits).",
    "",
    `Write all fact text from your own perspective — use "me", "I", "my" instead of your name. Example: "tiny conk told me to call them pookie conk" not "tiny conk told ${normalizedBotName} to call them pookie conk".`,
    "",
    "Lines marked `vc` are voice transcripts — speech-to-text can mishear words, drop context, or mangle names. If a fact from voice feels off or doesn't quite make sense, trust your gut and skip it or lower the confidence.",
    "",
    "Use confidence to signal how sure you are: 0.9+ for stuff they clearly said or typed, lower for things you're inferring or that came from noisy voice transcripts.",
    "Evidence should be a short quote or excerpt from the journal that best supports the fact.",
    "",
    `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<display name if author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"short quote or excerpt"}]}.`,
    "If nothing worth remembering happened today, return {\"facts\":[]}. That's fine — not every day is memorable."
  ].filter(Boolean).join("\n");

  const userPrompt = [`Date: ${dateKey}`, `Max facts: ${maxFacts}`, `Journal:\n${journalText}`].join("\n");
  return { systemPrompt, userPrompt };
}

async function runReflectionPass({
  llm,
  provider,
  model,
  systemPrompt,
  userPrompt,
  settings,
  maxFacts
}: {
  llm: ReflectionLlm;
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  settings: ReflectionSettings;
  maxFacts: number;
}) {
  const orchestratorBinding = getResolvedOrchestratorBinding(settings);
  const replyGeneration = getReplyGenerationSettings(settings);
  const response = await llm.callChatModel(provider, {
    model,
    systemPrompt,
    userPrompt,
    temperature: Number(orchestratorBinding.temperature) || 0.9,
    maxOutputTokens: Number(orchestratorBinding.maxOutputTokens) || 2500,
    jsonSchema: REFLECTION_FACTS_JSON_SCHEMA
  });

  const usage = normalizeReflectionUsage(response.usage);
  const usdCost = estimateUsdCost({
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    customPricing: replyGeneration.pricing
  });
  const rawResponseText = String(response.text || "");
  const facts = normalizeReflectionFacts(rawResponseText, maxFacts);

  return {
    facts,
    metadata: {
      name: "direct",
      provider,
      model,
      usdCost,
      usage,
      rawResponseText,
      factCount: facts.length
    } satisfies ReflectionPassMetadata
  };
}

export async function runDailyReflection({
  memory,
  store,
  llm,
  settings
}: {
  memory: ReflectionMemory;
  store: ReflectionStore;
  llm: ReflectionLlm;
  settings: ReflectionSettings;
}) {
  if (!settings?.memory?.enabled || !settings?.memory?.reflection?.enabled) {
    return;
  }

  const memoryDirPath = memory.memoryDirPath;
  if (!memoryDirPath) return;

  try {
    const files = await fs.readdir(memoryDirPath);
    const mdFiles = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort();
    if (!mdFiles.length) return;

    const todayDateKey = new Date().toISOString().split("T")[0];

    for (const file of mdFiles) {
      const dateKey = file.replace(".md", "");
      const fullPath = path.join(memoryDirPath, file);

      if (dateKey >= todayDateKey) continue;

      const reflectedPath = `${fullPath}.reflected`;
      try {
        await fs.rm(reflectedPath, { force: true });
      } catch {
        // Legacy companion files are ignored after best-effort cleanup.
      }

      const rawContent = await fs.readFile(fullPath, "utf8");
      const lines = rawContent.split("\n").filter((line) => line.startsWith("- "));
      if (!lines.length) continue;

      const entries: ParsedEntry[] = [];
      for (const line of lines) {
        const parsed = parseDailyEntryLineWithScope(line);
        if (parsed) entries.push(parsed);
      }
      if (!entries.length) continue;

      const byGuild = new Map<string, ParsedEntry[]>();
      for (const entry of entries) {
        const scopedGuildId = entry.guildId || "unknown";
        const existing = byGuild.get(scopedGuildId) || [];
        existing.push(entry);
        byGuild.set(scopedGuildId, existing);
      }

      for (const [guildId, guildEntries] of byGuild.entries()) {
        if (guildId === "unknown") continue;
        if (store.hasReflectionBeenCompleted(dateKey, guildId)) continue;

        await reflectGuildJournal({
          dateKey,
          guildId,
          guildEntries,
          memory,
          store,
          llm,
          settings
        });
      }
    }
  } catch (error) {
    store.logAction({
      kind: "memory_reflection_error",
      content: String(error instanceof Error ? error.message : error)
    });
  }
}

async function reflectGuildJournal({
  dateKey,
  guildId,
  guildEntries,
  memory,
  store,
  llm,
  settings
}: {
  dateKey: string;
  guildId: string;
  guildEntries: ParsedEntry[];
  memory: ReflectionMemory;
  store: ReflectionStore;
  llm: ReflectionLlm;
  settings: ReflectionSettings;
}) {
  const reflectionRunId = `reflection_${dateKey}_${guildId}_${Date.now()}`;
  const usageTotals = normalizeReflectionUsage(null);
  const reflectionPasses: ReflectionPassMetadata[] = [];
  let provider = "";
  let model = "";
  let maxFacts = 0;
  let authorCount = 0;

  try {
    const memorySettings = getMemorySettings(settings);
    const memoryBinding = getResolvedMemoryBinding(settings);
    const nameToAuthorId = new Map<string, string>();
    for (const entry of guildEntries) {
      if (entry.author && entry.authorId) {
        nameToAuthorId.set(entry.author.toLowerCase(), entry.authorId);
      }
    }

    const journalText = guildEntries
      .map((entry) => {
        const time = entry.timestampIso ? entry.timestampIso.split("T")[1]?.replace("Z", "") || "" : "";
        const channel = entry.channelId ? ` #${entry.channelId}` : "";
        const medium = entry.isVoice ? " vc" : "";
        return `- [${time}${channel}${medium}] ${entry.author}: ${entry.content}`;
      })
      .join("\n");

    maxFacts = clampInt(memorySettings.reflection?.maxFactsPerReflection || 20, 1, 100);
    const normalizedBotName = normalizeInlineText(getBotName(settings) || "the bot", 80) || "the bot";
    const authorList = [...new Set(guildEntries.map((entry) => entry.author).filter(Boolean))];
    const authorNames = authorList.join(", ");
    authorCount = authorList.length;

    // Load existing facts so the reflection model can avoid producing duplicates.
    let existingFactsSummary = "";
    if (typeof memory.loadExistingFactsForReflection === "function") {
      const subjectIds = [...nameToAuthorId.values(), "__self__", "__lore__"];
      const existingFacts = memory.loadExistingFactsForReflection({ guildId, subjectIds });
      if (existingFacts.length > 0) {
        const lines = existingFacts.map((f) => `- [${f.subject}] (fact: "${f.fact}")`);
        existingFactsSummary = `\n\nAlready in memory (do not duplicate — skip or merge if today's journal says the same thing differently):\n${lines.join("\n")}`;
      }
    }

    provider = memoryBinding.provider;
    model = memoryBinding.model;

    store.logAction({
      kind: "memory_reflection_start",
      guildId,
      content: `Reflecting on ${dateKey} guild:${guildId} via ${provider}:${model}`,
      metadata: {
        runId: reflectionRunId,
        dateKey,
        guildId,
        provider,
        model,
        maxFacts,
        journalEntryCount: guildEntries.length,
        authorCount
      }
    });

    let extractedFacts: ReflectionFact[] = [];
    let selectedFacts: ReflectionFact[] = [];
    let rawResponseText = "";

    const personaSettings = getPersonaSettings(settings);
    const persona = String(personaSettings?.flavor || "").trim();

    const journalTextWithExisting = journalText + existingFactsSummary;
    const { systemPrompt, userPrompt } = buildReflectionOnePassPrompts({
      dateKey,
      maxFacts,
      authorNames,
      normalizedBotName,
      persona,
      journalText: journalTextWithExisting
    });
    const directPass = await runReflectionPass({
      llm,
      provider,
      model,
      systemPrompt,
      userPrompt,
      settings,
      maxFacts
    });
    extractedFacts = directPass.facts;
    selectedFacts = directPass.facts;
    rawResponseText = directPass.metadata.rawResponseText;
    reflectionPasses.push(directPass.metadata);
    addReflectionUsage(usageTotals, directPass.metadata.usage);

    const savedFacts: ReflectionSaveResult[] = [];
    const skippedFacts: ReflectionSaveResult[] = [];
    let factsAdded = 0;

    for (const item of selectedFacts) {
      let scope = "lore";
      if (item.subject === "author") scope = "user";
      if (item.subject === "bot") scope = "self";

      let subjectOverride: string | null = null;
      let userId: string | null = null;
      if (scope === "user" && item.subjectName) {
        const resolvedId = nameToAuthorId.get(item.subjectName.toLowerCase());
        if (resolvedId) {
          subjectOverride = resolvedId;
          userId = resolvedId;
        }
      }

      if (scope === "user" && !subjectOverride) {
        skippedFacts.push({
          ...item,
          scope,
          subjectOverride: null,
          userId: null,
          status: "skipped",
          saveReason: "unresolved_author_subject",
          storedFact: null,
          storedSubject: null
        });
        continue;
      }

      const saveResult = await memory.rememberDirectiveLineDetailed({
        line: item.fact,
        sourceMessageId: `reflection_${dateKey}_${guildId}`,
        userId,
        guildId,
        channelId: null,
        sourceText: journalText,
        scope,
        subjectOverride,
        factType: item.type,
        confidence: item.confidence,
        validationMode: "minimal",
        evidenceText: item.evidence || null,
        supersedesFactText: item.supersedes || null
      });

      if (saveResult?.ok) {
        if (saveResult.isNew) factsAdded += 1;
        savedFacts.push({
          ...item,
          scope,
          subjectOverride,
          userId,
          status: "saved",
          saveReason: String(saveResult.reason || "saved"),
          storedFact: String(saveResult.factText || ""),
          storedSubject: String(saveResult.subject || subjectOverride || "")
        });
        continue;
      }

      skippedFacts.push({
        ...item,
        scope,
        subjectOverride,
        userId,
        status: "skipped",
        saveReason: String(saveResult?.reason || "save_failed"),
        storedFact: null,
        storedSubject: null
      });
    }

    const totalUsdCost = reflectionPasses.reduce((sum, pass) => sum + pass.usdCost, 0);

    store.logAction({
      kind: "memory_reflection_complete",
      guildId,
      content:
        `Completed reflection for ${dateKey} guild:${guildId}, extracted ${extractedFacts.length}, ` +
        `selected ${selectedFacts.length}, added ${factsAdded} facts.`,
      usdCost: totalUsdCost,
      metadata: {
        runId: reflectionRunId,
        dateKey,
        guildId,
        provider,
        model,
        maxFacts,
        journalEntryCount: guildEntries.length,
        authorCount,
        factsExtracted: extractedFacts.length,
        factsSelected: selectedFacts.length,
        factsAdded,
        factsSaved: savedFacts.length,
        factsSkipped: skippedFacts.length,
        rawResponseText,
        extractedFacts,
        selectedFacts,
        savedFacts,
        skippedFacts,
        usage: usageTotals,
        reflectionPasses
      }
    });
  } catch (error) {
    store.logAction({
      kind: "memory_reflection_error",
      guildId,
      content: `Failed reflection for ${dateKey} guild:${guildId}: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        runId: reflectionRunId,
        dateKey,
        guildId,
        provider: provider || null,
        model: model || null,
        maxFacts: maxFacts || null,
        journalEntryCount: guildEntries.length,
        authorCount: authorCount || null
      }
    });
  }
}
