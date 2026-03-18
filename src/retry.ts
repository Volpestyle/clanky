const RETRY_BASE_DELAY_MS = 180;
const RETRY_MAX_DELAY_MS = 900;

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_FETCH_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

export type ErrorWithAttempts = Error & {
  attempts?: number;
};

export function shouldRetryHttpStatus(status: unknown) {
  return RETRYABLE_HTTP_STATUS.has(Number(status));
}

export function isRetryableFetchError(error: unknown) {
  const code = String((error as { code?: unknown; cause?: { code?: unknown } } | null)?.code || (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code || "")
    .trim()
    .toUpperCase();
  if (RETRYABLE_FETCH_ERROR_CODES.has(code)) return true;

  const name = String((error as { name?: unknown } | null)?.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;

  const message = String((error as { message?: unknown } | null)?.message || "").toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("fetch failed");
}

export function withAttemptCount(error: unknown, attempts: number) {
  const resolvedAttempts = Number(attempts || 1);

  if (error instanceof Error) {
    const errorWithAttempts = error as ErrorWithAttempts;
    errorWithAttempts.attempts = resolvedAttempts;
    return errorWithAttempts;
  }

  if (error && typeof error === "object") {
    const candidate = error as ErrorWithAttempts;
    candidate.attempts = resolvedAttempts;
    return candidate;
  }

  const wrapped = new Error(String((error as { message?: unknown } | null)?.message || error || "unknown error"));
  return Object.assign(wrapped, { attempts: resolvedAttempts }) as ErrorWithAttempts;
}

export function getRetryDelayMs(attempt: unknown) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, Number(attempt || 0) - 1));
}

export function isRedirectStatus(status: unknown) {
  const code = Number(status);
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}
