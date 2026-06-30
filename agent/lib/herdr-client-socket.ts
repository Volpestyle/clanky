import { createConnection, type Socket } from "node:net";
import { Buffer } from "node:buffer";
import { herdrClientSocketPath } from "./herdr-socket.ts";

type ByteBuffer = Buffer<ArrayBufferLike>;

export const HERDR_CLIENT_PROTOCOL_VERSION = 14;
const MAX_FRAME_SIZE = 2 * 1024 * 1024;
const MAX_GRAPHICS_FRAME_SIZE = 32 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

type RenderEncoding = "semantic-frame" | "terminal-ansi";

export interface HerdrTerminalGeometry {
	cols: number;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
}

export interface HerdrTerminalFrame {
	seq: number;
	width: number;
	height: number;
	full: boolean;
	bytes: ByteBuffer;
}

export interface HerdrTerminalAttachOptions extends Partial<HerdrTerminalGeometry> {
	terminalId: string;
	takeover?: boolean;
	/// Target herdr session (name/path). Omit for the relay's env-bound session.
	session?: string;
}

export interface HerdrTerminalAttachCallbacks {
	onFrame(frame: HerdrTerminalFrame): void;
	onError(error: Error): void;
	onClose(): void;
}

export interface HerdrTerminalAttachStream {
	close(): void;
}

interface WelcomeMessage {
	type: "welcome";
	version: number;
	encoding: RenderEncoding;
	error?: string;
}

interface TerminalMessage {
	type: "terminal";
	frame: HerdrTerminalFrame;
}

interface ServerShutdownMessage {
	type: "server-shutdown";
	reason?: string;
}

interface GraphicsMessage {
	type: "graphics";
	bytes: ByteBuffer;
}

interface IgnoredMessage {
	type: "ignored";
	tag: number;
}

type ServerMessage = WelcomeMessage | TerminalMessage | ServerShutdownMessage | GraphicsMessage | IgnoredMessage;

const DEFAULT_GEOMETRY: HerdrTerminalGeometry = {
	cols: 80,
	rows: 24,
	cellWidthPx: 0,
	cellHeightPx: 0,
};

export function attachHerdrTerminal(
	options: HerdrTerminalAttachOptions,
	callbacks: HerdrTerminalAttachCallbacks,
): HerdrTerminalAttachStream {
	const geometry = normalizeGeometry(options);
	const socket = createConnection(herdrClientSocketPath(options.session));
	let buffer: ByteBuffer = Buffer.alloc(0);
	let closed = false;
	let welcomeReceived = false;
	let closeNotified = false;
	let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (handshakeTimer) clearTimeout(handshakeTimer);
		try {
			socket.write(frameMessage(encodeDetach()));
		} catch {}
		socket.destroy();
	};

	const fail = (error: Error): void => {
		if (closed) return;
		closed = true;
		if (handshakeTimer) clearTimeout(handshakeTimer);
		callbacks.onError(error);
		socket.destroy();
	};

	socket.on("connect", () => {
		handshakeTimer = setTimeout(() => {
			fail(new Error("herdr client socket handshake timed out"));
		}, HANDSHAKE_TIMEOUT_MS);
		socket.write(frameMessage(encodeHello(geometry)));
	});

	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		try {
			while (true) {
				const framed = takeFrame(buffer);
				if (!framed) break;
				buffer = framed.remaining;
				const message = decodeServerMessage(framed.payload);
				if (!welcomeReceived) {
					if (message.type !== "welcome") {
						throw new Error("herdr client socket returned a non-Welcome handshake frame");
					}
					welcomeReceived = true;
					if (handshakeTimer) clearTimeout(handshakeTimer);
					if (message.error) throw new Error(`herdr rejected terminal attach: ${message.error}`);
					if (message.encoding !== "terminal-ansi") {
						throw new Error(`herdr selected unsupported render encoding: ${message.encoding}`);
					}
					socket.write(frameMessage(encodeAttachTerminal(options.terminalId, options.takeover === true)));
					continue;
				}

				if (message.type === "terminal") {
					callbacks.onFrame(message.frame);
				} else if (message.type === "server-shutdown") {
					fail(new Error(message.reason ?? "herdr terminal attach stream shut down"));
				}
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});

	socket.on("error", (error) => {
		fail(error);
	});

	socket.on("close", () => {
		if (handshakeTimer) clearTimeout(handshakeTimer);
		if (!closed && !closeNotified) {
			closeNotified = true;
			closed = true;
			callbacks.onClose();
		}
	});

	return { close };
}

