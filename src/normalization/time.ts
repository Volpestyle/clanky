export function sleep(ms: unknown): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(Number(ms) || 0))));
}
