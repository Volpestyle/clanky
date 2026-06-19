import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard shared by the web/media fetch tools. The model can pass arbitrary
// URLs to web_fetch / web_render / web_capture_frames / discord_download_media,
// so every outbound fetch and browser navigation resolves the host and rejects
// loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
// and other non-public targets, re-validating on each redirect hop.
//
// Residual risk: DNS rebinding (the address resolved here can differ from the
// one the fetch/browser ultimately connects to). Pinning the resolved address
// per connection is out of scope; the denylist + per-hop revalidation is the
// proportionate mitigation for an agent tool.

const DEFAULT_MAX_REDIRECTS = 5;

export interface GuardedFetchOptions {
	init?: RequestInit;
	fetchImpl?: typeof fetch;
	maxRedirects?: number;
	// Recompute headers for the current hop's URL (e.g. attach a credential only
	// to first-party hosts so it is never replayed onto a redirect target).
	headersFor?: (url: URL) => HeadersInit | undefined;
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
	const url = new URL(rawUrl.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must be http(s)");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host.length === 0) throw new Error("URL has no host");
	if (isBlockedHostname(host)) throw new Error(`Refusing to fetch non-public host: ${host}`);
	let addresses: string[];
	if (isIP(host) !== 0) {
		addresses = [host];
	} else {
		try {
			addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
		} catch {
			// A name that does not resolve cannot reach an internal address; let the
			// caller's fetch fail naturally rather than masking it as a guard error.
			return url;
		}
	}
	for (const address of addresses) {
		if (isBlockedAddress(address)) throw new Error(`Refusing to fetch non-public address ${address} (${host})`);
	}
	return url;
}

export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions = {}): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	let url = await assertPublicHttpUrl(rawUrl);
	for (let hop = 0; hop <= maxRedirects; hop += 1) {
		const headers = options.headersFor !== undefined ? options.headersFor(url) : options.init?.headers;
		const response = await fetchImpl(url.toString(), { ...options.init, headers, redirect: "manual" });
		const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
		if (location === null || location.length === 0) return response;
		url = await assertPublicHttpUrl(new URL(location, url).toString());
	}
	throw new Error(`Web request exceeded ${maxRedirects} redirects`);
}

function isBlockedHostname(host: string): boolean {
	const lower = host.toLowerCase();
	return lower === "localhost" || lower.endsWith(".localhost") || lower === "ip6-localhost";
}

function isBlockedAddress(address: string): boolean {
	const kind = isIP(address);
	if (kind === 4) return isBlockedIpv4(address);
	if (kind === 6) return isBlockedIpv6(address);
	return true;
}

function isBlockedIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
	if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
	if (a >= 224) return true; // multicast, reserved, broadcast
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const lower = address.toLowerCase();
	const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
	if (mapped !== null) return isBlockedIpv4(mapped[1] ?? "");
	if (lower === "::1" || lower === "::") return true; // loopback, unspecified
	if (lower.startsWith("fe80")) return true; // link-local
	const head = lower.split(":")[0] ?? "";
	if (head.length === 0) return false;
	const highByte = Number.parseInt(head.padStart(4, "0").slice(0, 2), 16);
	return (highByte & 0xfe) === 0xfc; // fc00::/7 unique-local
}
