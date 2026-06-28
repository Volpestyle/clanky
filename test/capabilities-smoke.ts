import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBrowserBridge } from "../agent/lib/browser-bridge.ts";
import { discordDownloadMedia } from "../agent/lib/discord/media.ts";
import { discordRecentAttachments } from "../agent/lib/discord/media.ts";
import { rememberDiscordMessageFacts } from "../agent/lib/discord/memory.ts";
import { discordAddReaction, discordListEmojis, discordReadMessages, discordRecentActivity, discordSendMessage, discordWhoami } from "../agent/lib/discord/rest.ts";
import { captureWebFrames, renderWebPage } from "../agent/lib/headless-browser.ts";
import { generateOpenAiImage, inspectVisualMedia, mediaBackendStatus } from "../agent/lib/media.ts";
import { buildMemoryContext, rememberMemory, searchMemories } from "../agent/lib/memory.ts";
import { rememberRuntimeMessageFacts } from "../agent/lib/runtime-memory.ts";
import { rememberVoiceTranscriptFacts } from "../agent/lib/voice/memory.ts";
import { buildMcpStdioEnv, upsertMcpServer } from "../agent/lib/mcp.ts";
import { fetchWebPage, searchWeb } from "../agent/lib/web.ts";
import type { FilePart } from "ai";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilePart(value: unknown): value is FilePart {
	return isRecord(value) && value.type === "file";
}

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

function testDiscordSnowflake(isoTimestamp: string): string {
	return ((BigInt(Date.parse(isoTimestamp)) - DISCORD_EPOCH_MS) << 22n).toString();
}

const previousHome = process.env.CLANKY_HOME;
const previousDiscordToken = process.env.DISCORD_BOT_TOKEN;
const previousOpenAiApiKey = process.env.CLANKY_OPENAI_API_KEY;
const previousOpenAiImageModel = process.env.CLANKY_OPENAI_IMAGE_MODEL;
const previousOpenAiVisionModel = process.env.CLANKY_OPENAI_VISION_MODEL;
const home = await mkdtemp(join(tmpdir(), "clanky-capabilities-"));

