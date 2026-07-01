import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthFn } from "eve/channels/auth";

export const FRONTDOOR_TOKEN_ENV = "CLANKY_RELAY_TOKEN";
const LOOPBACK_IPV4_PREFIX = /^127\./;
const IPV4_MAPPED_PREFIX = "::ffff:";

export function frontdoorTokenFromRequest(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
	try {
		return new URL(request.url).searchParams.get("token");
	} catch {
		return null;
	}
}

// Constant-time compare over SHA-256 digests so neither token content nor
// token length leaks through timing.
function timingSafeTokenEqual(provided: string, expected: string): boolean {
	const providedDigest = createHash("sha256").update(provided).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(providedDigest, expectedDigest);
}

export function isFrontdoorAuthorized(request: Request): boolean {
	const expected = process.env[FRONTDOOR_TOKEN_ENV];
	if (expected === undefined || expected.length === 0) return false;
	const provided = frontdoorTokenFromRequest(request);
	return provided !== null && timingSafeTokenEqual(provided, expected);
}

export function frontdoorAuth(): AuthFn<Request> {
	return (request) => {
		if (!isFrontdoorAuthorized(request)) return null;
		return {
			attributes: { surface: "frontdoor" },
			authenticator: "clanky-frontdoor-token",
			principalId: "frontdoor",
			principalType: "service",
		};
	};
}

// Loopback clients self-declare their surface so the brain can tell owner
// surfaces (the face) from autonomous ones (Discord presence, voice, workers)
// on the same socket. Only loopback requests reach this header, so it cannot
// grant anything to a remote caller; unmarked requests keep the historical
// "local-face" surface, which privileged checks (the host_command yolo clamp)
// treat as non-owner — fail closed.
export const SURFACE_HEADER = "x-clanky-surface";
const SURFACE_VALUE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function requestSurface(request: Request): string {
	const declared = request.headers.get(SURFACE_HEADER)?.trim().toLowerCase();
	if (declared !== undefined && declared !== null && SURFACE_VALUE_PATTERN.test(declared)) return declared;
	return "local-face";
}

export function localUserAuth(): AuthFn<Request> {
	return (request) => {
		if (!isLocalLoopbackRequest(request)) return null;
		const user = process.env.CLANKY_LOCAL_USER_ID?.trim() || process.env.USER?.trim() || "local-user";
		return {
			attributes: { surface: requestSurface(request) },
			authenticator: "clanky-local-user",
			issuer: "clanky-local",
			principalId: user,
			principalType: "user",
			subject: user,
		};
	};
}

/**
 * Non-standard socket surfaces a served Request may carry. eve serves channel
 * routes over nitro/h3/srvx; on the Node adapter the request is a srvx
 * ServerRequest whose `ip` getter returns the underlying socket's
 * remoteAddress (srvx/dist/adapters/node.mjs). `runtime.node.req` exposes the
 * raw Node request; `socket` covers IncomingMessage-like shapes directly.
 */
interface RequestSocketSurfaces {
	readonly ip?: unknown;
	readonly socket?: { readonly remoteAddress?: unknown };
	readonly runtime?: { readonly node?: { readonly req?: { readonly socket?: { readonly remoteAddress?: unknown } } } };
}

function requestRemoteAddress(request: Request): string | null {
	const surfaces = request as Request & RequestSocketSurfaces;
	const candidates = [surfaces.ip, surfaces.runtime?.node?.req?.socket?.remoteAddress, surfaces.socket?.remoteAddress];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return null;
}

function isLoopbackAddress(address: string): boolean {
	const normalized = address.trim().toLowerCase();
	const unmapped = normalized.startsWith(IPV4_MAPPED_PREFIX) ? normalized.slice(IPV4_MAPPED_PREFIX.length) : normalized;
	return unmapped === "::1" || LOOPBACK_IPV4_PREFIX.test(unmapped);
}

// The Host header (and therefore request.url's hostname) is client-controlled,
// so local-user auth trusts only the socket remote address. A request shape
// with no socket surface fails closed. The one process-level exception is
// `vercel dev` (VERCEL=1 + VERCEL_ENV=development), matching eve's localDev.
function isLocalLoopbackRequest(request: Request): boolean {
	if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "development") return true;
	const address = requestRemoteAddress(request);
	return address !== null && isLoopbackAddress(address);
}
