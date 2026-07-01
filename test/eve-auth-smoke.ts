import { FRONTDOOR_TOKEN_ENV, frontdoorAuth, localUserAuth } from "../agent/lib/frontdoor-auth.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const previousToken = process.env[FRONTDOOR_TOKEN_ENV];
const previousUser = process.env.USER;
const previousLocalUser = process.env.CLANKY_LOCAL_USER_ID;
try {
	process.env[FRONTDOOR_TOKEN_ENV] = "frontdoor-secret";
	process.env.CLANKY_LOCAL_USER_ID = "james";

	const frontdoor = await frontdoorAuth()(new Request("http://127.0.0.1:2000/eve/v1/session?token=frontdoor-secret"));
	assert(frontdoor?.principalType === "service", "frontdoor auth should keep a service principal");
	assert(frontdoor?.principalId === "frontdoor", "frontdoor auth principal id drifted");

	// Local face auth is gated on the socket remote address (srvx `ip`), not
	// the client-controlled Host header.
	const local = await localUserAuth()(
		Object.assign(new Request("http://127.0.0.1:2000/eve/v1/session"), { ip: "127.0.0.1" }),
	);
	assert(local?.principalType === "user", "local face auth should provide a user principal");
	assert(local.principalId === "james", "local face auth should use the configured local user id");
	assert(local.issuer === "clanky-local", "local face auth issuer drifted");

	const hostSpoof = await localUserAuth()(
		Object.assign(new Request("http://localhost:2000/eve/v1/session"), { ip: "100.64.0.7" }),
	);
	assert(hostSpoof === null, "local face auth must not trust a spoofed localhost Host header");

	const noSocket = await localUserAuth()(new Request("http://127.0.0.1:2000/eve/v1/session"));
	assert(noSocket === null, "local face auth must fail closed when no socket surface exists");

	const remote = await localUserAuth()(Object.assign(new Request("https://example.com/eve/v1/session"), { ip: "203.0.113.9" }));
	assert(remote === null, "local face auth must not accept non-loopback requests");
} finally {
	if (previousToken === undefined) delete process.env[FRONTDOOR_TOKEN_ENV];
	else process.env[FRONTDOOR_TOKEN_ENV] = previousToken;
	if (previousUser === undefined) delete process.env.USER;
	else process.env.USER = previousUser;
	if (previousLocalUser === undefined) delete process.env.CLANKY_LOCAL_USER_ID;
	else process.env.CLANKY_LOCAL_USER_ID = previousLocalUser;
}

console.log("eve auth smoke OK");
