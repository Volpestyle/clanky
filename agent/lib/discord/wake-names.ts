/**
 * Wake-name matching for Clanky's free-will Discord presence (SPEC.md §5.2).
 *
 * Pure, credential-free logic that answers two questions about a message's text:
 *   - addressed: is Clanky being talked *to* ("hey clanky", "clank, ...")?
 *   - mentioned: is his name merely present ("did clanky ship it")?
 * The acceptance gate (acceptance.ts) turns those into a respond/ignore call.
 */

/** Misspellings and phonetic variants people use to address Clanky in chat/VC. */
export const DEFAULT_DISCORD_WAKE_NAMES = [
	"clanky",
	"clank",
	"blankie",
	"clanka",
	"clanker",
	"clankerconk",
	"clankey",
	"clankie",
	"clay",
	"clayton",
	"clenk",
	"clenka",
	"clenker",
	"click",
	"clickink",
	"clink",
	"clinka",
	"clinker",
	"clinkeroni",
	"clinkerton",
	"clinkie",
	"clinky",
	"clint",
	"clinic",
	"clonk",
	"clonker",
	"clonky",
	"clunk",
	"clunka",
	"clunky",
	"coinker",
	"crank",
	"cranker",
	"crankey",
	"cranky",
	"craigey",
	"craigy",
	"flakey",
	"flanker",
	"flankey",
	"frankie",
	"hank",
	"hanker",
	"hankie",
	"hanky",
	"kanky",
	"klanker",
	"klang",
	"klien",
	"klink",
	"klinker",
	"klinkie",
	"klinky",
	"klinky conk",
	"link",
	"plank",
	"planker",
	"planka",
	"plinker",
	"plinky",
	"plakey",
	"plakie",
	"oinky",
	"plankey",
	"planky",
	"plonka",
	"quaker",
	"quakie",
] as const;

const PRIMARY_WAKE_TOKEN_MIN_LEN = 4;
const EN_WAKE_PRIMARY_GENERIC_TOKENS = new Set(["bot", "ai", "assistant"]);
const LEADING_WAKE_PREFIX_TOKENS = new Set([
	"yo",
	"hey",
	"hi",
	"hello",
	"sup",
	"ay",
	"ayy",
	"oi",
	"ok",
	"okay",
	"alright",
	"please",
]);

export interface WakeNameMatch {
	/** Talked *to* Clanky: leading or vocative use of a wake name. */
	addressed: boolean;
	/** Name appears at all (a superset of `addressed`). */
	mentioned: boolean;
}

export function parseDiscordWakeNames(value: string | undefined): string[] {
	const normalized = value?.trim();
	if (normalized === undefined || normalized.length === 0) return [];
	const parts = normalized.includes(",") ? normalized.split(",") : normalized.split(/\s+/);
	return dedupeWakeNames(parts);
}

export function parseDiscordWakeNamesFromEnv(env: NodeJS.ProcessEnv): string[] {
	return dedupeWakeNames([
		...parseDiscordWakeNames(env.CLANKY_DISCORD_WAKE_NAMES),
		...parseDiscordWakeNames(env.CLANKY_DISCORD_VOICE_WAKE_NAMES),
	]);
}

/** Default names plus any configured aliases, deduped. */
export function resolveWakeNames(env: NodeJS.ProcessEnv): string[] {
	return dedupeWakeNames([...DEFAULT_DISCORD_WAKE_NAMES, ...parseDiscordWakeNamesFromEnv(env)]);
}

