import { execFile } from "node:child_process";
import { hostname } from "node:os";
import QRCode from "qrcode";

// Shared iOS pairing seam (SPEC §4.4). The `clanky pair` CLI and the face's
// `/pair` slash command both build the same `clanky://connect` deep link from the
// tailnet relay URL + bearer token, then render it as a scannable terminal QR.
// After one scan the phone stores the credentials in Keychain and auto-reconnects
// over Tailscale on every launch.

export const PAIRING_TOKEN_MISSING_MESSAGE =
	"no CLANKY_RELAY_TOKEN set. The relay is fail-closed without one — set it in .env.local or the environment first.";

export type PairingLinkInput = {
	readonly token: string;
	readonly port: number;
	readonly host?: string;
	readonly configuredHost?: string;
	readonly https?: boolean;
};

export type PairingLink = {
	readonly relayUrl: string;
	readonly url: string;
};

// Encode the relay URL + token into the deep link the iOS app consumes. Throws
// with PAIRING_TOKEN_MISSING_MESSAGE when no relay token is configured.
export async function buildPairingLink(input: PairingLinkInput): Promise<PairingLink> {
	if (input.token.length === 0) throw new Error(PAIRING_TOKEN_MISSING_MESSAGE);
	const host = input.host ?? (await resolvePairHost(input.configuredHost));
	const scheme = input.https === true ? "https" : "http";
	const relayUrl = `${scheme}://${host}:${input.port}`;
	const params = new URLSearchParams({ relayUrl, token: input.token, mode: "tailnet" });
	return { relayUrl, url: `clanky://connect?${params.toString()}` };
}

export async function renderPairingQr(url: string): Promise<string> {
	return await QRCode.toString(url, { type: "terminal", small: true });
}

// Pick the address the phone can actually reach. Prefer the Tailscale MagicDNS
// name over the raw tailnet IP: the iOS app's App Transport Security exception is
// scoped to the `ts.net` domain (ATS exceptions match hostnames, not IP literals),
// so a `http://100.x.y.z` URL is blocked while `http://host.tailnet.ts.net` is
// allowed. Order: explicit non-wildcard host, MagicDNS name, tailnet IPv4, hostname.
async function resolvePairHost(configured: string | undefined): Promise<string> {
	const trimmed = configured?.trim();
	if (trimmed !== undefined && trimmed.length > 0 && !isWildcardHost(trimmed)) return trimmed;
	const magicDnsName = await tailscaleMagicDNSName();
	if (magicDnsName !== undefined) return magicDnsName;
	const tailscaleIp = await tailscaleIPv4();
	if (tailscaleIp !== undefined) return tailscaleIp;
	return hostname();
}

function isWildcardHost(host: string): boolean {
	return (
		host === "0.0.0.0" || host === "::" || host === "127.0.0.1" || host === "localhost" || host === "::1"
	);
}

// `tailscale` is frequently not on PATH on macOS (the app ships the CLI inside
// the bundle), so fall back to the standard app location before giving up.
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function runTailscale(args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		const attempt = (index: number): void => {
			const bin = TAILSCALE_BINARIES[index];
			if (bin === undefined) {
				resolvePromise(undefined);
				return;
			}
			execFile(bin, [...args], { timeout: 3000 }, (error, stdout) => {
				if (error) {
					attempt(index + 1);
					return;
				}
				resolvePromise(stdout);
			});
		};
		attempt(0);
	});
}

async function tailscaleMagicDNSName(): Promise<string | undefined> {
	const out = await runTailscale(["status", "--json"]);
	if (out === undefined) return undefined;
	try {
		const parsed = JSON.parse(out) as { Self?: { DNSName?: string } };
		const name = parsed.Self?.DNSName?.replace(/\.$/, "").trim();
		return name !== undefined && name.length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
}

async function tailscaleIPv4(): Promise<string | undefined> {
	const out = await runTailscale(["ip", "-4"]);
	if (out === undefined) return undefined;
	return out
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}
