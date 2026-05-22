import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN_BYTES = 32;

export async function ensureHttpToken(tokenFile: string): Promise<string> {
	const existing = await readFile(tokenFile, "utf8").catch(() => undefined);
	const token = existing?.trim();
	if (token) return token;

	const generated = randomBytes(TOKEN_BYTES).toString("hex");
	await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
	await writeFile(tokenFile, `${generated}\n`, { flag: "wx", mode: 0o600 }).catch(async (error: unknown) => {
		if (!isFileExistsError(error)) throw error;
		const raced = (await readFile(tokenFile, "utf8")).trim();
		if (!raced) throw new Error(`HTTP token file exists but is empty: ${tokenFile}`);
	});
	const finalToken = (await readFile(tokenFile, "utf8")).trim();
	if (!finalToken) throw new Error(`HTTP token file is empty: ${tokenFile}`);
	return finalToken;
}

export async function rotateHttpToken(tokenFile: string): Promise<string> {
	const generated = randomBytes(TOKEN_BYTES).toString("hex");
	await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
	await writeFile(tokenFile, `${generated}\n`, { mode: 0o600 });
	return generated;
}

export function isHttpAuthorized(headers: Headers, token: string): boolean {
	const authorization = headers.get("authorization");
	if (authorization?.startsWith("Bearer ") && isTokenAuthorized(authorization.slice("Bearer ".length), token)) {
		return true;
	}
	const headerToken = headers.get("x-clanky-token");
	return headerToken !== null && isTokenAuthorized(headerToken, token);
}

export function isTokenAuthorized(candidate: string | undefined, token: string): boolean {
	if (candidate === undefined) return false;
	const candidateBytes = Buffer.from(candidate);
	const tokenBytes = Buffer.from(token);
	if (candidateBytes.length !== tokenBytes.length) return false;
	return timingSafeEqual(candidateBytes, tokenBytes);
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
