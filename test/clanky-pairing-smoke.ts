import { buildPairingLink, PAIRING_TOKEN_MISSING_MESSAGE, renderPairingQr } from "../agent/lib/pairing.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Explicit host override skips tailnet/hostname resolution so the link is deterministic.
const link = await buildPairingLink({ token: "tok-123", port: 2000, host: "100.64.0.1" });
assert(link.relayUrl === "http://100.64.0.1:2000", `unexpected relayUrl: ${link.relayUrl}`);
assert(link.url.startsWith("clanky://connect?"), `unexpected scheme: ${link.url}`);

const params = new URL(link.url).searchParams;
assert(params.get("relayUrl") === "http://100.64.0.1:2000", "relayUrl param mismatch");
assert(params.get("token") === "tok-123", "token param mismatch");
assert(params.get("mode") === "tailnet", "mode param should be tailnet");

// HTTPS opt-in is honored.
const secure = await buildPairingLink({ token: "tok-123", port: 8443, host: "host.example", https: true });
assert(secure.relayUrl === "https://host.example:8443", `unexpected https relayUrl: ${secure.relayUrl}`);

// An explicit non-wildcard configuredHost is preferred over network probing.
const configured = await buildPairingLink({ token: "tok-123", port: 2000, configuredHost: "box.local" });
assert(configured.relayUrl === "http://box.local:2000", `configuredHost ignored: ${configured.relayUrl}`);

// Fail-closed: no token throws the shared message both surfaces report.
let threw = false;
try {
	await buildPairingLink({ token: "", port: 2000, host: "100.64.0.1" });
} catch (error) {
	threw = true;
	assert((error as Error).message === PAIRING_TOKEN_MISSING_MESSAGE, "wrong token-missing message");
}
assert(threw, "empty token must throw");

// The QR renders to a non-empty terminal string.
const qr = await renderPairingQr(link.url);
assert(qr.trim().length > 0, "QR render produced no output");

console.log("clanky-pairing-smoke: ok");
