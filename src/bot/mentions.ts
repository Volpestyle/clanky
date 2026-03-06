import {
  MAX_MENTION_CANDIDATES,
  collectMemberLookupKeys,
  extractMentionCandidates
} from "./botHelpers.ts";
import { normalizeMentionLookupKey } from "./mentionLookup.ts";

const MENTION_GUILD_HISTORY_LOOKBACK = 500;
const MENTION_SEARCH_RESULT_LIMIT = 10;

export async function resolveDeterministicMentions(runtime, { text, guild, guildId }) {
  const source = String(text || "");
  if (!source || !source.includes("@")) {
    return {
      text: source,
      attemptedCount: 0,
      resolvedCount: 0,
      ambiguousCount: 0,
      unresolvedCount: 0
    };
  }

  const candidates = extractMentionCandidates(source, MAX_MENTION_CANDIDATES);
  if (!candidates.length) {
    return {
      text: source,
      attemptedCount: 0,
      resolvedCount: 0,
      ambiguousCount: 0,
      unresolvedCount: 0
    };
  }

  const aliasIndex = buildMentionAliasIndex(runtime, { guild, guildId });
  const keys = [
    ...new Set(
      candidates.flatMap((item) => item.variants.map((variant) => variant.lookupKey))
    )
  ];
  const resolutionByKey = new Map();

  for (const key of keys) {
    const localIds = aliasIndex.get(key) || new Set();
    if (localIds.size === 1) {
      resolutionByKey.set(key, { status: "resolved", id: [...localIds][0] });
      continue;
    }
    if (localIds.size > 1) {
      resolutionByKey.set(key, { status: "ambiguous" });
      continue;
    }

    const guildIds = await lookupGuildMembersByExactName({ guild, lookupKey: key });
    if (guildIds.size === 1) {
      resolutionByKey.set(key, { status: "resolved", id: [...guildIds][0] });
    } else if (guildIds.size > 1) {
      resolutionByKey.set(key, { status: "ambiguous" });
    } else {
      resolutionByKey.set(key, { status: "unresolved" });
    }
  }

  let output = source;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  const sorted = candidates.slice().sort((a, b) => b.start - a.start);

  for (const candidate of sorted) {
    let selectedVariant = null;
    let ambiguous = false;

    for (const variant of candidate.variants) {
      const resolution = resolutionByKey.get(variant.lookupKey);
      if (!resolution) continue;
      if (resolution.status === "resolved") {
        selectedVariant = {
          end: variant.end,
          id: resolution.id
        };
        break;
      }
      if (resolution.status === "ambiguous") {
        ambiguous = true;
      }
    }

    if (selectedVariant) {
      output = `${output.slice(0, candidate.start)}<@${selectedVariant.id}>${output.slice(selectedVariant.end)}`;
      resolvedCount += 1;
    } else if (ambiguous) {
      ambiguousCount += 1;
    } else {
      unresolvedCount += 1;
    }
  }

  return {
    text: output,
    attemptedCount: candidates.length,
    resolvedCount,
    ambiguousCount,
    unresolvedCount
  };
}

function buildMentionAliasIndex(runtime, { guild, guildId }) {
  const aliases = new Map();
  const addAlias = (name, id) => {
    const key = normalizeMentionLookupKey(name);
    const memberId = String(id || "").trim();
    if (!key || !memberId) return;
    if (key === "everyone" || key === "here") return;
    const existing = aliases.get(key) || new Set();
    existing.add(memberId);
    aliases.set(key, existing);
  };

  if (guild?.members?.cache?.size) {
    for (const member of guild.members.cache.values()) {
      addAlias(member?.displayName, member?.id);
      addAlias(member?.nickname, member?.id);
      addAlias(member?.user?.globalName, member?.id);
      addAlias(member?.user?.username, member?.id);
    }
  }

  if (guildId) {
    const rows = runtime.store.getRecentMessagesAcrossGuild(guildId, MENTION_GUILD_HISTORY_LOOKBACK);
    for (const row of rows) {
      addAlias(row?.author_name, row?.author_id);
    }
  }

  return aliases;
}

async function lookupGuildMembersByExactName({ guild, lookupKey }) {
  if (!guild?.members?.search) return new Set();
  const query = String(lookupKey || "").trim();
  if (query.length < 2) return new Set();

  try {
    const matches = await guild.members.search({
      query: query.slice(0, 32),
      limit: MENTION_SEARCH_RESULT_LIMIT
    });
    const ids = new Set();
    for (const member of matches.values()) {
      const keys = collectMemberLookupKeys(member);
      if (keys.has(query)) {
        ids.add(String(member.id));
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}
