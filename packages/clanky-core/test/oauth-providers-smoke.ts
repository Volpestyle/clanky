import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthProviderInfo, SessionRegistry } from "@clanky/core";
import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
	registerOAuthProvider,
	resetOAuthProviders,
} from "@earendil-works/pi-ai/oauth";

const FAKE_ANTHROPIC_URL = "https://example.test/anthropic/authorize?state=fake";
const FAKE_ANTHROPIC_INSTRUCTIONS = "Open the URL in a browser to complete the Anthropic login.";
const FAKE_ANTHROPIC_ACCESS = "anthropic-fake-access-token";
const FAKE_ANTHROPIC_REFRESH = "anthropic-fake-refresh-token";

let authReached = false;
let promptReached = false;

const fakeAnthropic: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,
	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		authReached = true;
		callbacks.onAuth({ url: FAKE_ANTHROPIC_URL, instructions: FAKE_ANTHROPIC_INSTRUCTIONS });
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 50);
		});
		if (callbacks.signal?.aborted) throw new Error("aborted");
		promptReached = true;
		return {
			access: FAKE_ANTHROPIC_ACCESS,
			refresh: FAKE_ANTHROPIC_REFRESH,
			expires: Date.now() + 60 * 60 * 1000,
		};
	},
	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return { ...credentials, access: `${credentials.access}-refreshed`, expires: Date.now() + 60 * 60 * 1000 };
	},
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

registerOAuthProvider(fakeAnthropic);

const homeDir = await mkdtemp(join(tmpdir(), "clanky-oauth-providers-"));
const registry = new SessionRegistry({ homeDir, watchSkills: false });

try {
	const providers = registry.listAuthProviders();
	const anthropicInfo = findProvider(providers, "anthropic");
	if (!anthropicInfo.supportsOAuth || !anthropicInfo.supportsApiKey) {
		throw new Error(`anthropic provider info wrong: ${JSON.stringify(anthropicInfo)}`);
	}
	const codexInfo = findProvider(providers, "openai-codex");
	if (!codexInfo.supportsOAuth) throw new Error(`openai-codex must report supportsOAuth=true`);
	const openaiInfo = findProvider(providers, "openai");
	if (!openaiInfo.supportsApiKey || openaiInfo.supportsOAuth) {
		throw new Error(`openai must be api-key only, got ${JSON.stringify(openaiInfo)}`);
	}
	const copilotInfo = findProvider(providers, "github-copilot");
	if (!copilotInfo.supportsOAuth) throw new Error("github-copilot must report supportsOAuth=true");

	const begin = await registry.beginModelOAuthLogin("anthropic");
	if (begin.provider !== "anthropic") throw new Error(`begin.provider wrong: ${begin.provider}`);
	if (begin.verificationUrl !== FAKE_ANTHROPIC_URL) {
		throw new Error(`begin.verificationUrl wrong: ${begin.verificationUrl}`);
	}
	if (begin.userCode !== FAKE_ANTHROPIC_INSTRUCTIONS) {
		throw new Error(`begin.userCode wrong: ${begin.userCode}`);
	}
	if (!authReached) throw new Error("provider.login was never reached");

	const completion = await registry.waitModelOAuthLogin(begin.loginId);
	if (!promptReached) throw new Error("provider.login never returned credentials");
	if (completion.provider !== "anthropic") throw new Error(`completion provider wrong: ${completion.provider}`);
	if (!completion.status.authProviders.includes("anthropic")) {
		throw new Error(`anthropic credential not stored: ${JSON.stringify(completion.status.authProviders)}`);
	}

	const authPath = completion.status.authFile;
	const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
	const credential = stored.anthropic as Record<string, unknown> | undefined;
	if (!credential || credential.type !== "oauth") {
		throw new Error(`expected oauth credential, got: ${JSON.stringify(credential)}`);
	}
	if (credential.access !== FAKE_ANTHROPIC_ACCESS || credential.refresh !== FAKE_ANTHROPIC_REFRESH) {
		throw new Error(`stored credential mismatch: ${JSON.stringify(credential)}`);
	}

	try {
		await registry.beginModelOAuthLogin("not-a-real-provider");
		throw new Error("expected beginModelOAuthLogin to reject unknown provider");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("Unsupported OAuth provider")) {
			throw new Error(`unexpected error for unknown provider: ${String(error)}`);
		}
	}

	console.log(
		JSON.stringify({
			providerCount: providers.length,
			anthropic: anthropicInfo,
			storedAccess: credential.access,
		}),
	);
} finally {
	await registry.dispose();
	await rm(homeDir, { recursive: true, force: true });
	resetOAuthProviders();
}

function findProvider(list: AuthProviderInfo[], id: string): AuthProviderInfo {
	const found = list.find((info) => info.id === id);
	if (!found)
		throw new Error(`provider ${id} missing from auth.providers list: ${JSON.stringify(list.map((i) => i.id))}`);
	return found;
}
