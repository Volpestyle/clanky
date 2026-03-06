import fs from "node:fs/promises";
import path from "node:path";
import { clampInt, normalizeInlineText, parseMemoryExtractionJson } from "../llm/llmHelpers.ts";
import { estimateUsdCost } from "../pricing.ts";
import {
  getBotName,
  getMemorySettings,
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
  content: string;
};

type ReflectionStrategy = "one_pass_main" | "two_pass_extract_then_main";

type ReflectionFact = {
  subject: string;
  subjectName: string;
  fact: string;
  type: string;
  confidence: number;
  evidence: string;
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
  name: "extract" | "select" | "direct";
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
    dailyLogRetentionDays?: number;
    reflection?: {
      enabled?: boolean;
      strategy?: string;
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

type ReflectionMemory = {
  memoryDirPath: string;
  rememberDirectiveLineDetailed(args: {
    line: string;
    sourceMessageId: string;
    userId: string | null;
    guildId: string;
    channelId?: string | null;
    sourceText?: string;
    scope?: string;
    subjectOverride?: string | null;
    validationMode?: string;
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
  callMemoryExtractionModel(
    provider: string,
    payload: {
      model: string;
      systemPrompt: string;
      userPrompt: string;
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
          evidence: { type: "string", minLength: 1, maxLength: 220 }
        },
        required: ["subject", "fact", "type", "confidence", "evidence"]
      }
    }
  },
  required: ["facts"]
});

function resolveReflectionStrategy(value: unknown): ReflectionStrategy {
  return String(value || "").trim().toLowerCase() === "one_pass_main"
    ? "one_pass_main"
    : "two_pass_extract_then_main";
}

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

function buildReflectionExtractionPrompts({
  dateKey,
  maxFacts,
  authorNames,
  normalizedBotName,
  journalText
}: {
  dateKey: string;
  maxFacts: number;
  authorNames: string;
  normalizedBotName: string;
  journalText: string;
}) {
  const systemPrompt = [
    `You are performing the extraction pass of daily reflection for ${dateKey}.`,
    "Read the day's conversation journal and extract candidate durable facts worth considering for long-term memory.",
    "Focus on stable preferences, identity, ongoing projects, recurring relationships, important events, and persistent shared lore.",
    "Ignore greetings, throwaway banter, jokes, one-off requests, and ephemeral chatter.",
    "Every fact must be grounded directly in the journal text.",
    "Classify each fact subject as one of: author, bot, lore.",
    `Use subject=author for facts about a specific user. Include subjectName with the author's exact display name from the journal. Authors in this journal: ${authorNames}.`,
    `Use subject=bot only for explicit durable facts about ${normalizedBotName}.`,
    "Use subject=lore for stable shared context not tied to a single person.",
    "Be inclusive in this extraction pass, but do not invent or speculate.",
    `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<author display name if subject=author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"exact short quote"}]}.`,
    "If there are no viable candidates, return {\"facts\":[]}."
  ].join("\n");

  const userPrompt = [`Date: ${dateKey}`, `Max facts: ${maxFacts}`, `Journal:\n${journalText}`].join("\n");
  return { systemPrompt, userPrompt };
}

function buildReflectionOnePassPrompts({
  dateKey,
  maxFacts,
  authorNames,
  normalizedBotName,
  journalText
}: {
  dateKey: string;
  maxFacts: number;
  authorNames: string;
  normalizedBotName: string;
  journalText: string;
}) {
  const systemPrompt = [
    `You are performing daily reflection for ${dateKey}.`,
    "Read the day's conversation journal and decide which facts should actually be saved into durable memory.",
    "Be selective. Prefer fewer high-signal memories over many weak ones.",
    "Only keep facts that are clearly durable, specific, and worth remembering later.",
    "Drop facts that are ambiguous, ephemeral, redundant, or weakly supported.",
    "Every fact must be grounded directly in the journal text.",
    "Classify each fact subject as one of: author, bot, lore.",
    `Use subject=author for facts about a specific user. Include subjectName with the author's exact display name from the journal. Authors in this journal: ${authorNames}.`,
    `Use subject=bot only for explicit durable facts about ${normalizedBotName}.`,
    "Use subject=lore for stable shared context not tied to a single person.",
    `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<author display name if subject=author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"exact short quote"}]}.`,
    "If nothing should be saved, return {\"facts\":[]}."
  ].join("\n");

  const userPrompt = [`Date: ${dateKey}`, `Max facts: ${maxFacts}`, `Journal:\n${journalText}`].join("\n");
  return { systemPrompt, userPrompt };
}

function buildReflectionSelectionPrompts({
  dateKey,
  maxFacts,
  authorNames,
  normalizedBotName,
  journalText,
  extractedFacts
}: {
  dateKey: string;
  maxFacts: number;
  authorNames: string;
  normalizedBotName: string;
  journalText: string;
  extractedFacts: ReflectionFact[];
}) {
  const systemPrompt = [
    `You are performing the final memory-selection pass for daily reflection on ${dateKey}.`,
    "A cheaper model already extracted candidate durable facts from the journal.",
    "Your job is to decide which candidate facts should actually become durable memory.",
    "Be selective. Keep only candidates that are clearly durable, grounded, and worth remembering later.",
    "Drop candidates that are weak, redundant, speculative, overly ephemeral, or not actually durable.",
    "Do not invent new facts outside the candidate list.",
    "You may rewrite accepted facts slightly for cleaner durable phrasing, but preserve the meaning and keep the evidence grounded.",
    "Classify each fact subject as one of: author, bot, lore.",
    `Use subject=author for facts about a specific user. Include subjectName with the author's exact display name from the journal. Authors in this journal: ${authorNames}.`,
    `Use subject=bot only for explicit durable facts about ${normalizedBotName}.`,
    "Use subject=lore for stable shared context not tied to a single person.",
    `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<author display name if subject=author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"exact short quote"}]}.`,
    "If no candidates should be saved, return {\"facts\":[]}."
  ].join("\n");

  const userPrompt = [
    `Date: ${dateKey}`,
    `Max facts to save: ${maxFacts}`,
    `Candidate facts:\n${JSON.stringify({ facts: extractedFacts }, null, 2)}`,
    `Journal:\n${journalText}`
  ].join("\n\n");

  return { systemPrompt, userPrompt };
}

async function runReflectionPass({
  llm,
  provider,
  model,
  mode,
  systemPrompt,
  userPrompt,
  settings,
  maxFacts
}: {
  llm: ReflectionLlm;
  provider: string;
  model: string;
  mode: "extract" | "select" | "direct";
  systemPrompt: string;
  userPrompt: string;
  settings: ReflectionSettings;
  maxFacts: number;
}) {
  const orchestratorBinding = getResolvedOrchestratorBinding(settings);
  const replyGeneration = getReplyGenerationSettings(settings);
  const response =
    mode === "extract"
      ? await llm.callMemoryExtractionModel(provider, {
          model,
          systemPrompt,
          userPrompt
        })
      : await llm.callChatModel(provider, {
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
      name: mode,
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
    const dailyLogRetentionDays = getMemorySettings(settings).dailyLogRetentionDays || 30;
    const pruneDate = new Date();
    pruneDate.setDate(pruneDate.getDate() - dailyLogRetentionDays);
    const pruneDateKey = pruneDate.toISOString().split("T")[0];

    for (const file of mdFiles) {
      const dateKey = file.replace(".md", "");
      const fullPath = path.join(memoryDirPath, file);

      if (dateKey < pruneDateKey) {
        try {
          await fs.rm(fullPath, { force: true });
        } catch (error) {
          store.logAction({
            kind: "memory_reflection_error",
            content: `Failed to prune old journal ${file}: ${error instanceof Error ? error.message : String(error)}`
          });
        }
        continue;
      }

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

export async function rerunDailyReflectionForDateGuild({
  memory,
  store,
  llm,
  settings,
  dateKey,
  guildId
}: {
  memory: ReflectionMemory;
  store: ReflectionStore;
  llm: ReflectionLlm;
  settings: ReflectionSettings;
  dateKey: string;
  guildId: string;
}) {
  if (!settings?.memory?.enabled || !settings?.memory?.reflection?.enabled) {
    throw new Error("daily_reflection_disabled");
  }

  const normalizedDateKey = String(dateKey || "").trim();
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedDateKey || !normalizedGuildId) {
    throw new Error("dateKey_and_guildId_required");
  }

  const memoryDirPath = memory.memoryDirPath;
  if (!memoryDirPath) {
    throw new Error("memory_dir_unavailable");
  }

  const fullPath = path.join(memoryDirPath, `${normalizedDateKey}.md`);
  const rawContent = await fs.readFile(fullPath, "utf8");
  const lines = rawContent.split("\n").filter((line) => line.startsWith("- "));
  if (!lines.length) {
    throw new Error("daily_journal_empty");
  }

  const entries: ParsedEntry[] = [];
  for (const line of lines) {
    const parsed = parseDailyEntryLineWithScope(line);
    if (parsed) entries.push(parsed);
  }
  if (!entries.length) {
    throw new Error("daily_journal_unparseable");
  }

  const guildEntries = entries.filter(
    (entry) => String(entry.guildId || "").trim() === normalizedGuildId
  );
  if (!guildEntries.length) {
    throw new Error("reflection_guild_entries_not_found");
  }

  await reflectGuildJournal({
    dateKey: normalizedDateKey,
    guildId: normalizedGuildId,
    guildEntries,
    memory,
    store,
    llm,
    settings
  });
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
  const strategy = resolveReflectionStrategy(settings?.memory?.reflection?.strategy);
  const usageTotals = normalizeReflectionUsage(null);
  const reflectionPasses: ReflectionPassMetadata[] = [];
  let adjudicatorProvider = "";
  let adjudicatorModel = "";
  let extractorProvider = "";
  let extractorModel = "";
  let maxFacts = 0;
  let authorCount = 0;

  try {
    const memorySettings = getMemorySettings(settings);
    const orchestratorBinding = getResolvedOrchestratorBinding(settings);
    const memoryBinding = getResolvedMemoryBinding(settings);
    const nameToAuthorId = new Map<string, string>();
    for (const entry of guildEntries) {
      if (entry.author && entry.authorId) {
        nameToAuthorId.set(entry.author.toLowerCase(), entry.authorId);
      }
    }

    const journalText = guildEntries
      .map((entry) => `- ${entry.author}: ${entry.content}`)
      .join("\n")
      .slice(0, 100_000);

    maxFacts = clampInt(memorySettings.reflection?.maxFactsPerReflection || 20, 1, 100);
    const normalizedBotName = normalizeInlineText(getBotName(settings) || "the bot", 80) || "the bot";
    const authorList = [...new Set(guildEntries.map((entry) => entry.author).filter(Boolean))];
    const authorNames = authorList.join(", ");
    authorCount = authorList.length;

    adjudicatorProvider = orchestratorBinding.provider;
    adjudicatorModel = orchestratorBinding.model;

    if (strategy === "two_pass_extract_then_main") {
      extractorProvider = memoryBinding.provider;
      extractorModel = memoryBinding.model;
    }

    const startModelLabel =
      strategy === "two_pass_extract_then_main"
        ? `${extractorProvider}:${extractorModel} -> ${adjudicatorProvider}:${adjudicatorModel}`
        : `${adjudicatorProvider}:${adjudicatorModel}`;

    store.logAction({
      kind: "memory_reflection_start",
      guildId,
      content: `Reflecting on ${dateKey} guild:${guildId} via ${startModelLabel}`,
      metadata: {
        runId: reflectionRunId,
        dateKey,
        guildId,
        strategy,
        provider: adjudicatorProvider,
        model: adjudicatorModel,
        extractorProvider: extractorProvider || null,
        extractorModel: extractorModel || null,
        adjudicatorProvider,
        adjudicatorModel,
        maxFacts,
        journalEntryCount: guildEntries.length,
        authorCount
      }
    });

    let extractedFacts: ReflectionFact[] = [];
    let selectedFacts: ReflectionFact[] = [];
    let rawResponseText = "";

    if (strategy === "one_pass_main") {
      const { systemPrompt, userPrompt } = buildReflectionOnePassPrompts({
        dateKey,
        maxFacts,
        authorNames,
        normalizedBotName,
        journalText
      });
      const directPass = await runReflectionPass({
        llm,
        provider: adjudicatorProvider,
        model: adjudicatorModel,
        mode: "direct",
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
    } else {
      const { systemPrompt, userPrompt } = buildReflectionExtractionPrompts({
        dateKey,
        maxFacts,
        authorNames,
        normalizedBotName,
        journalText
      });
      const extractionPass = await runReflectionPass({
        llm,
        provider: extractorProvider,
        model: extractorModel,
        mode: "extract",
        systemPrompt,
        userPrompt,
        settings,
        maxFacts
      });
      extractedFacts = extractionPass.facts;
      rawResponseText = extractionPass.metadata.rawResponseText;
      reflectionPasses.push(extractionPass.metadata);
      addReflectionUsage(usageTotals, extractionPass.metadata.usage);

      if (extractedFacts.length > 0) {
        const selectionPrompts = buildReflectionSelectionPrompts({
          dateKey,
          maxFacts,
          authorNames,
          normalizedBotName,
          journalText,
          extractedFacts
        });
        const selectionPass = await runReflectionPass({
          llm,
          provider: adjudicatorProvider,
          model: adjudicatorModel,
          mode: "select",
          systemPrompt: selectionPrompts.systemPrompt,
          userPrompt: selectionPrompts.userPrompt,
          settings,
          maxFacts
        });
        selectedFacts = selectionPass.facts;
        rawResponseText = selectionPass.metadata.rawResponseText;
        reflectionPasses.push(selectionPass.metadata);
        addReflectionUsage(usageTotals, selectionPass.metadata.usage);
      }
    }

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
        sourceText: item.evidence,
        scope,
        subjectOverride,
        validationMode: "minimal"
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
        strategy,
        provider: adjudicatorProvider,
        model: adjudicatorModel,
        extractorProvider: extractorProvider || null,
        extractorModel: extractorModel || null,
        adjudicatorProvider,
        adjudicatorModel,
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
        strategy,
        provider: adjudicatorProvider || null,
        model: adjudicatorModel || null,
        extractorProvider: extractorProvider || null,
        extractorModel: extractorModel || null,
        adjudicatorProvider: adjudicatorProvider || null,
        adjudicatorModel: adjudicatorModel || null,
        maxFacts: maxFacts || null,
        journalEntryCount: guildEntries.length,
        authorCount: authorCount || null
      }
    });
  }
}
