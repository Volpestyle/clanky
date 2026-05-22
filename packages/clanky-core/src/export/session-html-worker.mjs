import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("Session HTML worker requires a parent port");

parentPort.on("message", (message) => {
	if (!isSessionHtmlRequest(message)) {
		return;
	}
	try {
		parentPort.postMessage({
			id: message.id,
			ok: true,
			html: sessionHtml(message.input.sessionId, message.input.content, sessionTextMetrics(message.input.content)),
		});
	} catch (error) {
		parentPort.postMessage({
			id: message.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

function isSessionHtmlRequest(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"input" in value &&
		Number.isInteger(value.id) &&
		value.id > 0 &&
		isSessionHtmlInput(value.input)
	);
}

function isSessionHtmlInput(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		"sessionId" in value &&
		"content" in value &&
		typeof value.sessionId === "string" &&
		typeof value.content === "string"
	);
}

function sessionTextMetrics(content) {
	const characters = content.length;
	const lines = content.length === 0 ? 0 : content.split("\n").length;
	const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/u).length;
	const estimatedTokens = estimateTokens(content);
	return { characters, lines, words, estimatedTokens };
}

function estimateTokens(content) {
	const normalized = content.trim();
	if (normalized.length === 0) return 0;
	const asciiWords = normalized.match(/[A-Za-z0-9_]+/gu)?.length ?? 0;
	const nonWhitespaceChars = normalized.replace(/\s/gu, "").length;
	return Math.max(1, Math.ceil(Math.max(nonWhitespaceChars / 4, asciiWords * 1.25)));
}

function sessionHtml(sessionId, content, metrics) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Clanky Session ${escapeHtml(sessionId)}</title>
<style>
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; line-height: 1.45; }
dl { display: grid; grid-template-columns: max-content max-content; gap: 0.25rem 1rem; }
pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<h1>Clanky Session ${escapeHtml(sessionId)}</h1>
<dl aria-label="Session metrics">
<dt>Characters</dt><dd>${metrics.characters}</dd>
<dt>Lines</dt><dd>${metrics.lines}</dd>
<dt>Words</dt><dd>${metrics.words}</dd>
<dt>Estimated tokens</dt><dd>${metrics.estimatedTokens}</dd>
</dl>
<pre>${escapeHtml(content)}</pre>
</body>
</html>
`;
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
