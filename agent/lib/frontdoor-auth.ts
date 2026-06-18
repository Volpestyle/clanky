import type { AuthFn } from "eve/channels/auth";

export const FRONTDOOR_TOKEN_ENV = "CLANKY_RELAY_TOKEN";

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

