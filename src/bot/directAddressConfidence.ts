export const DEFAULT_DIRECT_ADDRESS_CONFIDENCE_THRESHOLD = 0.62;
// English-token fallback only; the model-driven decider remains primary for ambiguous addressing.
const EN_GENERIC_NAME_TOKENS = new Set(["bot", "assistant", "ai", "the"]);

export function hasBotNameCue({
  transcript = "",
  botName = ""
}: {
  transcript?: string;
  botName?: string;
}) {
  const primary = pickPrimaryBotToken(tokenize(botName));
  if (!primary) return false;
  const transcriptTokens = tokenize(transcript);
  if (!transcriptTokens.length) return false;
  for (const token of transcriptTokens) {
    if (isLikelyNameCueToken(token, primary)) return true;
  }
  return false;
}

function tokenize(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  const matches = normalized.match(/[\p{L}\p{N}]+/gu);
  return Array.isArray(matches) ? matches : [];
}

function pickPrimaryBotToken(tokens: string[] = []) {
  if (!Array.isArray(tokens) || !tokens.length) return "";
  const filtered = tokens.filter((token) => token.length >= 4 && !EN_GENERIC_NAME_TOKENS.has(token));
  const candidates = filtered.length ? filtered : tokens.filter((token) => token.length >= 4);
  if (!candidates.length) return "";
  return [...candidates].sort((left, right) => right.length - left.length)[0] || "";
}

function isLikelyNameCueToken(token = "", primary = "") {
  const normalizedToken = String(token || "").trim().toLowerCase();
  const normalizedPrimary = String(primary || "").trim().toLowerCase();
  if (!normalizedToken || !normalizedPrimary) return false;
  if (normalizedToken.length < 4 || normalizedPrimary.length < 4) return false;
  if (normalizedToken === normalizedPrimary) return true;

  const tokenPrefix = normalizedToken.slice(0, 3);
  const primaryPrefix = normalizedPrimary.slice(0, 3);
  if (tokenPrefix === primaryPrefix) return true;
  const shortTokenPrefix = normalizedToken.slice(0, 2);
  const shortPrimaryPrefix = normalizedPrimary.slice(0, 2);
  if (
    shortTokenPrefix.length === 2 &&
    shortTokenPrefix === shortPrimaryPrefix &&
    sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2
  ) {
    return true;
  }
  if (sharedConsonantCount(normalizedToken, normalizedPrimary) >= 3) {
    return true;
  }

  const distance = levenshteinDistance(normalizedToken, normalizedPrimary);
  const maxLen = Math.max(normalizedToken.length, normalizedPrimary.length);
  const normalizedSimilarity = maxLen > 0 ? 1 - distance / maxLen : 0;
  if (normalizedSimilarity >= 0.58 && sharedConsonantCount(normalizedToken, normalizedPrimary) >= 2) {
    return true;
  }

  return false;
}

function sharedConsonantCount(left = "", right = "") {
  const leftSet = new Set(consonants(left));
  const rightSet = new Set(consonants(right));
  let count = 0;
  for (const char of leftSet) {
    if (rightSet.has(char)) count += 1;
  }
  return count;
}

function consonants(value = "") {
  const letters = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  const out = [];
  for (const char of letters) {
    if ("aeiou".includes(char)) continue;
    out.push(char);
  }
  return out;
}

function levenshteinDistance(left = "", right = "") {
  const a = String(left || "");
  const b = String(right || "");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from(
    { length: rows },
    (_, row) => Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0))
  );

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      const deletion = matrix[row - 1][col] + 1;
      const insertion = matrix[row][col - 1] + 1;
      const substitution = matrix[row - 1][col - 1] + cost;
      matrix[row][col] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[rows - 1][cols - 1];
}
