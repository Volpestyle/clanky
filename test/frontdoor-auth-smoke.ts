/**
 * Offline smoke for agent/lib/frontdoor-auth.ts: timing-safe bearer-token
 * compare and socket-address-gated local-user auth. A spoofed Host header
 * (loopback hostname in the URL) must never mint a local principal — only the
 * real socket remote address counts, and a request with no socket surface
 * fails closed.
 */
import { FRONTDOOR_TOKEN_ENV, frontdoorAuth, isFrontdoorAuthorized, localUserAuth } from "../agent/lib/frontdoor-auth.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function requestFrom(url: string, extras?: Record<string, unknown>): Request {
	const request = new Request(url);
	return extras === undefined ? request : Object.assign(request, extras);
}

const previousToken = process.env[FRONTDOOR_TOKEN_ENV];
const previousLocalUser = process.env.CLANKY_LOCAL_USER_ID;
const previousVercel = process.env.VERCEL;
try {
	delete process.env.VERCEL;
	process.env[FRONTDOOR_TOKEN_ENV] = "frontdoor-secret";
	process.env.CLANKY_LOCAL_USER_ID = "james";

	// Token compare: correct via query and Bearer header.
	assert(isFrontdoorAuthorized(requestFrom("http://100.100.1.2:2000/eve/v1/session?token=frontdoor-secret")), "correct query token should authorize");
	const bearer = new Request("http://100.100.1.2:2000/eve/v1/session", { headers: { authorization: "Bearer frontdoor-secret" } });
	assert(isFrontdoorAuthorized(bearer), "correct Bearer token should authorize");
	const frontdoor = await frontdoorAuth()(requestFrom("http://127.0.0.1:2000/eve/v1/session?token=frontdoor-secret"));
	assert(frontdoor?.principalType === "service", "frontdoor auth should keep a service principal");
	assert(frontdoor?.principalId === "frontdoor", "frontdoor auth principal id drifted");

	// Token compare: incorrect, wrong-length, empty, and missing tokens.
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x?token=frontdoor-wrong1")), "same-length wrong token must not authorize");
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x?token=short")), "wrong-length token must not authorize");
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x?token=")), "empty token must not authorize");
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x")), "missing token must not authorize");

	// Token compare: empty/unset expected token always fails, even on an empty match.
	process.env[FRONTDOOR_TOKEN_ENV] = "";
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x?token=")), "empty configured token must reject everything");
	delete process.env[FRONTDOOR_TOKEN_ENV];
	assert(!isFrontdoorAuthorized(requestFrom("http://127.0.0.1:2000/x?token=frontdoor-secret")), "unset configured token must reject everything");
	process.env[FRONTDOOR_TOKEN_ENV] = "frontdoor-secret";

	// Local-user auth: loopback socket addresses are accepted.
	const auth = localUserAuth();
	for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
		const principal = await auth(requestFrom("http://localhost:2000/eve/v1/session", { ip }));
		assert(principal?.principalType === "user", `loopback socket ${ip} should mint a user principal`);
		assert(principal.principalId === "james", "local face auth should use the configured local user id");
		assert(principal.issuer === "clanky-local", "local face auth issuer drifted");
	}

	// Local-user auth: non-loopback socket addresses are rejected even when the
	// client-controlled Host header claims localhost.
	for (const ip of ["100.100.10.10", "192.168.1.7", "::ffff:100.64.0.9"]) {
		const principal = await auth(requestFrom("http://localhost:2000/eve/v1/session", { ip }));
		assert(principal === null || principal === undefined, `tailnet-style socket ${ip} must not mint a local principal despite Host: localhost`);
	}

	// Local-user auth: no socket surface at all fails closed, loopback URL or not.
	const bare = await auth(new Request("http://127.0.0.1:2000/eve/v1/session"));
	assert(bare === null || bare === undefined, "request without socket info must fail closed");

	// Local-user auth: srvx runtime.node and raw Node request fallbacks.
	const viaRuntime = await auth(requestFrom("http://localhost:2000/x", { runtime: { node: { req: { socket: { remoteAddress: "127.0.0.1" } } } } }));
	assert(viaRuntime?.principalType === "user", "runtime.node.req.socket loopback should mint a user principal");
	const viaSocket = await auth(requestFrom("http://localhost:2000/x", { socket: { remoteAddress: "100.64.0.1" } }));
	assert(viaSocket === null || viaSocket === undefined, "socket.remoteAddress tailnet address must be rejected");
} finally {
	if (previousToken === undefined) delete process.env[FRONTDOOR_TOKEN_ENV];
	else process.env[FRONTDOOR_TOKEN_ENV] = previousToken;
	if (previousLocalUser === undefined) delete process.env.CLANKY_LOCAL_USER_ID;
	else process.env.CLANKY_LOCAL_USER_ID = previousLocalUser;
	if (previousVercel === undefined) delete process.env.VERCEL;
	else process.env.VERCEL = previousVercel;
}

console.log("frontdoor auth smoke OK");
