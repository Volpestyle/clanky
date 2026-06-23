// Live smoke for the voice channel control surface: bearer auth + status op.
// (delegate->pane uses the same herdr seam already covered by herdr-spawn-smoke;
// join needs a Discord-connected runtime, so it is not exercised here.)
const PORT = process.env.PORT ?? "8788";
const TOKEN = process.env.CLANKY_RELAY_TOKEN ?? "relay-test";

function once(url: string, onReady?: (ws: WebSocket) => void): Promise<{ closed?: number; msg?: unknown }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		const timer = setTimeout(() => {
			try {
				ws.close();
			} catch {}
			resolve({});
		}, 8000);
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String((ev as MessageEvent).data));
			if (msg.type === "ready") {
				onReady?.(ws);
				return;
			}
			clearTimeout(timer);
			ws.close();
			resolve({ msg });
		});
		ws.addEventListener("close", (ev) => {
			clearTimeout(timer);
			resolve({ closed: (ev as CloseEvent).code });
		});
		ws.addEventListener("error", () => {});
	});
}

const good = await once(`ws://127.0.0.1:${PORT}/voice/ws?token=${TOKEN}`, (ws) => {
	ws.send(JSON.stringify({ id: 1, op: "status" }));
});
const statusOk =
	!!good.msg &&
	(good.msg as { ok?: boolean }).ok === true &&
	(good.msg as { result?: { runtimeAttached?: boolean } }).result?.runtimeAttached === false;
console.log(`auth+status: ${statusOk ? "OK" : `FAIL (${JSON.stringify(good.msg)})`}`);

const bad = await once(`ws://127.0.0.1:${PORT}/voice/ws?token=wrong`);
const rejected = bad.closed === 4401;
console.log(`bad token rejected (4401): ${rejected ? "OK" : `FAIL (${JSON.stringify(bad)})`}`);

process.exit(statusOk && rejected ? 0 : 1);
