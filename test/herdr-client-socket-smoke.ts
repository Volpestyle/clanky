import {
	decodeServerMessage,
	encodeAttachTerminal,
	encodeDetach,
	encodeHello,
	encodeInput,
	encodeResize,
	frameMessage,
	HERDR_CLIENT_PROTOCOL_VERSION,
} from "../agent/lib/herdr-client-socket.ts";

function expectHex(actual: Buffer, expected: string, label: string): void {
	const hex = actual.toString("hex");
	if (hex !== expected) throw new Error(`${label}: expected ${expected}, got ${hex}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
}

expectEqual(HERDR_CLIENT_PROTOCOL_VERSION, 15, "protocol version matches herdr wire.rs");
expectHex(
	encodeHello({ cols: 80, rows: 24, cellWidthPx: 8, cellHeightPx: 16 }),
	"000f50180810010001",
	"terminal attach Hello encodes pinned protocol-15 field order",
);
expectHex(encodeAttachTerminal("term_123", true), "05087465726d5f31323301", "AttachTerminal encodes tag/string/bool");
expectHex(encodeInput(Buffer.from("hi\r", "utf8")), `0103${Buffer.from("hi\r").toString("hex")}`, "Input encodes tag/len/bytes");
expectHex(
	encodeInput(Buffer.alloc(300, 0x61)),
	`01fb2c01${"61".repeat(300)}`,
	"Input length uses bincode standard varints",
);
expectHex(
	encodeResize({ cols: 300, rows: 40, cellWidthPx: 12, cellHeightPx: 22 }),
	"03fb2c01280c16",
	"Resize uses bincode standard varints",
);
expectHex(encodeDetach(), "04", "Detach encodes tag only");
expectHex(frameMessage(Buffer.from([1, 2, 3])), "03000000010203", "frames use u32 little-endian length prefix");

expectEqual(
	decodeServerMessage(Buffer.from("000e0100", "hex")),
	{ type: "welcome", version: 14, encoding: "terminal-ansi" },
	"Welcome decodes without error",
);

expectEqual(
	decodeServerMessage(Buffer.from("02077828000b1b5b313b314868656c6c6f", "hex")),
	{
		type: "terminal",
		frame: {
			seq: 7,
			width: 120,
			height: 40,
			full: false,
			bytes: Buffer.from("\u001b[1;1Hhello"),
		},
	},
	"Terminal frame decodes",
);

console.log("herdr client socket smoke OK");
