import fs from "node:fs/promises";
import path from "node:path";
import { parseMemoryExtractionJson, clampInt, normalizeInlineText } from "../llm/llmHelpers.ts";
import { parseDailyEntryLineWithScope } from "./memoryHelpers.ts";
import { estimateUsdCost } from "../pricing.ts";

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

type ReflectionFact = {
  subject: string;
  subjectName: string;
  fact: string;
  type: string;
  confidence: number;
  evidence: string;
};

export async function runDailyReflection({ memory, store, llm, settings }) {
  if (!settings?.memory?.enabled || !settings?.memory?.reflection?.enabled) {
    return;
  }

  const memoryDirPath = memory.memoryDirPath;
  if (!memoryDirPath) return;

  try {
    const files = await fs.readdir(memoryDirPath);
    const mdFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (!mdFiles.length) return;

    const todayDateKey = new Date().toISOString().split("T")[0];
    const dailyLogRetentionDays = settings.memory.dailyLogRetentionDays || 30;
    const pruneDate = new Date();
    pruneDate.setDate(pruneDate.getDate() - dailyLogRetentionDays);
    const pruneDateKey = pruneDate.toISOString().split("T")[0];

    for (const file of mdFiles) {
      const dateKey = file.replace(".md", "");
      const fullPath = path.join(memoryDirPath, file);

      // Prune old journals
      if (dateKey < pruneDateKey) {
        try {
          await fs.rm(fullPath, { force: true });
        } catch (e) {
          store.logAction({
            kind: "memory_reflection_error",
            content: `Failed to prune old journal ${file}: ${e instanceof Error ? e.message : String(e)}`
          });
        }
        continue;
      }

      // Only reflect past days
      if (dateKey >= todayDateKey) continue;

      // Clean up legacy .reflected companion files
      const reflectedPath = `${fullPath}.reflected`;
      try {
        await fs.rm(reflectedPath, { force: true });
      } catch {
        // no companion file to clean — fine
      }

      // Parse all entries from this journal
      const rawContent = await fs.readFile(fullPath, "utf8");
      const lines = rawContent.split("\n").filter(l => l.startsWith("- "));
      if (!lines.length) continue;

      const entries: ParsedEntry[] = [];
      for (const line of lines) {
        const parsed = parseDailyEntryLineWithScope(line);
        if (parsed) entries.push(parsed);
      }
      if (!entries.length) continue;

      // Group entries by guildId
      const byGuild = new Map<string, ParsedEntry[]>();
      for (const entry of entries) {
        const gid = entry.guildId || "unknown";
        let list = byGuild.get(gid);
        if (!list) {
          list = [];
          byGuild.set(gid, list);
        }
        list.push(entry);
      }

      // Reflect each guild separately
      for (const [guildId, guildEntries] of byGuild) {
        if (guildId === "unknown") continue;

        // Check if already reflected via the actions table
        if (store.hasReflectionBeenCompleted(dateKey, guildId)) continue;

        await reflectGuildJournal({ dateKey, guildId, guildEntries, memory, store, llm, settings });
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
  memory: any;
  store: any;
  llm: any;
  settings: any;
}) {
  try {
    // Build a name→authorId map from parsed entries
    const nameToAuthorId = new Map<string, string>();
    for (const entry of guildEntries) {
      if (entry.author && entry.authorId) {
        nameToAuthorId.set(entry.author.toLowerCase(), entry.authorId);
      }
    }

    const journalText = guildEntries
      .map(e => `- ${e.author}: ${e.content}`)
      .join("\n")
      .slice(0, 100_000);

    const maxFacts = clampInt(settings.memory.reflection.maxFactsPerReflection || 20, 1, 100);
    const normalizedBotName = normalizeInlineText(settings.botName || "the bot", 80) || "the bot";

    const authorNames = [...new Set(guildEntries.map(e => e.author))].join(", ");

    const systemPrompt = [
      `You are performing daily reflection on a chat journal for ${dateKey}.`,
      "Review this day's conversations. Extract durable facts worth remembering — things about people, ongoing projects, important events, preferences, and recurring topics.",
      "Ignore throwaway chatter, greetings, and ephemeral requests.",
      "Every fact must be grounded directly in the journal text.",
      "Classify each fact subject as one of: author, bot, lore.",
      `Use subject=author for facts about specific users. Include subjectName with the author's exact display name from the journal. Authors in this journal: ${authorNames}.`,
      `Use subject=bot only for explicit durable facts about ${normalizedBotName}.`,
      "Use subject=lore for stable shared context not tied to a single person.",
      `Return strict JSON only: {"facts":[{"subject":"author|bot|lore","subjectName":"<author display name if subject=author, empty otherwise>","fact":"...","type":"preference|profile|relationship|project|other","confidence":0.0-1.0,"evidence":"exact short quote"}]}.`,
      "If there are no durable facts, return {\"facts\":[]}."
    ].join("\n");

    const userPrompt = [
      `Date: ${dateKey}`,
      `Max facts: ${maxFacts}`,
      `Journal:\n${journalText}`
    ].join("\n");

    const llmOverride = settings.memoryLlm || settings.llm || {};
    const { provider, model } = llm.resolveProviderAndModel(llmOverride);

    store.logAction({
      kind: "memory_reflection_start",
      guildId,
      content: `Reflecting on ${dateKey} guild:${guildId} via ${provider}:${model}`,
      metadata: { dateKey, guildId }
    });

    const response = await llm.callMemoryExtractionModel(provider, {
      model,
      systemPrompt,
      userPrompt
    });

    const costUsd = estimateUsdCost({
      provider,
      model,
      inputTokens: response.usage?.inputTokens || 0,
      outputTokens: response.usage?.outputTokens || 0,
      cacheWriteTokens: response.usage?.cacheWriteTokens || 0,
      cacheReadTokens: response.usage?.cacheReadTokens || 0,
      customPricing: settings?.llm?.pricing
    });

    const parsed = parseMemoryExtractionJson(response.text);
    const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];

    // Normalize facts manually to preserve subjectName
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
        subjectName: String(item.subjectName || "").trim(),
        fact,
        type: String(item.type || "other").trim().toLowerCase(),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
        evidence
      });
      if (facts.length >= maxFacts) break;
    }

    let factsAdded = 0;
    for (const item of facts) {
      let scope = "lore";
      if (item.subject === "author") scope = "user";
      if (item.subject === "bot") scope = "self";

      // Resolve subjectOverride for author-scope facts
      let subjectOverride: string | null = null;
      let userId: string | null = null;
      if (scope === "user" && item.subjectName) {
        const resolvedId = nameToAuthorId.get(item.subjectName.toLowerCase());
        if (resolvedId) {
          subjectOverride = resolvedId;
          userId = resolvedId;
        }
      }

      // Skip author facts where we can't resolve to a real user ID
      if (scope === "user" && !subjectOverride) continue;

      const success = await memory.rememberDirectiveLine({
        line: item.fact,
        sourceMessageId: `reflection_${dateKey}_${guildId}`,
        userId,
        guildId,
        channelId: null,
        sourceText: item.evidence,
        scope,
        subjectOverride
      });
      if (success) factsAdded++;
    }

    store.logAction({
      kind: "memory_reflection_complete",
      guildId,
      content: `Completed reflection for ${dateKey} guild:${guildId}, added ${factsAdded} facts.`,
      usdCost: costUsd,
      metadata: { dateKey, guildId, factsExtracted: facts.length, factsAdded }
    });
  } catch (error) {
    store.logAction({
      kind: "memory_reflection_error",
      guildId,
      content: `Failed reflection for ${dateKey} guild:${guildId}: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { dateKey, guildId }
    });
  }
}