export function encodeHello(geometry: HerdrTerminalGeometry): ByteBuffer {
	return concatBuffers([
		encodeVarint(0), // ClientMessage::Hello
		encodeVarint(HERDR_CLIENT_PROTOCOL_VERSION),
		encodeVarint(u16(geometry.cols)),
		encodeVarint(u16(geometry.rows)),
		encodeVarint(u32(geometry.cellWidthPx)),
		encodeVarint(u32(geometry.cellHeightPx)),
		encodeVarint(1), // RenderEncoding::TerminalAnsi
		encodeVarint(0), // ClientKeybindings::Server
		encodeVarint(1), // ClientLaunchMode::TerminalAttach
	]);
}

export function encodeAttachTerminal(terminalId: string, takeover: boolean): ByteBuffer {
	return concatBuffers([
		encodeVarint(5), // ClientMessage::AttachTerminal
		encodeString(terminalId),
		encodeBool(takeover),
	]);
}

export function encodeResize(geometry: HerdrTerminalGeometry): ByteBuffer {
	return concatBuffers([
		encodeVarint(3), // ClientMessage::Resize
		encodeVarint(u16(geometry.cols)),
		encodeVarint(u16(geometry.rows)),
		encodeVarint(u32(geometry.cellWidthPx)),
		encodeVarint(u32(geometry.cellHeightPx)),
	]);
}

export function encodeDetach(): ByteBuffer {
	return encodeVarint(4); // ClientMessage::Detach
}

