export const DEFAULT_DISCORD_WAKE_NAMES = [
	"clanky",
	"clank",
	"blankie",
	"clanka",
	"clanker",
	"clankerconk",
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

export function dedupeWakeNames(values: readonly (string | undefined)[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value?.replace(/\s+/g, " ").trim();
		const key = normalizeWakeNameKey(normalized);
		if (normalized === undefined || normalized.length === 0 || key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		out.push(normalized);
	}
	return out;
}

function normalizeWakeNameKey(value = ""): string {
	return value
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "");
}
