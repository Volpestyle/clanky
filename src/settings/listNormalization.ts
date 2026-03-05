const DEFAULT_SPLIT_RE = /[\n,]/g;
const NEWLINE_SPLIT_RE = /\n/g;

type NormalizeStringListOptions = {
  maxItems?: number;
  maxLen?: number;
  splitPattern?: RegExp;
};

function normalizeStringList(
  source: string[],
  {
    maxItems = 20,
    maxLen = 120
  }: NormalizeStringListOptions = {}
) {
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.slice(0, maxLen));
}

export function normalizeBoundedStringList(
  input: unknown,
  options: NormalizeStringListOptions = {}
) {
  if (Array.isArray(input)) {
    return normalizeStringList(input, options);
  }
  if (typeof input !== "string") return [];
  const splitPattern = options.splitPattern || DEFAULT_SPLIT_RE;
  return normalizeStringList(input.split(splitPattern), options);
}

export function parseUniqueList(value: unknown) {
  return normalizeBoundedStringList(value, {
    maxItems: Number.MAX_SAFE_INTEGER,
    maxLen: Number.MAX_SAFE_INTEGER,
    splitPattern: DEFAULT_SPLIT_RE
  });
}

export function parseUniqueLineList(value: unknown) {
  return normalizeBoundedStringList(value, {
    maxItems: Number.MAX_SAFE_INTEGER,
    maxLen: Number.MAX_SAFE_INTEGER,
    splitPattern: NEWLINE_SPLIT_RE
  });
}

export function formatLineList(items: unknown) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

export function formatCommaList(items: unknown) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
}