try {
	process.env.CLANKY_HOME = home;
	process.env.CLANKY_OPENAI_API_KEY = "test-openai-key";
	process.env.CLANKY_OPENAI_IMAGE_MODEL = "gpt-image-2";
	process.env.CLANKY_OPENAI_VISION_MODEL = "gpt-5.4-mini";
	process.env.DISCORD_BOT_TOKEN = "test-token";

	const remembered = await rememberMemory({
		subjectKind: "discord_user",
		subjectId: "u1",
		subjectName: "Paul",
		fact: "Paul likes pie.",
		tags: ["preference"],
		importance: 4,
	});
	assert(remembered.subjectName === "Paul", "memory remember did not store subject name");
	const memories = await searchMemories({ query: "pie", subjectKind: "discord_user" });
	assert(memories.length === 1 && memories[0]?.fact.includes("pie"), "memory search did not find stored fact");
	const discordRemembered = await rememberDiscordMessageFacts({
		externalMessageId: "m-memory",
		channelId: "c1",
		guildId: "g1",
		authorId: "u2",
		authorName: "Annie",
		text: "clanky please remember I prefer concise updates",
		kind: "channel",
		mentionsSelf: false,
	});
	assert(discordRemembered[0]?.fact === "Annie prefers concise updates.", "discord memory capture did not rewrite preference");
	const discordMemories = await searchMemories({ query: "concise", subjectKind: "discord_user", subjectId: "u2" });
	assert(discordMemories.length === 1, "discord memory capture did not persist fact");
	const voiceRemembered = await rememberVoiceTranscriptFacts(
		{
			eventType: "conversation.item.input_audio_transcription.completed",
			text: "please remember I love ramen",
			itemId: "voice-memory",
		},
		{ guildId: "g1", channelId: "vc1", speaker: { userId: "u3", userName: "Morgan" } },
	);
	assert(voiceRemembered[0]?.fact === "Morgan loves ramen.", "voice memory capture did not rewrite transcript fact");
	const voiceMemories = await searchMemories({ query: "ramen", subjectKind: "discord_user", subjectId: "u3" });
	assert(voiceMemories.length === 1, "voice memory capture did not persist fact");
	await rememberMemory({
		subjectKind: "discord_user",
		subjectId: "u-other",
		subjectName: "Taylor",
		fact: "Taylor likes unreleased launch plans.",
		tags: ["private"],
		importance: 5,
	});
	await rememberMemory({
		subjectKind: "discord_server",
		subjectId: "g1",
		fact: "This Discord server uses Linear for work tracking.",
		tags: ["tooling"],
		importance: 4,
	});
	await rememberMemory({
		subjectKind: "main_user",
		fact: "The main user prefers terse implementation summaries.",
		tags: ["preference"],
		importance: 4,
	});
	const discordScopedMemory = await buildMemoryContext({
		limit: 10,
		messages: [
			{
				role: "user",
				content: [
					"Discord conversation update:",
					"- kind: channel",
					"- channelId: c1",
					"- serverId: g1",
					"- newestMessageId: m-context",
					"- authorId: u2",
					"- authorName: Annie",
					"Newest Discord message:",
					"From: Annie",
					"Text: can you check the tracker?",
				].join("\n"),
			},
		],
	});
	assert(discordScopedMemory.includes("Annie prefers concise updates."), "scoped memory did not include current Discord user");
	assert(discordScopedMemory.includes("This Discord server uses Linear"), "scoped memory did not include current Discord server");
	assert(!discordScopedMemory.includes("Paul likes pie."), "scoped memory leaked another Discord user's fact");
	assert(!discordScopedMemory.includes("Taylor likes unreleased"), "scoped memory leaked unrelated Discord user fact");
	assert(!discordScopedMemory.includes("main user prefers"), "scoped Discord memory leaked main-user facts by default");
	const voiceScopedMemory = await buildMemoryContext({
		limit: 10,
		discordUserId: "u3",
		discordUserName: "Morgan",
		discordServerId: "g1",
		includeMainUser: false,
	});
	assert(voiceScopedMemory.includes("Morgan loves ramen."), "voice scoped memory did not include speaker fact");
	assert(!voiceScopedMemory.includes("Annie prefers concise"), "voice scoped memory leaked another Discord user");
	await rememberMemory({
		subjectKind: "discord_user",
		subjectId: "u-interaction",
		subjectName: "Riley",
		fact: "Riley prefers Discord slash-command replies with examples.",
		tags: ["preference"],
		importance: 4,
	});
	await rememberMemory({
		subjectKind: "discord_server",
		subjectId: "g-interaction",
		fact: "This Discord server uses the ask slash command for Clanky.",
		tags: ["discord"],
		importance: 4,
	});
	const interactionScopedMemory = await buildMemoryContext({
		limit: 10,
		messages: [{ role: "user", content: "what should I know for this Discord slash command?" }],
		authPrincipalId: "u-interaction",
		authAuthenticator: "discord-interaction",
		authAttributes: { guild_id: "g-interaction", channel_id: "c-interaction", member_nick: "Riley" },
	});
	assert(interactionScopedMemory.includes("Riley prefers Discord slash-command"), "auth-scoped memory missed Discord user fact");
	assert(interactionScopedMemory.includes("ask slash command"), "auth-scoped memory missed Discord server fact");
	assert(!interactionScopedMemory.includes("Morgan loves ramen"), "auth-scoped memory leaked unrelated voice user fact");
	const mainScopedMemory = await buildMemoryContext({
		limit: 10,
		messages: [{ role: "user", content: "what should you remember about my reply style?" }],
	});
	assert(mainScopedMemory.includes("The main user prefers terse"), "main scoped memory did not include main-user fact");
	assert(!mainScopedMemory.includes("Annie prefers concise"), "main scoped memory leaked Discord user fact");
	const runtimeMainSaved = await rememberRuntimeMessageFacts({
		message: "clanky please remember I like espresso",
		sessionId: "main-session",
		turnId: "main-turn",
		channelKind: "eve",
	});
	assert(runtimeMainSaved[0]?.subjectKind === "main_user", "runtime memory did not classify main user fact");
	assert(runtimeMainSaved[0]?.fact === "The main user likes espresso.", "runtime memory did not rewrite main user fact");
	const runtimeMainMemory = await buildMemoryContext({
		limit: 10,
		messages: [{ role: "user", content: "what coffee do I like?" }],
	});
	assert(runtimeMainMemory.includes("The main user likes espresso."), "runtime memory did not inject main user fact");
	const runtimeDiscordSaved = await rememberRuntimeMessageFacts({
		message: "clanky please remember I prefer short slash replies",
		sessionId: "discord-session",
		turnId: "discord-turn",
		channelKind: "discord",
		authPrincipalId: "u-runtime-discord",
		authAuthenticator: "discord-interaction",
		authAttributes: { guild_id: "g-runtime-discord", channel_id: "c-runtime-discord", member_nick: "Sam" },
	});
	assert(runtimeDiscordSaved[0]?.subjectKind === "discord_user", "runtime memory did not classify Discord interaction user");
	assert(runtimeDiscordSaved[0]?.subjectId === "u-runtime-discord", "runtime memory did not use Discord principal id");
	const skippedPresenceSaved = await rememberRuntimeMessageFacts({
		message: "Discord conversation update:\n\nNewest Discord message:\nFrom: Sam\nText: clanky please remember I like tea",
		sessionId: "presence-session",
		turnId: "presence-turn",
		channelKind: "eve",
	});
	assert(skippedPresenceSaved.length === 0, "runtime memory should skip gateway presence prompts");

	const page = await fetchWebPage(
		{ url: "https://example.test/page", maxTextChars: 1000 },
		async () =>
			new Response(
				`<html><head><title>Hello</title></head><body><h1>Hi</h1><a href="/next">Next</a><img src="/a.png" alt="A"></body></html>`,
				{ status: 200, headers: { "content-type": "text/html" } },
			),
	);
	assert(page.title === "Hello", "web_fetch did not parse title");
	assert(page.links[0]?.url === "https://example.test/next", "web_fetch did not absolutize link");
	assert(page.media[0]?.url === "https://example.test/a.png", "web_fetch did not extract media");

	const search = await searchWeb(
		{ query: "clanky", limit: 1 },
		async () =>
			new Response(`<a class="result__a" href="/l/?uddg=${encodeURIComponent("https://example.test/result")}">Result</a>`, {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
	);
	assert(search.results[0]?.url === "https://example.test/result", "web_search did not unwrap result URL");

	const rendered = await renderWebPage(
		{ url: "https://example.test/rendered", maxTextChars: 12, screenshot: true },
		{
			env: process.env,
			loadPage: async () => ({
				finalUrl: "https://example.test/rendered#loaded",
				title: "Rendered",
				text: "Rendered page text from a JavaScript app",
				links: [
					{ text: "Video", url: "https://youtube.com/watch?v=1" },
					{ text: "Video duplicate", url: "https://youtube.com/watch?v=1" },
				],
				media: [
					{ kind: "image", url: "https://example.test/preview.png" },
					{ kind: "gif", url: "https://example.test/loop.gif" },
				],
				meta: [{ name: "og:title", content: "Rendered OG title" }],
				screenshotPng: Buffer.from("fake-png"),
			}),
		},
	);
	assert(rendered.title === "Rendered", "web_render did not preserve rendered title");
	assert(rendered.text === "Rendered pag", "web_render did not truncate visible text");
	assert(rendered.truncated, "web_render did not mark truncated text");
	assert(rendered.links.length === 1, "web_render did not dedupe rendered links");
	assert(rendered.media.some((item) => item.kind === "gif"), "web_render did not preserve rendered media");
	assert(rendered.meta[0]?.content === "Rendered OG title", "web_render did not preserve metadata");
	assert(rendered.screenshotPath !== undefined, "web_render did not write screenshot artifact");
	const screenshotPath = rendered.screenshotPath;
	assert(screenshotPath !== undefined, "web_render did not write screenshot artifact");
	assert((await stat(screenshotPath)).size > 0, "web_render screenshot artifact was empty");

	const frameCapture = await captureWebFrames(
		{ path: join(home, "clip.gif"), frameCount: 2, intervalMs: 250 },
		{
			env: process.env,
			capturePage: async (input) => {
				assert(input.navigationUrl.startsWith("file://"), "web_capture_frames did not convert local path to file URL");
				assert(input.mediaKind === "image", "web_capture_frames did not classify local GIF media");
				assert(input.frameCount === 2, "web_capture_frames did not preserve requested frame count");
				assert(input.intervalMs === 250, "web_capture_frames did not preserve requested interval");
				return {
					finalUrl: input.navigationUrl,
					title: "Clip",
					mediaState: { videos: [{ currentTime: 1.25, duration: 4, paused: false, muted: true, readyState: 4 }] },
					frames: [
						{ capturedAtMs: 0, png: Buffer.from("frame-one") },
						{ capturedAtMs: 250, png: Buffer.from("frame-two") },
					],
				};
			},
		},
	);
	assert(frameCapture.frameCount === 2, "web_capture_frames did not return captured frame count");
	assert(frameCapture.mediaState.videos[0]?.paused === false, "web_capture_frames did not preserve media state");
	for (const frame of frameCapture.frames) {
		assert((await stat(frame.path)).size > 0, "web_capture_frames frame artifact was empty");
	}
	const videoFrameCapture = await captureWebFrames(
		{ url: "https://example.test/clip.mp4?download=1", frameCount: 1 },
		{
			env: process.env,
			capturePage: async (input) => {
				assert(input.navigationUrl === "https://example.test/clip.mp4?download=1", "web_capture_frames changed direct video URL");
				assert(input.mediaKind === "video", "web_capture_frames did not classify direct video URL");
				return {
					finalUrl: input.navigationUrl,
					title: "Video",
					mediaState: { videos: [{ currentTime: 0.5, duration: 2, paused: false, muted: true, readyState: 4 }] },
					frames: [{ capturedAtMs: 0, png: Buffer.from("video-frame") }],
				};
			},
		},
	);
	assert(videoFrameCapture.mediaState.videos[0]?.duration === 2, "web_capture_frames did not preserve direct video media state");

	const unavailableBrowser = await callBrowserBridge({ op: "status" });
	assert((unavailableBrowser as { available?: boolean }).available === false, "browser status should be unavailable before install/start");
	assert(
		((unavailableBrowser as { nextSteps?: unknown[] }).nextSteps ?? []).some((step) => String(step).includes("install")),
		"browser status did not report install next step",
	);

	await mkdir(join(home, "browser-bridge"), { recursive: true });
	await mkdir(join(home, "browser-bridge", "extension"), { recursive: true });
	await writeFile(join(home, "browser-bridge", "config.json"), JSON.stringify({ port: 41783, token: "secret" }));
	await writeFile(
		join(home, "browser-bridge", "extension", "manifest.json"),
		JSON.stringify({ name: "Clanky Browser Bridge", version: "0.8.0" }),
	);
	await writeFile(join(home, "browser-bridge", "extension", "config.json"), JSON.stringify({ port: 41783, token: "secret" }));
	await writeFile(
		join(home, "browser-bridge", "state.json"),
		JSON.stringify({
			port: 41783,
			pid: 123,
			secret: "secret",
			browser: "test",
			expectedExtensionVersion: "0.8.0",
			connectedBrowsers: [{ browser: "test", version: "0.8.0", stale: false, connectedAt: "now" }],
		}),
	);
	const availableBrowser = await callBrowserBridge(
		{ op: "status" },
		async (url) => {
			assert(String(url).endsWith("/healthz"), "browser status used wrong route");
			return jsonResponse({
				ok: true,
				connectionCount: 1,
				extensions: [{ browser: "test", version: "0.8.0", stale: false }],
			});
		},
	);
	assert((availableBrowser as { available?: boolean }).available === true, "browser status did not report available bridge");
	assert(
		((availableBrowser as { state?: { hasSecret?: boolean; secret?: string } }).state?.hasSecret === true) &&
			(availableBrowser as { state?: { secret?: string } }).state?.secret === undefined,
		"browser status leaked or lost secret redaction",
	);
	const browserResult = await callBrowserBridge(
		{ op: "open_tab", params: { url: "https://example.test" } },
		async (url, init) => {
			assert(String(url).endsWith("/tabs"), "browser bridge used wrong route");
			assert(new Headers(init?.headers).get("x-clanky-token") === "secret", "browser bridge did not send token");
			return jsonResponse({ tabId: 1, url: "https://example.test", active: true });
		},
	);
	assert((browserResult as { tabId?: number }).tabId === 1, "browser bridge did not return parsed JSON");
	const browserSnapshot = await callBrowserBridge(
		{ op: "snapshot", params: { tabId: 1, maxElements: 5 } },
		async (url, init) => {
			assert(String(url).endsWith("/snapshot"), "browser snapshot used wrong route");
			assert(new Headers(init?.headers).get("x-clanky-token") === "secret", "browser snapshot did not send token");
			assert(typeof init?.body === "string" && init.body.includes('"maxElements":5'), "browser snapshot did not send params");
			return jsonResponse({
				tabId: 1,
				url: "https://example.test",
				title: "Example",
				text: "Hello",
				length: 5,
				truncated: false,
				viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
				links: [],
				media: [],
				elements: [],
				counts: { links: 0, media: 0, elements: 0 },
			});
		},
	);
	assert((browserSnapshot as { title?: string }).title === "Example", "browser snapshot did not return parsed JSON");

	const messages = await discordReadMessages(
		{ channelId: "c1", limit: 1 },
		{
			fetchImpl: async (url, init) => {
				assert(String(url).includes("/channels/c1/messages"), "discord read used wrong route");
				assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord read auth header wrong");
				return jsonResponse([
					{
						id: "1440000000000000000",
						channel_id: "c1",
						content: "look https://example.test/x.gif",
						author: { id: "u1", username: "paul" },
						attachments: [],
						embeds: [
							{
								type: "rich",
								provider: { name: "YouTube" },
								title: "Video preview",
								url: "https://youtube.com/watch?v=1",
								thumbnail: {
									url: "https://i.ytimg.com/vi/1/hqdefault.jpg",
									proxy_url: "https://images-ext-1.discordapp.net/external/youtube-thumb.jpg",
									width: 480,
									height: 360,
									content_type: "image/jpeg",
								},
								video: {
									url: "https://www.youtube.com/embed/1",
									width: 1280,
									height: 720,
								},
							},
						],
					},
				]);
			},
		},
	);
	const readMedia = messages[0]?.media ?? [];
	assert(readMedia.some((item) => item.kind === "gif" && item.source === "content"), "discord read did not classify media link");
	const youtubeThumb = readMedia.find((item) => item.provider === "YouTube" && item.sourceDetail === "thumbnail");
	assert(
		youtubeThumb !== undefined && youtubeThumb.url === "https://images-ext-1.discordapp.net/external/youtube-thumb.jpg",
		"discord read did not prefer embed proxy URL",
	);
	assert(youtubeThumb.originalUrl === "https://i.ytimg.com/vi/1/hqdefault.jpg", "discord read did not preserve embed original URL");
	assert(youtubeThumb.width === 480 && youtubeThumb.height === 360, "discord read did not preserve embed dimensions");
	assert(readMedia.some((item) => item.provider === "YouTube" && item.sourceDetail === "video" && item.kind === "video"), "discord read did not preserve embed video media");
	assert(readMedia.some((item) => item.provider === "YouTube" && item.sourceDetail === "url" && item.kind === "link"), "discord read did not keep social preview link");

	const windowedInsideId = testDiscordSnowflake("2026-06-19T10:00:00.000Z");
	const windowedNewerId = testDiscordSnowflake("2026-06-19T10:10:00.000Z");
	const windowedOlderId = testDiscordSnowflake("2026-06-19T09:00:00.000Z");
	const windowedMessages = await discordReadMessages(
		{
			channelId: "c-window",
			limit: 2,
			since: "2026-06-19T09:30:00.000Z",
			until: "2026-06-19T10:05:00.000Z",
		},
		{
			fetchImpl: async (url, init) => {
				const href = String(url);
				assert(href.includes("/channels/c-window/messages"), "discord windowed read used wrong route");
				assert(href.includes("limit=25"), "discord windowed read did not use bounded page size");
				assert(href.includes("before="), "discord windowed read did not apply until cursor");
				assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord windowed read auth header wrong");
				return jsonResponse([
					{
						id: windowedNewerId,
						channel_id: "c-window",
						content: "too new",
						timestamp: "2026-06-19T10:10:00.000Z",
						attachments: [],
						embeds: [],
					},
					{
						id: windowedInsideId,
						channel_id: "c-window",
						content: "inside",
						timestamp: "2026-06-19T10:00:00.000Z",
						attachments: [],
						embeds: [],
					},
					{
						id: windowedOlderId,
						channel_id: "c-window",
						content: "too old",
						timestamp: "2026-06-19T09:00:00.000Z",
						attachments: [],
						embeds: [],
					},
				]);
			},
		},
	);
	assert(windowedMessages.length === 1 && windowedMessages[0]?.content === "inside", "discord windowed read did not filter by since/until");

	const activity = await discordRecentActivity(
		{
			guildId: "g1",
			since: "2026-06-19T09:30:00.000Z",
			channelNameQuery: "gen",
			channelLimit: 5,
			messageLimit: 3,
		},
		{
			fetchImpl: async (url) => {
				const href = String(url);
				if (href.includes("/guilds/g1/channels")) {
					return jsonResponse([
						{ id: "c-old", name: "old", type: 0, last_message_id: windowedOlderId },
						{ id: "c-active", name: "general", type: 0, last_message_id: windowedInsideId },
						{ id: "c-voice", name: "general voice", type: 2, last_message_id: windowedInsideId },
					]);
				}
				if (href.includes("/channels/c-active/messages")) {
					return jsonResponse([
						{
							id: windowedInsideId,
							channel_id: "c-active",
							content: "active message",
							author: { id: "u1", username: "paul" },
							timestamp: "2026-06-19T10:00:00.000Z",
							attachments: [],
							embeds: [],
						},
					]);
				}
				throw new Error(`unexpected recent activity fetch URL ${href}`);
			},
		},
	);
	assert(activity.sinceTimestamp === "2026-06-19T09:30:00.000Z", "discord recent activity did not preserve since timestamp");
	assert(activity.activeChannelCount === 1, "discord recent activity did not filter active text channels");
	assert(activity.channels[0]?.id === "c-active", "discord recent activity picked wrong channel");
	assert(activity.channels[0]?.messages[0]?.content === "active message", "discord recent activity did not read bounded messages");
	assert(activity.channels[0]?.messageCount === 1, "discord recent activity did not count channel messages");
	assert(activity.channels[0]?.topParticipants[0]?.authorUsername === "paul", "discord recent activity did not summarize participants");

	const identity = await discordWhoami({
		fetchImpl: async (url, init) => {
			assert(String(url).endsWith("/users/@me"), "discord whoami used wrong route");
			assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord whoami auth header wrong");
			return jsonResponse({ id: "bot1", username: "clanky", global_name: "Clanky", bot: true });
		},
	});
	assert(identity.id === "bot1" && identity.globalName === "Clanky" && identity.bot === true, "discord whoami parsed identity wrong");

	const emojis = await discordListEmojis("g1", {
		fetchImpl: async (url, init) => {
			assert(String(url).includes("/guilds/g1/emojis"), "discord emoji list used wrong route");
			assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord emoji list auth header wrong");
			return jsonResponse([
				{ id: "e1", name: "party", animated: false },
				{ id: "e2", name: "dance", animated: true },
			]);
		},
	});
	assert(emojis[0]?.reaction === "party:e1", "discord emoji list did not format static reaction string");
	assert(emojis[1]?.reaction === "a:dance:e2", "discord emoji list did not format animated reaction string");

	const reaction = await discordAddReaction(
		{ channelId: "c1", messageId: "m1", emoji: "party:e1" },
		{
			fetchImpl: async (url, init) => {
				assert(String(url).includes("/channels/c1/messages/m1/reactions/party%3Ae1/@me"), "discord reaction used wrong route");
				assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord reaction auth header wrong");
				assert(init?.body === undefined, "discord reaction should not send a request body");
				return new Response(null, { status: 204 });
			},
		},
	);
	assert(reaction.ok && reaction.emoji === "party:e1", "discord reaction did not return confirmation");

	const png = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
	png.writeUInt32BE(3, 16);
	png.writeUInt32BE(5, 20);
	const generatedImage = await generateOpenAiImage(
		{
			prompt: "a clanky test image",
			size: "1024x1024",
			quality: "high",
			outputFormat: "png",
			filenamePrefix: "capability-test",
		},
		async (url, init) => {
			assert(String(url) === "https://api.openai.com/v1/images/generations", "image generation used wrong endpoint");
			assert(new Headers(init?.headers).get("authorization") === "Bearer test-openai-key", "image generation auth header wrong");
			assert(new Headers(init?.headers).get("content-type") === "application/json", "image generation content type wrong");
			assert(typeof init?.body === "string", "image generation did not send JSON body");
			const body = JSON.parse(init.body) as unknown;
			assert(isRecord(body) && body.model === "gpt-image-2", "image generation did not use configured model");
			assert(isRecord(body) && body.prompt === "a clanky test image", "image generation did not preserve prompt");
			assert(isRecord(body) && body.output_format === "png", "image generation did not set output format");
			return jsonResponse({
				data: [{ b64_json: png.toString("base64"), revised_prompt: "a clanky test image, revised" }],
				usage: { total_tokens: 1 },
			});
		},
	);
	assert(generatedImage.model === "gpt-image-2", "image generation result model wrong");
	assert(generatedImage.files.length === 1, "image generation did not save output file");
	const generatedImagePath = generatedImage.files[0]?.path;
	assert(generatedImagePath !== undefined, "image generation did not return output path");
	assert(generatedImagePath.startsWith(join(home, "media", "openai-images")), "image generation did not use Clanky data path");
	const generatedImageStat = await stat(generatedImagePath);
	assert(generatedImageStat.size === png.length, "image generation saved wrong artifact size");
	assert((generatedImageStat.mode & 0o777) === 0o600, "image generation artifact was not private");

	const recentAttachments = await discordRecentAttachments(
		{ channelId: "c1", limit: 2, mediaLimit: 2, download: true, describe: false },
		{
			fetchImpl: async (url, init) => {
				const headers = new Headers(init?.headers);
				const href = String(url);
				if (href.includes("/channels/c1/messages")) {
					assert(headers.get("authorization") === "Bot test-token", "discord recent attachments read auth header wrong");
					return jsonResponse([
						{
							id: "1440000000000000001",
							channel_id: "c1",
							content: "",
							author: { id: "u1", username: "paul" },
							timestamp: "2026-06-19T10:00:00.000Z",
							attachments: [
								{
									id: "a1",
									url: "https://cdn.discordapp.com/attachments/c1/m-recent/photo.png",
									filename: "photo.png",
									content_type: "image/png",
									size: png.length,
									width: 3,
									height: 5,
								},
							],
							embeds: [
								{
									type: "rich",
									provider: { name: "X" },
									title: "X preview",
									url: "https://x.com/example/status/1",
									thumbnail: {
										url: "https://pbs.twimg.com/media/preview.jpg",
										proxy_url: "https://media.discordapp.net/external/x-preview.jpg",
										width: 3,
										height: 5,
										content_type: "image/jpeg",
									},
								},
							],
						},
					]);
				}
				if (href === "https://cdn.discordapp.com/attachments/c1/m-recent/photo.png") {
					assert(headers.get("authorization") === "Bot test-token", "discord recent attachments did not auth Discord CDN URL");
					return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
				}
				if (href === "https://media.discordapp.net/external/x-preview.jpg") {
					assert(headers.get("authorization") === "Bot test-token", "discord recent attachments did not auth Discord media proxy URL");
					return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
				}
				throw new Error(`unexpected recent attachment fetch URL ${href}`);
			},
		},
	);
	assert(recentAttachments.mediaCount === 2, "discord_recent_attachments did not find message media");
	assert(recentAttachments.downloadedCount === 2, "discord_recent_attachments did not download media");
	assert(recentAttachments.media[0]?.size === png.length, "discord_recent_attachments did not preserve attachment size");
	assert(recentAttachments.media[0]?.width === 3 && recentAttachments.media[0]?.height === 5, "discord_recent_attachments did not preserve media dimensions");
	assert(recentAttachments.media[0]?.downloaded?.width === 3, "discord_recent_attachments did not probe downloaded dimensions");
	assert(recentAttachments.media[1]?.provider === "X", "discord_recent_attachments did not preserve embed provider");
	assert(recentAttachments.media[1]?.originalUrl === "https://pbs.twimg.com/media/preview.jpg", "discord_recent_attachments did not preserve embed original URL");
	const recentPath = recentAttachments.media[0]?.downloaded?.path;
	assert(recentPath !== undefined && (await stat(recentPath)).size === png.length, "discord_recent_attachments artifact was wrong");
	const downloaded = await discordDownloadMedia(
		{
			channelId: "c1",
			messageId: "m-media",
			urls: ["https://example.test/direct.png"],
			maxItems: 3,
		},
		{
			fetchImpl: async (url, init) => {
				const headers = new Headers(init?.headers);
				const href = String(url);
				if (href.includes("/channels/c1/messages")) {
					assert(headers.get("authorization") === "Bot test-token", "discord media message read auth header wrong");
					return jsonResponse([
						{
							id: "m-media",
							channel_id: "c1",
							content: "",
							author: { id: "u1", username: "paul" },
							attachments: [
								{
									id: "a1",
									url: "https://cdn.discordapp.com/attachments/c1/m-media/photo.png",
									filename: "photo.png",
									content_type: "image/png",
									size: png.length,
								},
							],
							embeds: [],
						},
					]);
				}
				if (href === "https://example.test/direct.png") {
					assert(headers.get("authorization") === null, "discord media leaked auth to third-party URL");
					return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
				}
				if (href === "https://cdn.discordapp.com/attachments/c1/m-media/photo.png") {
					assert(headers.get("authorization") === "Bot test-token", "discord media did not auth Discord CDN URL");
					return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
				}
				throw new Error(`unexpected media fetch URL ${href}`);
			},
		},
	);
	assert(downloaded.items.length === 2, "discord_download_media did not download direct and message media");
	assert(downloaded.items.every((item) => item.width === 3 && item.height === 5), "discord_download_media did not probe PNG dimensions");
	for (const item of downloaded.items) {
		assert((await stat(item.path)).size === png.length, "discord_download_media artifact size was wrong");
	}
	const inspected = await inspectVisualMedia(
		{ paths: [downloaded.items[0]?.path ?? ""], prompt: "Describe the visual artifact.", model: "test-vision" },
		{
			generate: async (request) => {
				assert(request.provider === "openai", "explicit media_inspect model should use OpenAI fallback backend");
				assert(request.model === "test-vision", "media_inspect did not preserve requested model");
				assert(Array.isArray(request.content), "media_inspect did not pass multimodal content");
				const fileParts = request.content.filter(isFilePart);
				assert(fileParts.length === 1, "media_inspect did not attach exactly one file part");
				assert(fileParts[0]?.mediaType === "image/png", "media_inspect did not detect PNG media type");
				const fileData: unknown = fileParts[0]?.data;
				assert(isRecord(fileData) && fileData.type === "data", "media_inspect did not use inline data file part");
				assert(Buffer.isBuffer(fileData.data), "media_inspect did not pass image bytes to generator");
				return { text: "A tiny 3 by 5 PNG artifact." };
			},
		},
	);
	assert(inspected.text.includes("tiny"), "media_inspect did not return generator text");
	assert(inspected.items[0]?.bytes === png.length, "media_inspect did not report inspected byte size");

	const mangledPath = (downloaded.items[0]?.path ?? "").replace(/-[0-9a-f]{8}-[0-9a-f]{4}-/u, "-00000000-0000-");
	assert(mangledPath !== downloaded.items[0]?.path, "test did not mangle downloaded media path");
	const recoveredInspect = await inspectVisualMedia(
		{ paths: [mangledPath], prompt: "Describe the recovered visual artifact.", model: "test-vision" },
		{
			generate: async () => ({ text: "Recovered a tiny PNG artifact." }),
		},
	);
	assert(recoveredInspect.items[0]?.path === downloaded.items[0]?.path, "media_inspect did not recover mangled Discord media path");

	const downloadedPathForPrompt = downloaded.items[0]?.path;
	assert(downloadedPathForPrompt !== undefined, "test media download path missing");
	const localVisionCalls: string[] = [];
	const localVision = await inspectVisualMedia(
		{ paths: [downloadedPathForPrompt], prompt: "Describe the local visual artifact." },
		{
			env: {
				CLANKY_MODEL_PROVIDER: "local",
				CLANKY_LOCAL_MODEL: "test-local-vision",
				CLANKY_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
			},
			fetchImpl: async (input, init) => {
				const href = String(input);
				localVisionCalls.push(href);
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					model?: string;
					think?: boolean;
					options?: {
						num_ctx?: number;
						num_predict?: number;
						temperature?: number;
					};
					messages?: Array<{
						content?: string;
						images?: string[];
					}>;
				};
				if (href === "http://127.0.0.1:11434/api/show") {
					assert(body.model === "test-local-vision", "media_inspect probed the wrong Ollama model");
					return jsonResponse({ capabilities: ["completion", "vision", "tools"] });
				}
				if (href === "http://127.0.0.1:11434/api/chat") {
					assert(body.model === "test-local-vision", "media_inspect sent images to the wrong Ollama model");
					assert(body.think === false, "media_inspect should disable Ollama thinking for image inspection");
					assert(body.options?.num_ctx === 8192, "media_inspect should bound single-image Ollama vision context");
					assert(body.options?.num_predict === 2048, "media_inspect should bound Ollama vision output");
					assert(body.options?.temperature === 0, "media_inspect should use deterministic Ollama vision sampling");
					const message = body.messages?.[0];
					assert(message?.content?.includes("Describe the local visual artifact.") === true, "media_inspect omitted the prompt");
					assert(message?.content?.includes(downloadedPathForPrompt) === false, "media_inspect should not steer Ollama with local paths");
					assert(message?.content?.includes("Images attached as binary inputs:") === true, "media_inspect should tell Ollama images are attached");
					assert(message.images?.length === 1, "media_inspect did not send image bytes to Ollama");
					assert(typeof message.images[0] === "string" && message.images[0].length > 0, "media_inspect sent an empty Ollama image");
					return jsonResponse({
						message: { role: "assistant", content: "The active local model saw a tiny PNG." },
						prompt_eval_count: 1,
						eval_count: 2,
					});
				}
				throw new Error(`unexpected Ollama URL ${href}`);
			},
		},
	);
	assert(localVision.provider === "ollama", "media_inspect did not use active Ollama vision backend");
	assert(localVision.model === "test-local-vision", "media_inspect did not report active Ollama model");
	assert(localVision.text.includes("active local model"), "media_inspect did not return Ollama vision text");
	assert(localVisionCalls.includes("http://127.0.0.1:11434/api/show"), "media_inspect did not probe Ollama capabilities");
	assert(localVisionCalls.includes("http://127.0.0.1:11434/api/chat"), "media_inspect did not call native Ollama chat");

	const chunkedVisionPrompts: string[] = [];
	const chunkedVisionImageCounts: number[] = [];
	let chunkedVisionChatCalls = 0;
	const chunkedVision = await inspectVisualMedia(
		{ paths: Array.from({ length: 5 }, () => downloadedPathForPrompt), prompt: "Describe chunked visuals." },
		{
			env: {
				CLANKY_MODEL_PROVIDER: "local",
				CLANKY_LOCAL_MODEL: "test-local-vision",
				CLANKY_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
			},
			fetchImpl: async (input, init) => {
				const href = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					model?: string;
					messages?: Array<{
						content?: string;
						images?: string[];
					}>;
				};
				if (href === "http://127.0.0.1:11434/api/show") return jsonResponse({ capabilities: ["completion", "vision"] });
				if (href === "http://127.0.0.1:11434/api/chat") {
					chunkedVisionChatCalls += 1;
					const message = body.messages?.[0];
					assert(body.model === "test-local-vision", "chunked media_inspect sent images to the wrong Ollama model");
					assert(message?.content !== undefined, "chunked media_inspect omitted the prompt");
					chunkedVisionPrompts.push(message.content);
					chunkedVisionImageCounts.push(message.images?.length ?? 0);
					return jsonResponse({ message: { role: "assistant", content: `Chunk ${chunkedVisionChatCalls} saw its images.` } });
				}
				throw new Error(`unexpected chunked Ollama URL ${href}`);
			},
		},
	);
	assert(chunkedVision.text.includes("[Images 1-4]"), "chunked media_inspect did not label the first image group");
	assert(chunkedVision.text.includes("[Images 5-5]"), "chunked media_inspect did not label the second image group");
	assert(chunkedVisionImageCounts[0] === 4, "first chunk should include four images");
	assert(chunkedVisionImageCounts[1] === 1, "second chunk should include one image");
	assert(chunkedVisionPrompts[0]?.includes("4. ") === true, "first chunk prompt omitted its fourth image");
	assert(chunkedVisionPrompts[0]?.includes("5. ") === false, "first chunk prompt leaked the next image index");
	assert(chunkedVisionPrompts[1]?.includes("5. ") === true, "second chunk prompt omitted its image index");
	assert(chunkedVisionPrompts[1]?.includes("1. ") === false, "second chunk prompt leaked the first image index");

	// Provider-independent vision override: a hosted codex brain, but image inspection routed to a
	// local Ollama model via CLANKY_VISION_*. The override is trusted, so it skips the /api/show probe.
	const overrideVisionCalls: string[] = [];
	const overrideVision = await inspectVisualMedia(
		{ paths: [downloadedPathForPrompt], prompt: "Describe the override visual artifact." },
		{
			env: {
				CLANKY_MODEL_PROVIDER: "codex",
				CLANKY_CODEX_MODEL: "gpt-5.5",
				CLANKY_VISION_ENABLED: "1",
				CLANKY_VISION_MODEL: "test-local-vision-override",
				CLANKY_VISION_BASE_URL: "http://127.0.0.1:11434/v1",
			},
			fetchImpl: async (input, init) => {
				const href = String(input);
				overrideVisionCalls.push(href);
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					model?: string;
					messages?: Array<{
						images?: string[];
					}>;
				};
				if (href === "http://127.0.0.1:11434/api/chat") {
					assert(body.model === "test-local-vision-override", "override did not send images to the selected vision model");
					assert(body.messages?.[0]?.images?.length === 1, "override did not send image bytes to Ollama");
					return jsonResponse({
						message: { role: "assistant", content: "The configured local vision model saw a tiny PNG." },
					});
				}
				throw new Error(`unexpected override Ollama URL ${href}`);
			},
		},
	);
	assert(overrideVision.provider === "ollama", "override did not use the selected Ollama vision backend");
	assert(overrideVision.model === "test-local-vision-override", "override did not report the selected vision model");
	assert(overrideVision.text.includes("configured local vision"), "override did not return the selected vision text");
	assert(!overrideVisionCalls.includes("http://127.0.0.1:11434/api/show"), "trusted override should skip the /api/show probe");
	assert(overrideVisionCalls.includes("http://127.0.0.1:11434/api/chat"), "override did not call native Ollama chat");

	const fallbackVision = await inspectVisualMedia(
		{ paths: [downloaded.items[0]?.path ?? ""], prompt: "Use fallback vision." },
		{
			env: {
				CLANKY_MODEL_PROVIDER: "local",
				CLANKY_LOCAL_MODEL: "test-local-text",
				CLANKY_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
				CLANKY_OPENAI_API_KEY: "test-openai-key",
				CLANKY_OPENAI_VISION_MODEL: "fallback-vision",
			},
			fetchImpl: async (input) => {
				const href = String(input);
				if (href === "http://127.0.0.1:11434/api/show") return jsonResponse({ capabilities: ["completion", "tools"] });
				throw new Error(`unexpected fallback probe URL ${href}`);
			},
			generate: async (request) => {
				assert(request.provider === "openai", "media_inspect did not fall back to OpenAI when active model lacked vision");
				assert(request.model === "fallback-vision", "media_inspect did not use configured fallback vision model");
				return { text: "OpenAI fallback described the artifact." };
			},
		},
	);
	assert(fallbackVision.provider === "openai", "media_inspect fallback did not report OpenAI provider");
	assert(fallbackVision.text.includes("fallback"), "media_inspect fallback did not return generated text");

	const sent = await discordSendMessage(
		{ channelId: "c1", content: "hello" },
		{
			fetchImpl: async () => jsonResponse({ id: "m1" }),
		},
	);
	assert(sent.messageIds[0] === "m1", "discord send did not return sent id");
	const uploaded = await discordSendMessage(
		{ channelId: "c1", content: "generated image", filePaths: [generatedImagePath], replyToMessageId: "m-parent" },
		{
			fetchImpl: async (url, init) => {
				assert(String(url).includes("/channels/c1/messages"), "discord upload used wrong route");
				assert(new Headers(init?.headers).get("authorization") === "Bot test-token", "discord upload auth header wrong");
				assert(new Headers(init?.headers).get("content-type") === null, "discord upload should let FormData set content type");
				assert(init?.body instanceof FormData, "discord upload did not use multipart FormData");
				const form = init.body;
				const payloadRaw = form.get("payload_json");
				assert(typeof payloadRaw === "string", "discord upload missing payload_json");
				const payload = JSON.parse(payloadRaw) as unknown;
				assert(isRecord(payload) && payload.content === "generated image", "discord upload payload content wrong");
				assert(
					isRecord(payload.message_reference) && payload.message_reference.message_id === "m-parent",
					"discord upload dropped reply reference",
				);
				const file = form.get("files[0]");
				assert(file instanceof Blob, "discord upload missing file blob");
				assert(file.size === png.length, "discord upload file blob size wrong");
				return jsonResponse({ id: "m-upload" });
			},
		},
	);
	assert(uploaded.messageIds[0] === "m-upload", "discord upload did not return sent id");
	assert(uploaded.attachmentCount === 1, "discord upload attachment count wrong");

	const mcp = await upsertMcpServer("minecraft", {
		command: "minecraft-mcp",
		description: "Minecraft MCP server",
	});
	assert(mcp.servers.minecraft?.command === "minecraft-mcp", "mcp_configure did not persist server");
	const mcpChildEnv = buildMcpStdioEnv(
		{ EXPLICIT_TOKEN: "server-token", OPENAI_API_KEY: "explicit-openai" },
		{
			PATH: "/bin",
			HOME: "/tmp/home",
			OPENAI_API_KEY: "ambient-openai",
			DISCORD_BOT_TOKEN: "ambient-discord",
			CLANKY_RELAY_TOKEN: "ambient-relay",
			FOO: "ambient-foo",
		},
	);
	assert(mcpChildEnv.PATH === "/bin", "mcp stdio env did not preserve PATH");
	assert(mcpChildEnv.HOME === "/tmp/home", "mcp stdio env did not preserve HOME");
	assert(mcpChildEnv.DISCORD_BOT_TOKEN === undefined, "mcp stdio env leaked Discord token");
	assert(mcpChildEnv.CLANKY_RELAY_TOKEN === undefined, "mcp stdio env leaked Clanky token");
	assert(mcpChildEnv.FOO === undefined, "mcp stdio env leaked arbitrary ambient env");
	assert(mcpChildEnv.EXPLICIT_TOKEN === "server-token", "mcp stdio env did not preserve explicit server env");
	assert(mcpChildEnv.OPENAI_API_KEY === "explicit-openai", "mcp stdio env did not let explicit server env override ambient");

	const media = await mediaBackendStatus({
		...process.env,
		CLANKY_MODEL_PROVIDER: "codex",
		CLANKY_CODEX_MODEL: "gpt-5.4",
	});
	assert((media.activeVision as { available?: boolean }).available === true, "media status did not report active vision backend");
	assert((media.openaiImages as { model?: string }).model === "gpt-image-2", "media status did not use configured image model");
	assert((media.openaiVision as { model?: string }).model === "gpt-5.4-mini", "media status did not use configured vision model");
} finally {
	if (previousHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = previousHome;
	if (previousDiscordToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
	else process.env.DISCORD_BOT_TOKEN = previousDiscordToken;
	if (previousOpenAiApiKey === undefined) delete process.env.CLANKY_OPENAI_API_KEY;
	else process.env.CLANKY_OPENAI_API_KEY = previousOpenAiApiKey;
	if (previousOpenAiImageModel === undefined) delete process.env.CLANKY_OPENAI_IMAGE_MODEL;
	else process.env.CLANKY_OPENAI_IMAGE_MODEL = previousOpenAiImageModel;
	if (previousOpenAiVisionModel === undefined) delete process.env.CLANKY_OPENAI_VISION_MODEL;
	else process.env.CLANKY_OPENAI_VISION_MODEL = previousOpenAiVisionModel;
	await rm(home, { recursive: true, force: true });
}
