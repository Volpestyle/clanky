const SENTENCE_BREAK_RE = /(?:[.!?](?:["')\]]+)?\s+|[.!?](?:["')\]]+)?$|\n+)/gu;
const CLAUSE_BREAK_RE = /(?:[;:](?:\s+|$))/gu;

function normalizeChunkText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findLastBoundaryIndex(buffer: string, allowClauseBreaks: boolean) {
  let lastBoundaryIndex = -1;

  for (const match of buffer.matchAll(SENTENCE_BREAK_RE)) {
    const start = Number(match.index || 0);
    const matchedText = String(match[0] || "");
    lastBoundaryIndex = start + matchedText.length;
  }

  if (lastBoundaryIndex >= 0 || !allowClauseBreaks) {
    return lastBoundaryIndex;
  }

  for (const match of buffer.matchAll(CLAUSE_BREAK_RE)) {
    const start = Number(match.index || 0);
    const matchedText = String(match[0] || "");
    lastBoundaryIndex = start + matchedText.length;
  }

  return lastBoundaryIndex;
}

function findForcedBreakIndex(buffer: string, maxBufferChars: number) {
  if (buffer.length < maxBufferChars) return -1;
  const whitespaceIndex = buffer.lastIndexOf(" ", maxBufferChars);
  if (whitespaceIndex > 0) {
    return whitespaceIndex + 1;
  }
  return maxBufferChars;
}

function findEagerFirstChunkBoundaryIndex(buffer: string) {
  // Keep the first streamed chunk coherent. Whitespace-only cuts create
  // tiny trailing fragments like "vc!" that sound like a new sentence.
  return findLastBoundaryIndex(buffer, false);
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
    if (!chunk) return;
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
          this.emit(chunk);
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
          this.emit(chunk);
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
}
