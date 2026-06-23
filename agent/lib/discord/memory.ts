import type { DiscordInboundMessage } from "./acceptance.ts";
import { rememberMemory, type RememberMemoryInput, type MemoryFact } from "../memory.ts";

export interface DiscordMemoryCandidate extends RememberMemoryInput {
	confidence: "explicit" | "obvious";
}

const MAX_FACT_CHARS = 220;

export function extractDiscordMemoryCandidates(message: DiscordInboundMessage): DiscordMemoryCandidate[] {
	const text = normalizeDiscordText(message.text);
	if (text.length === 0) return [];
	const source = discordMemorySource(message);
	const userSubject = {
		subjectKind: "discord_user" as const,
		subjectId: message.authorId,
		...(message.authorName === undefined ? {} : { subjectName: message.authorName }),
		source,
	};
	const candidates: DiscordMemoryCandidate[] = [];

	const name = extractPreferredName(text);
	if (name !== undefined) {
		candidates.push({
			...userSubject,
			fact: `This user wants to be called ${name}.`,
			tags: ["identity", "name"],
			importance: 5,
			confidence: "obvious",
		});
	}

	const declaredName = extractDeclaredName(text);
	if (declaredName !== undefined) {
		candidates.push({
			...userSubject,
			fact: `This user's name is ${declaredName}.`,
			tags: ["identity", "name"],
			importance: 5,
			confidence: "explicit",
		});
	}

	const remembered = extractRememberedFact(text);
	if (remembered !== undefined) {
		const serverFact = rewriteServerFact(remembered);
		if (serverFact !== undefined) {
			candidates.push({
				subjectKind: "discord_server",
				...(message.guildId === undefined ? {} : { subjectId: message.guildId }),
				fact: serverFact,
				source,
				tags: ["explicit"],
				importance: 4,
				confidence: "explicit",
			});
		} else {
			const userFact = rewriteUserFact(remembered, message.authorName);
			if (userFact !== undefined) {
				candidates.push({
					...userSubject,
					fact: userFact,
					tags: ["explicit"],
					importance: 4,
					confidence: "explicit",
				});
			}
		}
	}

	return dedupeCandidates(candidates);
}

export async function rememberDiscordMessageFacts(message: DiscordInboundMessage): Promise<MemoryFact[]> {
	const candidates = extractDiscordMemoryCandidates(message);
	const saved: MemoryFact[] = [];
	for (const candidate of candidates) {
		const { confidence: _confidence, ...input } = candidate;
		saved.push(await rememberMemory(input));
	}
	return saved;
}

function normalizeDiscordText(value: string): string {
	return value
		.replace(/<@!?\d+>/g, " ")
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

function rewriteServerFact(fact: string): string | undefined {
	const normalized = fact.trim();
	const serverMatch = /^(?:this|the|our)\s+(?:discord\s+)?server\s+(.{3,180})$/iu.exec(normalized);
	if (serverMatch === null) return undefined;
	return sentence(`This Discord server ${serverMatch[1] ?? ""}`);
}

function rewriteUserFact(fact: string, authorName: string | undefined): string | undefined {
	const normalized = fact.trim();
	const subject = authorName?.trim() || "This user";
	const possessive = subject === "This user" ? "This user's" : `${subject}'s`;
	const firstPersonRewrites: Array<[RegExp, (match: RegExpExecArray) => string]> = [
		[/^i\s+am\s+(.{2,180})$/iu, (match) => `${subject} is ${match[1] ?? ""}`],
		[/^i'm\s+(.{2,180})$/iu, (match) => `${subject} is ${match[1] ?? ""}`],
		[/^i\s+like\s+(.{2,180})$/iu, (match) => `${subject} likes ${match[1] ?? ""}`],
		[/^i\s+love\s+(.{2,180})$/iu, (match) => `${subject} loves ${match[1] ?? ""}`],
		[/^i\s+prefer\s+(.{2,180})$/iu, (match) => `${subject} prefers ${match[1] ?? ""}`],
		[/^i\s+use\s+(.{2,180})$/iu, (match) => `${subject} uses ${match[1] ?? ""}`],
		[/^my\s+(.{2,180})$/iu, (match) => `${possessive} ${match[1] ?? ""}`],
		[/^we\s+(.{2,180})$/iu, (match) => `This group ${match[1] ?? ""}`],
	];
	for (const [pattern, rewrite] of firstPersonRewrites) {
		const match = pattern.exec(normalized);
		if (match !== null) return sentence(rewrite(match));
	}
	return undefined;
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

function discordMemorySource(message: DiscordInboundMessage): string {
	return ["discord", message.guildId ?? "dm", message.channelId, message.externalMessageId].join(":");
}

function dedupeCandidates(candidates: readonly DiscordMemoryCandidate[]): DiscordMemoryCandidate[] {
	const seen = new Set<string>();
	const out: DiscordMemoryCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.subjectKind}\0${candidate.subjectId ?? ""}\0${candidate.fact.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}
