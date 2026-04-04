/**
 * Cross-cutting abort/cancellation helpers.
 *
 * These utilities are used by every agent session, tool runtime, and
 * long-running task in the codebase.  They live in their own module so
 * foundational layers (`baseAgentSession`, individual agents, LLM clients)
 * can import them without pulling in browser-specific runtime code and
 * creating circular module dependencies.
 *
 * The `AbortError` shape produced here follows the web platform convention:
 * `name === "AbortError"` with a normalized reason string in `message`.
 * Callers check with `isAbortError` to distinguish user/system cancellations
 * from other failures.
 */

function normalizeAbortReason(reason: unknown, fallbackMessage: string) {
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error) {
    const message = String(reason.message || "").trim();
    if (message) return message;
  }
  return fallbackMessage;
}

export function createAbortError(reason: unknown = "Browser task cancelled") {
  const error = new Error(`AbortError: ${normalizeAbortReason(reason, "Browser task cancelled")}`);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown) {
  if (!error) return false;
  const name = String((error as { name?: unknown }).name || "").trim();
  if (name === "AbortError") return true;

  const code = String((error as { code?: unknown }).code || "").trim().toUpperCase();
  if (code === "ABORT_ERR") return true;

  const message = String((error as { message?: unknown }).message || "").toLowerCase();
  return (
    message.includes("aborterror") ||
    message.includes("aborted") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

export function throwIfAborted(signal?: AbortSignal, fallbackReason = "Browser task cancelled"): void {
  if (!signal?.aborted) return;
  throw createAbortError(signal.reason || fallbackReason);
}
