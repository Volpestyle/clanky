export interface ClankyCommandCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface ClankyCommandCompletionSpec {
	value: string;
	description?: string;
	label?: string;
	aliases?: readonly string[];
}

export function completeClankyCommandArgument(
	argumentPrefix: string,
	specs: readonly ClankyCommandCompletionSpec[],
): ClankyCommandCompletion[] | null {
	const query = argumentPrefix.trimStart().toLowerCase();
	const matches = specs.filter((spec) => matchesCompletionSpec(query, spec));
	if (matches.length === 0) return null;
	return matches.map((spec) => {
		const completion: ClankyCommandCompletion = {
			value: spec.value,
			label: spec.label ?? spec.value.trimEnd(),
		};
		if (spec.description !== undefined) completion.description = spec.description;
		return completion;
	});
}

function matchesCompletionSpec(query: string, spec: ClankyCommandCompletionSpec): boolean {
	if (query.length === 0) return true;
	const candidates = [spec.value, spec.label, ...(spec.aliases ?? [])].filter(
		(candidate): candidate is string => candidate !== undefined,
	);
	const queryTokens = splitCompletionTokens(query);
	return candidates.some((candidate) => {
		const normalized = normalizeCompletionCandidate(candidate);
		return normalized.startsWith(query) || completionTokensMatch(splitCompletionTokens(normalized), queryTokens);
	});
}

function normalizeCompletionCandidate(value: string): string {
	return value.trimStart().toLowerCase();
}

function splitCompletionTokens(value: string): string[] {
	return value
		.trim()
		.toLowerCase()
		.split(/[\s-]+/)
		.filter(Boolean);
}

function completionTokensMatch(candidateTokens: readonly string[], queryTokens: readonly string[]): boolean {
	let candidateIndex = 0;
	for (const queryToken of queryTokens) {
		let matched = false;
		for (; candidateIndex < candidateTokens.length; candidateIndex += 1) {
			if (candidateTokens[candidateIndex]?.startsWith(queryToken) === true) {
				matched = true;
				candidateIndex += 1;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}
