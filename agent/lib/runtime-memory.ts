import type { DiscordInboundMessage } from "./discord/acceptance.ts";
import { extractDiscordMemoryCandidates } from "./discord/memory.ts";
import { rememberMemory, type MemoryFact, type RememberMemoryInput } from "./memory.ts";

export interface RuntimeMemoryCaptureInput {
	message: string;
	sessionId?: string;
	turnId?: string;
	channelKind?: string;
	authPrincipalId?: string;
	authAuthenticator?: string;
	authAttributes?: Readonly<Record<string, unknown>>;
}

interface RuntimeMemoryCandidate extends RememberMemoryInput {
	confidence: "explicit" | "obvious";
}

const MAX_FACT_CHARS = 220;

export function extractRuntimeMemoryCandidates(input: RuntimeMemoryCaptureInput): RuntimeMemoryCandidate[] {
	const text = input.message.trim();
	if (text.length === 0 || isDiscordPresencePrompt(text)) return [];
	if (isDiscordAuthenticator(input.authAuthenticator)) return extractDiscordInteractionCandidates(text, input);
	return extractMainUserMemoryCandidates(text, runtimeMemorySource(input));
}

export async function rememberRuntimeMessageFacts(input: RuntimeMemoryCaptureInput): Promise<MemoryFact[]> {
	const candidates = extractRuntimeMemoryCandidates(input);
	const saved: MemoryFact[] = [];
	for (const candidate of candidates) {
		const { confidence: _confidence, ...memory } = candidate;
		saved.push(await rememberMemory(memory));
	}
	return saved;
}

export function extractMainUserMemoryCandidates(message: string, source?: string): RuntimeMemoryCandidate[] {
	const text = normalizeUserText(message);
	if (text.length === 0) return [];
	const candidates: RuntimeMemoryCandidate[] = [];
	const preferredName = extractPreferredName(text);
	if (preferredName !== undefined) {
		candidates.push({
			subjectKind: "main_user",
			fact: `The main user wants to be called ${preferredName}.`,
			...(source === undefined ? {} : { source }),
			tags: ["identity", "name"],
			importance: 5,
			confidence: "obvious",
		});
	}
	const declaredName = extractDeclaredName(text);
	if (declaredName !== undefined) {
		candidates.push({
			subjectKind: "main_user",
			fact: `The main user's name is ${declaredName}.`,
			...(source === undefined ? {} : { source }),
			tags: ["identity", "name"],
			importance: 5,
			confidence: "explicit",
		});
	}
	const remembered = extractRememberedFact(text);
	if (remembered !== undefined) {
		const projectFact = rewriteProjectFact(remembered);
		const userFact = projectFact === undefined ? rewriteMainUserFact(remembered) : undefined;
		const fact = projectFact ?? userFact;
		if (fact !== undefined) {
			candidates.push({
				subjectKind: projectFact === undefined ? "main_user" : "project",
				fact,
				...(source === undefined ? {} : { source }),
				tags: ["explicit"],
				importance: 4,
				confidence: "explicit",
			});
		}
	}
	return dedupeCandidates(candidates);
}

function extractDiscordInteractionCandidates(
	message: string,
	input: RuntimeMemoryCaptureInput,
): RuntimeMemoryCandidate[] {
	const attributes = input.authAttributes ?? {};
	const authorId = firstString(
		input.authPrincipalId,
		metadataString(attributes, ["discordUserId", "discord_user_id", "userId", "user_id", "authorId"]),
	);
	if (authorId === undefined) return [];
	const channelId = firstString(metadataString(attributes, ["channel_id", "channelId"])) ?? "discord-interaction";
	const guildId = metadataString(attributes, ["guild_id", "guildId", "serverId"]);
	const authorName = metadataString(attributes, [
		"member_nick",
		"nick",
		"global_name",
		"username",
		"userName",
		"name",
	]);
	const discordMessage: DiscordInboundMessage = {
		externalMessageId: firstString(input.turnId, input.sessionId, Date.now().toString(36)) ?? "discord-interaction",
		channelId,
		...(guildId === undefined ? {} : { guildId }),
		authorId,
		...(authorName === undefined ? {} : { authorName }),
		text: message,
		kind: "channel",
		mentionsSelf: false,
	};
	return extractDiscordMemoryCandidates(discordMessage);
}

