/**
 * PKCE (Web Crypto) shared by Clanky's Claude and Codex subscription OAuth
 * flows. Ported from pi pkce.ts; works on Node 20+ and in browsers.
 */

export interface Pkce {
	verifier: string;
	challenge: string;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function generatePkce(): Promise<Pkce> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64url(verifierBytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
