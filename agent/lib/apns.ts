/**
 * Minimal APNs HTTP/2 sender (SPEC §4.4). Token-based auth: signs an ES256 JWT
 * with an Apple .p8 key — no third-party dependency, just node:crypto + http2.
 *
 * Gated on env; when unconfigured every send is a no-op so the rest of the relay
 * runs fine without push credentials:
 *   CLANKY_APNS_KEY_PATH   path to the AuthKey_XXXX.p8 file
 *   CLANKY_APNS_KEY_ID     the key's 10-char Key ID
 *   CLANKY_APNS_TEAM_ID    Apple Developer Team ID
 *   CLANKY_APNS_BUNDLE_ID  app bundle id (default io.clanky.ios)
 *   CLANKY_APNS_ENV        "sandbox" (default) | "production"
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

export interface ApnsConfig {
	keyPath: string;
	keyId: string;
	teamId: string;
	bundleId: string;
	host: string;
}

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | undefined {
	const keyPath = env.CLANKY_APNS_KEY_PATH ?? env.CLANKY_APNS_KEY;
	const keyId = env.CLANKY_APNS_KEY_ID;
	const teamId = env.CLANKY_APNS_TEAM_ID;
	if (!keyPath || !keyId || !teamId) return undefined;
	const bundleId = env.CLANKY_APNS_BUNDLE_ID ?? "io.clanky.ios";
	const apnsEnv = (env.CLANKY_APNS_ENV ?? "sandbox").toLowerCase();
	const host = apnsEnv === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
	return { keyPath, keyId, teamId, bundleId, host };
}

export function apnsConfig(): ApnsConfig | undefined {
	return apnsConfigFromEnv();
}

export function apnsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return apnsConfigFromEnv(env) !== undefined;
}

export interface ApnsNotification {
	title: string;
	body: string;
	data?: Record<string, unknown>;
	collapseId?: string;
}

export interface ApnsResult {
	ok: boolean;
	status?: number;
	reason?: string;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

// APNs requires the provider token be refreshed at least hourly and reused at
// least 20 min; cache for 30 min.
let cachedToken: { jwt: string; iat: number; cacheKey: string } | undefined;

function providerToken(config: ApnsConfig): string {
	const now = Math.floor(Date.now() / 1000);
	const cacheKey = `${config.keyPath}\0${config.keyId}\0${config.teamId}`;
	if (cachedToken && cachedToken.cacheKey === cacheKey && now - cachedToken.iat < 1800) return cachedToken.jwt;
	const key = createPrivateKey(readFileSync(config.keyPath));
	const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
	const claims = base64url(JSON.stringify({ iss: config.teamId, iat: now }));
	const signingInput = `${header}.${claims}`;
	const signature = cryptoSign("SHA256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
	const jwt = `${signingInput}.${base64url(signature)}`;
	cachedToken = { jwt, iat: now, cacheKey };
	return jwt;
}

export function sendApns(token: string, note: ApnsNotification, config = apnsConfig()): Promise<ApnsResult> {
	if (!config) return Promise.resolve({ ok: false, reason: "apns_unconfigured" });

	let jwt: string;
	try {
		jwt = providerToken(config);
	} catch (error) {
		return Promise.resolve({ ok: false, reason: `jwt_error: ${(error as Error).message}` });
	}

	const payload = JSON.stringify({
		aps: { alert: { title: note.title, body: note.body }, sound: "default" },
		...note.data,
	});

	return new Promise<ApnsResult>((resolve) => {
		const client = http2.connect(`https://${config.host}`);
		let settled = false;
		const finish = (result: ApnsResult): void => {
			if (settled) return;
			settled = true;
			client.close();
			resolve(result);
		};
		client.on("error", (error) => finish({ ok: false, reason: error.message }));

		const headers: Record<string, string> = {
			":method": "POST",
			":path": `/3/device/${token}`,
			authorization: `bearer ${jwt}`,
			"apns-topic": config.bundleId,
			"apns-push-type": "alert",
			"apns-priority": "10",
		};
		if (note.collapseId) headers["apns-collapse-id"] = note.collapseId.slice(0, 64);

		const request = client.request(headers);
		let status = 0;
		let bodyText = "";
		request.on("response", (responseHeaders) => {
			status = Number(responseHeaders[":status"]) || 0;
		});
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			bodyText += chunk;
		});
		request.on("end", () => {
			if (status === 200) {
				finish({ ok: true, status });
				return;
			}
			let reason = bodyText;
			try {
				reason = (JSON.parse(bodyText) as { reason?: string }).reason ?? bodyText;
			} catch {}
			finish({ ok: false, status, reason });
		});
		request.on("error", (error) => finish({ ok: false, reason: error.message }));
		request.end(payload);
	});
}