export function frameMessage(payload: ByteBuffer): ByteBuffer {
	if (payload.length > 0xffffffff) throw new Error(`herdr frame too large: ${payload.length}`);
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

export function decodeServerMessage(payload: ByteBuffer): ServerMessage {
	const reader = new BincodeReader(payload);
	const tag = reader.readNumber("server message tag");
	switch (tag) {
		case 0:
			return {
				type: "welcome",
				version: reader.readNumber("welcome.version"),
				encoding: decodeRenderEncoding(reader.readNumber("welcome.encoding")),
				...(reader.readOptionString("welcome.error") === undefined ? {} : { error: reader.lastOptionString }),
			};
		case 2:
			return {
				type: "terminal",
				frame: {
					seq: reader.readNumber("terminal.seq"),
					width: reader.readNumber("terminal.width"),
					height: reader.readNumber("terminal.height"),
					full: reader.readBool("terminal.full"),
					bytes: reader.readBytes("terminal.bytes"),
				},
			};
		case 3:
			return { type: "graphics", bytes: reader.readBytes("graphics.bytes") };
		case 4:
			return { type: "server-shutdown", reason: reader.readOptionString("server-shutdown.reason") };
		default:
			return { type: "ignored", tag };
	}
}

function normalizeGeometry(options: Partial<HerdrTerminalGeometry>): HerdrTerminalGeometry {
	return {
		cols: u16(options.cols ?? DEFAULT_GEOMETRY.cols),
		rows: u16(options.rows ?? DEFAULT_GEOMETRY.rows),
		cellWidthPx: u32(options.cellWidthPx ?? DEFAULT_GEOMETRY.cellWidthPx),
		cellHeightPx: u32(options.cellHeightPx ?? DEFAULT_GEOMETRY.cellHeightPx),
	};
}

function takeFrame(buffer: ByteBuffer): { payload: ByteBuffer; remaining: ByteBuffer } | undefined {
	if (buffer.length < 4) return undefined;
	const length = buffer.readUInt32LE(0);
	const max = length > MAX_FRAME_SIZE && buffer[4] === 3 ? MAX_GRAPHICS_FRAME_SIZE : MAX_FRAME_SIZE;
	if (length > max) throw new Error(`herdr client socket frame too large: ${length}`);
	if (buffer.length < length + 4) return undefined;
	return {
		payload: Buffer.from(buffer.subarray(4, length + 4)),
		remaining: Buffer.from(buffer.subarray(length + 4)),
	};
}

function decodeRenderEncoding(value: number): RenderEncoding {
	switch (value) {
		case 0:
			return "semantic-frame";
		case 1:
			return "terminal-ansi";
		default:
			throw new Error(`unknown herdr render encoding tag: ${value}`);
	}
}

function encodeBool(value: boolean): ByteBuffer {
	return Buffer.from([value ? 1 : 0]);
}

function encodeString(value: string): ByteBuffer {
	const bytes = Buffer.from(value, "utf8");
	return concatBuffers([encodeVarint(bytes.length), bytes]);
}

function encodeVarint(value: number | bigint): ByteBuffer {
	const n = typeof value === "bigint" ? value : BigInt(value);
	if (n < 0n) throw new Error(`negative bincode varint: ${value}`);
	if (n <= 250n) return Buffer.from([Number(n)]);
	if (n <= 0xffffn) {
		const buffer = Buffer.allocUnsafe(3);
		buffer[0] = 251;
		buffer.writeUInt16LE(Number(n), 1);
		return buffer;
	}
	if (n <= 0xffffffffn) {
		const buffer = Buffer.allocUnsafe(5);
		buffer[0] = 252;
		buffer.writeUInt32LE(Number(n), 1);
		return buffer;
	}
	if (n <= 0xffffffffffffffffn) {
		const buffer = Buffer.allocUnsafe(9);
		buffer[0] = 253;
		buffer.writeBigUInt64LE(n, 1);
		return buffer;
	}
	throw new Error(`bincode varint too large: ${value}`);
}

function concatBuffers(parts: ByteBuffer[]): ByteBuffer {
	return Buffer.concat(parts);
}

function u16(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(0xffff, Math.max(0, Math.round(value)));
}

function u32(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(0xffffffff, Math.max(0, Math.round(value)));
}

class BincodeReader {
	lastOptionString: string | undefined = undefined;

	#offset = 0;
	private readonly buffer: ByteBuffer;

	constructor(buffer: ByteBuffer) {
		this.buffer = buffer;
	}

	readNumber(label: string): number {
		const value = this.readVarint(label);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds JavaScript safe integer range`);
		return Number(value);
	}

	readBool(label: string): boolean {
		this.ensure(1, label);
		const value = this.buffer[this.#offset];
		this.#offset += 1;
		if (value === 0) return false;
		if (value === 1) return true;
		throw new Error(`${label} has invalid bool value ${value}`);
	}

	readBytes(label: string): ByteBuffer {
		const length = this.readNumber(`${label}.length`);
		this.ensure(length, label);
		const bytes = Buffer.from(this.buffer.subarray(this.#offset, this.#offset + length));
		this.#offset += length;
		return bytes;
	}

	readOptionString(label: string): string | undefined {
		const tag = this.readNumber(`${label}.tag`);
		if (tag === 0) {
			this.lastOptionString = undefined;
			return undefined;
		}
		if (tag !== 1) throw new Error(`${label} has invalid option tag ${tag}`);
		const value = this.readString(label);
		this.lastOptionString = value;
		return value;
	}

	private readString(label: string): string {
		return this.readBytes(label).toString("utf8");
	}

	private readVarint(label: string): bigint {
		this.ensure(1, label);
		const first = this.buffer[this.#offset];
		this.#offset += 1;
		if (first <= 250) return BigInt(first);
		if (first === 251) {
			this.ensure(2, label);
			const value = BigInt(this.buffer.readUInt16LE(this.#offset));
			this.#offset += 2;
			return value;
		}
		if (first === 252) {
			this.ensure(4, label);
			const value = BigInt(this.buffer.readUInt32LE(this.#offset));
			this.#offset += 4;
			return value;
		}
		if (first === 253) {
			this.ensure(8, label);
			const value = this.buffer.readBigUInt64LE(this.#offset);
			this.#offset += 8;
			return value;
		}
		throw new Error(`${label} uses unsupported bincode varint marker ${first}`);
	}

	private ensure(length: number, label: string): void {
		if (this.#offset + length > this.buffer.length) {
			throw new Error(`truncated herdr client socket frame while reading ${label}`);
		}
	}
}
