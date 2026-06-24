import type { AuthFn } from "eve/channels/auth";

export const FRONTDOOR_TOKEN_ENV = "CLANKY_RELAY_TOKEN";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "[::1]"]);
const LOOPBACK_IPV4_PREFIX = /^127\./;

export function frontdoorTokenFromRequest(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
	try {
		return new URL(request.url).searchParams.get("token");
	} catch {
		return null;
	}
}

export function isFrontdoorAuthorized(request: Request): boolean {
	const expected = process.env[FRONTDOOR_TOKEN_ENV];
	return expected !== undefined && expected.length > 0 && frontdoorTokenFromRequest(request) === expected;
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

export function localUserAuth(): AuthFn<Request> {
	return (request) => {
		if (!isLocalDevelopmentRequest(request)) return null;
		const user = process.env.CLANKY_LOCAL_USER_ID?.trim() || process.env.USER?.trim() || "local-user";
		return {
			attributes: { surface: "local-face" },
			authenticator: "clanky-local-user",
			issuer: "clanky-local",
			principalId: user,
			principalType: "user",
			subject: user,
		};
	};
}

function isLocalDevelopmentRequest(request: Request): boolean {
	if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "development") return true;
	try {
		const hostname = new URL(request.url).hostname;
		return LOOPBACK_HOSTNAMES.has(hostname) || LOOPBACK_IPV4_PREFIX.test(hostname) || hostname.endsWith(".localhost");
	} catch {
		return false;
	}
}
