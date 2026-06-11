import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadStoredDiscordCredential,
	readDiscordMessages,
	recentDiscordAttachments,
	resolveDiscordCredentialsPath,
	resolveDiscordOperatorCredential,
} from "./operator.ts";

async function main(): Promise<void> {
	resolvesCanonicalEnvCredential();
	ignoresLegacyEnvAliases();
	await loadsStoredCredentialForConfiguredProvider();
	resolvesCredentialPathFromEnv();
	await readsMessageMediaFromAttachmentsEmbedsAndLinks();
	await filtersMessagesWithRelativeSinceWindow();
}

function resolvesCanonicalEnvCredential(): void {
	const credential = resolveDiscordOperatorCredential({
		env: {
			DISCORD_MCP_PROVIDER_ID: "room-bot",
			DISCORD_MCP_TOKEN: "token",
			DISCORD_MCP_CREDENTIAL_KIND: "user-token",
		},
	});
	assert.equal(credential.providerId, "room-bot");
	assert.equal(credential.token, "token");
	assert.equal(credential.credentialKind, "user-token");
	assert.equal(credential.source, "env");
}

function ignoresLegacyEnvAliases(): void {
	assert.throws(
		() =>
			resolveDiscordOperatorCredential({
				env: {
					DISCORD_TOKEN: "old-token",
					CLANKY_DISCORD_TOKEN: "clanky-token",
					DISCORD_PROVIDER_ID: "old-provider",
					CLANKY_DISCORD_PROVIDER_ID: "clanky-provider",
				},
			}),
		/DISCORD_MCP_TOKEN/,
	);
}

async function loadsStoredCredentialForConfiguredProvider(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "discord-mcp-operator-test-"));
	try {
		const credentialsPath = join(dir, "credentials.json");
		await writeFile(
			credentialsPath,
			JSON.stringify({
				"room-bot": {
					providerId: "room-bot",
					payload: {
						token: "stored-token",
						credentialKind: "bot-token",
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
					},
				},
			}),
		);
		const credential = loadStoredDiscordCredential(
			{ credentialsPath, env: { DISCORD_MCP_PROVIDER_ID: "room-bot" } },
			"room-bot",
		);
		assert.equal(credential?.payload.token, "stored-token");
		assert.equal(credential?.payload.credentialKind, "bot-token");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function resolvesCredentialPathFromEnv(): void {
	assert.equal(
		resolveDiscordCredentialsPath({
			env: { DISCORD_MCP_CREDENTIALS_PATH: "/tmp/example-home/discord-creds.json" },
		}),
		"/tmp/example-home/discord-creds.json",
	);
}

async function readsMessageMediaFromAttachmentsEmbedsAndLinks(): Promise<void> {
	const pngBytes = Buffer.from("png");
	const gifBytes = Buffer.from("gif");
	const webpBytes = Buffer.from("webp");
	const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
		const href = String(url);
		if (href.startsWith("https://discord.com/api/v10/channels/channel-1/messages?")) {
			return jsonResponse([
				{
					id: snowflakeFor(Date.UTC(2026, 0, 2, 0, 0, 0)),
					channel_id: "channel-1",
					content: "look https://cdn.example/from-content.webp and https://cdn.example/direct.png",
					author: { id: "user-1", username: "james" },
					timestamp: "2026-01-02T00:00:00.000Z",
					attachments: [
						{
							id: "att-1",
							url: "https://cdn.example/direct.png",
							filename: "direct.png",
							content_type: "image/png; charset=utf-8",
							size: pngBytes.byteLength,
						},
					],
					embeds: [
						{
							type: "rich",
							title: "preview",
							provider: { name: "Tenor" },
							thumbnail: {
								url: "https://media.example/preview.gif",
								proxy_url: "https://proxy.example/preview.gif",
								width: 320,
								height: 180,
							},
						},
					],
				},
			]);
		}
		if (href === "https://cdn.example/direct.png") {
			return new Response(pngBytes, {
				headers: {
					"content-length": String(pngBytes.byteLength),
					"content-type": "image/png",
				},
			});
		}
		if (href === "https://proxy.example/preview.gif") {
			return new Response(gifBytes, {
				headers: {
					"content-length": String(gifBytes.byteLength),
					"content-type": "image/gif",
				},
			});
		}
		if (href === "https://cdn.example/from-content.webp") {
			return new Response(webpBytes, {
				headers: {
					"content-length": String(webpBytes.byteLength),
					"content-type": "image/webp",
				},
			});
		}
		throw new Error(`unexpected fetch ${href}`);
	};

	const result = await recentDiscordAttachments(
		{
			channel_id: "channel-1",
			message_limit: 10,
			media_limit: 4,
			load_images: true,
			include_video_keyframes: false,
		},
		{ env: { DISCORD_MCP_TOKEN: "token" }, fetchImpl: fetchImpl as typeof fetch },
	);

	assert.equal(result.mediaCount, 3);
	assert.equal(result.loadedImageCount, 3);
	assert.equal(result.failures.length, 0);
	assert.deepEqual(
		result.media.map((media) => `${media.source}:${media.kind}:${media.url}:${media.status}`),
		[
			"attachment:image:https://cdn.example/direct.png:loaded",
			"embed:gif:https://proxy.example/preview.gif:loaded",
			"link:image:https://cdn.example/from-content.webp:loaded",
		],
	);
	assert.equal(result.loadedImages[0]?.mimeType, "image/png");
	assert.equal(result.imageContents[0]?.data, pngBytes.toString("base64"));
	assert.equal(result.loadedImages[1]?.mimeType, "image/gif");
	assert.equal(result.imageContents[1]?.data, gifBytes.toString("base64"));
	assert.equal(result.loadedImages[2]?.mimeType, "image/webp");
	assert.equal(result.imageContents[2]?.data, webpBytes.toString("base64"));
}

async function filtersMessagesWithRelativeSinceWindow(): Promise<void> {
	const originalNow = Date.now;
	Date.now = () => Date.UTC(2026, 0, 2, 12, 0, 0);
	try {
		const recentId = snowflakeFor(Date.UTC(2026, 0, 2, 11, 30, 0));
		const oldId = snowflakeFor(Date.UTC(2026, 0, 2, 9, 0, 0));
		const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
			const href = String(url);
			assert.match(href, /\/channels\/channel-1\/messages\?/);
			return jsonResponse([
				{
					id: recentId,
					channel_id: "channel-1",
					content: "recent",
					timestamp: "2026-01-02T11:30:00.000Z",
					attachments: [],
				},
				{
					id: oldId,
					channel_id: "channel-1",
					content: "old",
					timestamp: "2026-01-02T09:00:00.000Z",
					attachments: [],
				},
			]);
		};

		const messages = await readDiscordMessages(
			{ channel_id: "channel-1", limit: 10, since: "1h" },
			{ env: { DISCORD_MCP_TOKEN: "token" }, fetchImpl: fetchImpl as typeof fetch },
		);

		assert.deepEqual(
			messages.map((message) => message.content),
			["recent"],
		);
	} finally {
		Date.now = originalNow;
	}
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});
}

function snowflakeFor(timestampMs: number): string {
	return ((BigInt(timestampMs) - 1_420_070_400_000n) << 22n).toString();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