export function dedupeWakeNames(values: readonly (string | undefined)[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value?.replace(/\s+/g, " ").trim();
		const key = normalizeWakeText(normalized ?? "");
		if (normalized === undefined || normalized.length === 0 || key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		out.push(normalized);
	}
	return out;
}

export function resolveWakeNameMatch(text: string, wakeNames: readonly string[]): WakeNameMatch {
	const names = dedupeWakeNames(wakeNames);
	for (const name of names) {
		if (isBotNameAddressed(text, name)) return { addressed: true, mentioned: true };
		if (containsWakeNameMention(text, name)) return { addressed: false, mentioned: true };
	}
	return { addressed: false, mentioned: false };
}

function isBotNameAddressed(transcript: string, botName: string): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;
	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (botTokens.length === 1) {
		return hasSingleTokenWakeAddress(transcript, transcriptTokens, botTokens[0] ?? "");
	}
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;
	const primaryWakeToken = resolvePrimaryWakeToken(botTokens);
	if (primaryWakeToken === null) return false;
	return hasSingleTokenWakeAddress(transcript, transcriptTokens, primaryWakeToken);
}

function containsWakeNameMention(transcript: string, botName: string): boolean {
	const transcriptTokens = tokenizeWakeTokens(transcript);
	if (transcriptTokens.length === 0) return false;
	const botTokens = tokenizeWakeTokens(botName);
	if (botTokens.length === 0) return false;
	if (containsTokenSequence(transcriptTokens, botTokens)) return true;
	const mergedWakeToken = resolveMergedWakeToken(botTokens);
	if (mergedWakeToken !== null && transcriptTokens.some((token) => token === mergedWakeToken)) return true;
	if (botTokens.length === 1) {
		const token = botTokens[0] ?? "";
		return (
			token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN &&
			!EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token) &&
			transcriptTokens.some((candidate) => candidate === token)
		);
	}
	return false;
}

function tokenizeWakeTokens(value: string): string[] {
	const normalized = normalizeWakeText(value);
	const matches = normalized.match(/[\p{L}\p{N}]+/gu);
	return Array.isArray(matches) ? matches : [];
}

function normalizeWakeText(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "");
}

function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
	if (tokens.length === 0 || sequence.length === 0 || sequence.length > tokens.length) return false;
	for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
		let matched = true;
		for (let index = 0; index < sequence.length; index += 1) {
			if (tokens[start + index] !== sequence[index]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

function resolvePrimaryWakeToken(botTokens: string[]): string | null {
	const candidates = botTokens.filter((token) => token.length >= PRIMARY_WAKE_TOKEN_MIN_LEN);
	if (candidates.length === 0) return null;
	const preferred = candidates.find((token) => !EN_WAKE_PRIMARY_GENERIC_TOKENS.has(token));
	return preferred ?? candidates[0] ?? null;
}

function resolveMergedWakeToken(botTokens: string[]): string | null {
	if (botTokens.length < 2) return null;
	const merged = botTokens.join("");
	return merged.length >= PRIMARY_WAKE_TOKEN_MIN_LEN ? merged : null;
}

function hasSingleTokenWakeAddress(transcript: string, transcriptTokens: string[], wakeToken: string): boolean {
	const normalizedWakeToken = wakeToken.trim().toLowerCase();
	if (normalizedWakeToken.length === 0) return false;
	if (hasLeadingWakeToken(transcriptTokens, normalizedWakeToken)) return true;
	return hasVocativeWakeToken(transcript, normalizedWakeToken);
}

function hasLeadingWakeToken(tokens: string[], wakeToken: string): boolean {
	if (tokens.length === 0 || wakeToken.length === 0) return false;
	let index = 0;
	while (index < tokens.length && LEADING_WAKE_PREFIX_TOKENS.has(tokens[index] ?? "")) {
		index += 1;
	}
	return tokens[index] === wakeToken;
}

function hasVocativeWakeToken(transcript: string, wakeToken: string): boolean {
	const normalizedTranscript = normalizeWakeText(transcript);
	if (normalizedTranscript.length === 0 || wakeToken.length === 0) return false;
	const escapedWakeToken = escapeRegex(wakeToken);
	return new RegExp(`[,;:.!?]\\s*${escapedWakeToken}(?:\\b|')`, "u").test(normalizedTranscript);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
