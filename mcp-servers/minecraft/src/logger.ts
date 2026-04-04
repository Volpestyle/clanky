export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, message: string, meta?: unknown): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta === undefined ? {} : { meta })
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function logError(message: string, error: unknown): void {
  const details =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      : { error: String(error) };

  log("error", message, details);
}
