/**
 * Relay wire protocol — the inbound frame gate, schema-validated request
 * parsing (packages/clanky-contract), fallback id generation, and the small
 * arg-coercion helpers shared by every relay op handler.
 */
import { RelayRequestByOpSchema } from "@clanky/contract";
import type { RelayId, RelayOpName } from "@clanky/contract";
import type { WebSocketMessage } from "eve/channels";

export interface RelayRequest {
	id?: RelayId;
	op: RelayOpName;
	args?: Record<string, unknown>;
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function int(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}

export function rec(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return  Object.hasOwn(record, key);
}

export const MAX_RELAY_UPLOAD_BYTES = 25 * 1024 * 1024;

/// Hard cap on a single inbound WS frame. The largest legitimate frame is an
/// `upload` op carrying a MAX_RELAY_UPLOAD_BYTES image as base64 (4/3
/// expansion), so the cap sits comfortably above that plus JSON envelope
/// overhead; anything bigger is rejected with an error reply before
/// JSON.parse ever sees it.
export const MAX_RELAY_INBOUND_MESSAGE_BYTES = Math.ceil((MAX_RELAY_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;

const RELAY_TEXT_DECODER = new TextDecoder();

export function assertRelayInboundMessageSize(byteLength: number): void {
	if (byteLength > MAX_RELAY_INBOUND_MESSAGE_BYTES) {
		throw new Error(`relay message is too large (${byteLength} bytes); maximum is ${MAX_RELAY_INBOUND_MESSAGE_BYTES}.`);
	}
}

export function relayMessageText(message: WebSocketMessage): string {
	const bytes = message.uint8Array();
	assertRelayInboundMessageSize(bytes.byteLength);
	return RELAY_TEXT_DECODER.decode(bytes);
}

export function parseRelayRequest(raw: string): RelayRequest {
	const parsed = JSON.parse(raw) as unknown;
	const envelope = rec(parsed);
	const result = RelayRequestByOpSchema.safeParse(envelope);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path.map(String).join(".");
		throw new Error(`invalid relay request${path ? ` at ${path}` : ""}: ${issue?.message ?? "schema rejected payload"}`);
	}
	const request = result.data;
	return {
		...(request.id === undefined ? {} : { id: request.id }),
		op: request.op,
		...(request.args === undefined ? {} : { args: rec(request.args) }),
	};
}

let relayFallbackIdCounter = 0;

/// Fallback id for client requests that omit `id` (used as stream/command
/// correlation keys). Date.now() alone collides within a millisecond, so a
/// monotonic counter suffix keeps every generated id unique for the process
/// lifetime.
export function requestId(id: RelayRequest["id"]): string {
	if (id !== undefined) return String(id);
	relayFallbackIdCounter += 1;
	return `relay_${Date.now().toString(36)}_${relayFallbackIdCounter.toString(36)}`;
}
