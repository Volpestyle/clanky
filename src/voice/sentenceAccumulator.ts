const SENTENCE_BREAK_RE = /(?:[.!?](?:["')\]]+)?\s+|[.!?](?:["')\]]+)?$|\n+)/gu;
const CLAUSE_BREAK_RE = /(?:[;:](?:\s+|$))/gu;
const INLINE_SOUNDBOARD_DIRECTIVE_RE = /\[\[SOUNDBOARD:\s*[\s\S]*?\s*\]\]/gi;

type ProtectedSpan = {
  start: number;
  end: number;
};

function normalizeChunkText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function collectProtectedSpans(buffer: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  INLINE_SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = INLINE_SOUNDBOARD_DIRECTIVE_RE.exec(buffer))) {
    const matchText = String(match[0] || "");
    if (!matchText) continue;
    const start = Number(match.index || 0);
    spans.push({
      start,
      end: start + matchText.length
    });
  }
  INLINE_SOUNDBOARD_DIRECTIVE_RE.lastIndex = 0;
  return spans;
}

function findProtectedSpanAt(index: number, spans: ProtectedSpan[]) {
  return spans.find((span) => index >= span.start && index < span.end) || null;
}

function findLastBoundaryIndex(buffer: string, allowClauseBreaks: boolean) {
  let lastBoundaryIndex = -1;
  const protectedSpans = collectProtectedSpans(buffer);

  for (const match of buffer.matchAll(SENTENCE_BREAK_RE)) {
    const start = Number(match.index || 0);
    const matchedText = String(match[0] || "");
    if (findProtectedSpanAt(start, protectedSpans)) continue;
    lastBoundaryIndex = start + matchedText.length;
  }

  if (lastBoundaryIndex >= 0 || !allowClauseBreaks) {
    return lastBoundaryIndex;
  }

  for (const match of buffer.matchAll(CLAUSE_BREAK_RE)) {
    const start = Number(match.index || 0);
    const matchedText = String(match[0] || "");
    if (findProtectedSpanAt(start, protectedSpans)) continue;
    lastBoundaryIndex = start + matchedText.length;
  }

  return lastBoundaryIndex;
}

function findForcedBreakIndex(buffer: string, maxBufferChars: number) {
  if (buffer.length < maxBufferChars) return -1;
  const protectedSpans = collectProtectedSpans(buffer);
  for (let index = Math.min(maxBufferChars, buffer.length - 1); index > 0; index -= 1) {
    if (buffer[index] !== " ") continue;
    if (findProtectedSpanAt(index, protectedSpans)) continue;
    return index + 1;
  }
  const protectedSpan = findProtectedSpanAt(Math.min(maxBufferChars, buffer.length - 1), protectedSpans);
  if (protectedSpan && protectedSpan.end < buffer.length) {
    return protectedSpan.end;
  }
  return maxBufferChars;
}

function findEagerFirstChunkBoundaryIndex(buffer: string) {
  // Keep the first streamed chunk coherent. Whitespace-only cuts create
  // tiny trailing fragments like "vc!" that sound like a new sentence.
  return findLastBoundaryIndex(buffer, false);
}

const MIN_STANDALONE_POST_FIRST_CHUNK_CHARS = 24;
const MIN_STANDALONE_POST_FIRST_CHUNK_WORDS = 4;

function combineChunkText(...parts: string[]) {
  return normalizeChunkText(parts.filter(Boolean).join(" "));
}

function countChunkWords(text: string) {
  return normalizeChunkText(text)
    .split(/\s+/u)
    .filter(Boolean)
    .length;
}

function isTooSmallStandalonePostFirstChunk(text: string) {
  const normalized = normalizeChunkText(text);
  if (!normalized) return false;
  return (
    normalized.length < MIN_STANDALONE_POST_FIRST_CHUNK_CHARS &&
    countChunkWords(normalized) < MIN_STANDALONE_POST_FIRST_CHUNK_WORDS
  );
}

export interface SentenceAccumulatorOptions {
  onSentence: (text: string, index: number) => void;
  eagerFirstChunk?: boolean;
  eagerMinChars?: number;
  maxBufferChars?: number;
}

export class SentenceAccumulator {
  private buffer = "";
  private sentenceIndex = 0;
  private emittedFirstChunk = false;
  private deferredSmallPostFirstChunk = "";
  private readonly eagerFirstChunk: boolean;
  private readonly eagerMinChars: number;
  private readonly maxBufferChars: number;
  private readonly onSentence: (text: string, index: number) => void;

  constructor(options: SentenceAccumulatorOptions) {
    this.onSentence = options.onSentence;
    this.eagerFirstChunk = options.eagerFirstChunk !== false;
    this.eagerMinChars = Math.max(1, Math.floor(Number(options.eagerMinChars) || 30));
    this.maxBufferChars = Math.max(20, Math.floor(Number(options.maxBufferChars) || 300));
  }

  push(delta: string) {
    const chunk = String(delta || "");
    if (!chunk) return;
    this.buffer += chunk;
    this.emitReadyChunks();
  }

  flush() {
    const chunk = normalizeChunkText(this.buffer);
    this.buffer = "";
    if (!chunk) {
      if (this.deferredSmallPostFirstChunk) {
        const deferred = this.deferredSmallPostFirstChunk;
        this.deferredSmallPostFirstChunk = "";
        this.emit(deferred);
      }
      return;
    }
    if (!this.emittedFirstChunk) {
      this.emit(chunk);
      return;
    }
    if (this.deferredSmallPostFirstChunk) {
      const combined = combineChunkText(this.deferredSmallPostFirstChunk, chunk);
      this.deferredSmallPostFirstChunk = "";
      if (combined) {
        this.emit(combined);
      }
      return;
    }
    this.emit(chunk);
  }

  private emitReadyChunks() {
    while (this.buffer.trim()) {
      const allowClauseBreaks = this.emittedFirstChunk;
      const boundaryIndex = findLastBoundaryIndex(this.buffer, allowClauseBreaks);
      const eagerBoundaryIndex =
        !this.emittedFirstChunk &&
        this.eagerFirstChunk &&
        this.buffer.trim().length >= this.eagerMinChars
          ? findEagerFirstChunkBoundaryIndex(this.buffer)
          : -1;
      const canEagerEmitFirstChunk =
        !this.emittedFirstChunk &&
        eagerBoundaryIndex >= 0;

      if (this.emittedFirstChunk && boundaryIndex >= 0) {
        const chunk = normalizeChunkText(this.buffer.slice(0, boundaryIndex));
        this.buffer = this.buffer.slice(boundaryIndex);
        if (chunk) {
          this.dispatchChunk(chunk);
          continue;
        }
      }

      if (canEagerEmitFirstChunk) {
        const chunk = normalizeChunkText(this.buffer.slice(0, eagerBoundaryIndex));
        this.buffer = this.buffer.slice(eagerBoundaryIndex);
        if (chunk) {
          this.emit(chunk);
          continue;
        }
      }

      const forcedBreakIndex = findForcedBreakIndex(this.buffer, this.maxBufferChars);
      if (forcedBreakIndex >= 0) {
        const chunk = normalizeChunkText(this.buffer.slice(0, forcedBreakIndex));
        this.buffer = this.buffer.slice(forcedBreakIndex);
        if (chunk) {
          this.dispatchChunk(chunk);
          continue;
        }
      }

      break;
    }
  }

  private emit(text: string) {
    this.onSentence(text, this.sentenceIndex);
    this.sentenceIndex += 1;
    this.emittedFirstChunk = true;
  }

  private dispatchChunk(text: string) {
    const normalized = normalizeChunkText(text);
    if (!normalized) return;
    if (!this.emittedFirstChunk) {
      this.emit(normalized);
      return;
    }

    if (this.deferredSmallPostFirstChunk) {
      const combined = combineChunkText(this.deferredSmallPostFirstChunk, normalized);
      if (!combined) {
        this.deferredSmallPostFirstChunk = "";
        return;
      }
      if (isTooSmallStandalonePostFirstChunk(combined)) {
        this.deferredSmallPostFirstChunk = combined;
        return;
      }
      this.deferredSmallPostFirstChunk = "";
      this.emit(combined);
      return;
    }

    if (isTooSmallStandalonePostFirstChunk(normalized)) {
      this.deferredSmallPostFirstChunk = normalized;
      return;
    }

    this.emit(normalized);
  }
}
