const TOKEN_FLOW_RE =
	/(↑\s+([0-9]+(?:\.[0-9]+)?[KM]?)\s+↓\s+[0-9]+(?:\.[0-9]+)?[KM]?)(?![0-9A-Za-z.])(?!\s+(?:ctx\s+)?[\d,]+%)/gu;
const BARE_TOKEN_FLOW_PERCENT_RE =
	/(↑\s+[0-9]+(?:\.[0-9]+)?[KM]?\s+↓\s+[0-9]+(?:\.[0-9]+)?[KM]?)(?![0-9A-Za-z.])\s+([\d,]+%)(?![0-9A-Za-z%])/gu;

export function appendContextUsagePercent(text: string, contextSize: number | undefined): string {
	const withBarePercentLabeled = text.replace(BARE_TOKEN_FLOW_PERCENT_RE, "$1 ctx $2");
	if (contextSize === undefined || !Number.isFinite(contextSize) || contextSize <= 0) return withBarePercentLabeled;
	const withTokenPercent = withBarePercentLabeled.replace(TOKEN_FLOW_RE, (match: string, flow: string, inputText: string) => {
		const inputTokens = parseCompactTokenCount(inputText);
		if (inputTokens === undefined) return match;
		const percent = Math.round((inputTokens / contextSize) * 100).toLocaleString();
		return `${flow} ctx ${percent}%`;
	});
	return appendZeroContextUsagePercent(withTokenPercent);
}

function parseCompactTokenCount(value: string): number | undefined {
	const match = /^([0-9]+(?:\.[0-9]+)?)([KM]?)$/iu.exec(value);
	if (match === null) return undefined;
	const amount = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(amount)) return undefined;
	const suffix = match[2]?.toUpperCase();
	const multiplier = suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
	return Math.round(amount * multiplier);
}

function appendZeroContextUsagePercent(text: string): string {
	return text
		.split(/(\r?\n)/u)
		.map((line) => {
			if (line.includes("↑") || /\bctx\s+[\d,]+%/u.test(line)) return line;
			if (line.includes("ctx ") && line.includes("External endpoint")) {
				return line.replace("External endpoint", "ctx 0%  ·  External endpoint");
			}
			return line.replace(
				/(\bctx\s+[0-9]+(?:\.[0-9]+)?[KM](?:\s+\([^)]+\))?)(\s+·\s+)/u,
				"$1$2ctx 0%$2",
			);
		})
		.join("");
}
