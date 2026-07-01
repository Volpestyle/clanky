import { z } from "zod";

/**
 * A recursive JSON value. Many relay ops return raw herdr JSON that the client
 * keeps opaque and narrows at the use site, so the contract models those
 * results as `JsonValue` rather than inventing a shape herdr never promised.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** A JSON object — the `args`/`params` bag carried by relay requests. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