function normalizeUserText(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:hey|yo|ok|okay|please|pls)[,\s]+/i, "")
		.replace(/^(?:clanky|clank|clanker)[,\s:]+/i, "")
		.replace(/^(?:please|pls)[,\s]+/i, "")
		.trim();
}

function extractPreferredName(text: string): string | undefined {
	const match = /\b(?:call me|you can call me|please call me)\s+([^.!?\n\r,;:]{1,60})/iu.exec(text);
	return match === null ? undefined : normalizeName(match[1]);
}

function extractDeclaredName(text: string): string | undefined {
	const match = /\bmy name is\s+([^.!?\n\r,;:]{1,60})/iu.exec(text);
	return match === null ? undefined : normalizeName(match[1]);
}

function extractRememberedFact(text: string): string | undefined {
	const match = /\b(?:remember|remember that|please remember|please remember that)\s+(.{3,220})/iu.exec(text);
	if (match === null) return undefined;
	return cleanFact(match[1] ?? "");
}

function rewriteProjectFact(fact: string): string | undefined {
	const normalized = fact.trim();
	const match = /^(?:this|the)\s+project\s+(.{3,180})$/iu.exec(normalized);
	if (match === null) return undefined;
	return sentence(`This project ${match[1] ?? ""}`);
}

function rewriteMainUserFact(fact: string): string | undefined {
	const normalized = fact.trim();
	const rewrites: Array<[RegExp, (match: RegExpExecArray) => string]> = [
		[/^i\s+am\s+(.{2,180})$/iu, (match) => `The main user is ${match[1] ?? ""}`],
		[/^i'm\s+(.{2,180})$/iu, (match) => `The main user is ${match[1] ?? ""}`],
		[/^i\s+like\s+(.{2,180})$/iu, (match) => `The main user likes ${match[1] ?? ""}`],
		[/^i\s+love\s+(.{2,180})$/iu, (match) => `The main user loves ${match[1] ?? ""}`],
		[/^i\s+prefer\s+(.{2,180})$/iu, (match) => `The main user prefers ${match[1] ?? ""}`],
		[/^i\s+use\s+(.{2,180})$/iu, (match) => `The main user uses ${match[1] ?? ""}`],
		[/^my\s+(.{2,180})$/iu, (match) => `The main user's ${match[1] ?? ""}`],
	];
	for (const [pattern, rewrite] of rewrites) {
		const match = pattern.exec(normalized);
		if (match !== null) return sentence(rewrite(match));
	}
	return undefined;
}

function runtimeMemorySource(input: RuntimeMemoryCaptureInput): string | undefined {
	const parts = ["runtime", input.channelKind, input.sessionId, input.turnId].flatMap((part) =>
		part === undefined || part.trim().length === 0 ? [] : [part.trim()],
	);
	return parts.length === 0 ? undefined : parts.join(":");
}

function isDiscordPresencePrompt(text: string): boolean {
	return text.includes("Discord conversation update:") || text.includes("Discord voice conversation update:");
}

function isDiscordAuthenticator(value: string | undefined): boolean {
	return value?.toLowerCase().startsWith("discord") === true;
}

function metadataString(metadata: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = metadataValue(metadata[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function metadataValue(value: unknown): string | undefined {
	const single = typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	if (single !== undefined) return single;
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		if (typeof item === "string" && item.trim().length > 0) return item.trim();
	}
	return undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function normalizeName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = value
		.trim()
		.replace(/\b(?:from now on|please|thanks|thank you)\b.*$/iu, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	if (cleaned.length === 0 || cleaned.length > 40) return undefined;
	if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'’-]*$/u.test(cleaned)) return undefined;
	return cleaned;
}

function cleanFact(value: string): string | undefined {
	const cleaned = value
		.trim()
		.replace(/^that\s+/iu, "")
		.replace(/\s+(?:please|thanks|thank you)$/iu, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	if (cleaned.length < 3 || cleaned.length > MAX_FACT_CHARS) return undefined;
	return cleaned;
}

function sentence(value: string): string | undefined {
	const cleaned = cleanFact(value);
	if (cleaned === undefined) return undefined;
	return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function dedupeCandidates(candidates: readonly RuntimeMemoryCandidate[]): RuntimeMemoryCandidate[] {
	const seen = new Set<string>();
	const out: RuntimeMemoryCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.subjectKind}\0${candidate.subjectId ?? ""}\0${candidate.fact.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}
