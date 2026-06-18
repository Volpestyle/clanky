// Live smoke for the eve relay channel against a running eve server + herdr.
// Verifies bearer auth (good + bad token) and a proxied herdr `list` op.
const PORT = process.env.PORT ?? "8787";
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

// 1) good token -> ready -> list op returns herdr agent list
const good = await once(`ws://127.0.0.1:${PORT}/relay/ws?token=${TOKEN}`, (ws) => {
	ws.send(JSON.stringify({ id: 1, op: "list" }));
});
const listOk = !!good.msg && (good.msg as { ok?: boolean }).ok === true;
const agents = listOk ? JSON.stringify((good.msg as { result?: unknown }).result).includes("agent") : false;
console.log(`auth+list: ${listOk ? "OK" : "FAIL"}  (agents in result: ${agents})`);

// 2) bad token -> closed 4401
const bad = await once(`ws://127.0.0.1:${PORT}/relay/ws?token=wrong`);
const rejected = bad.closed === 4401;
console.log(`bad token rejected (4401): ${rejected ? "OK" : `FAIL (${JSON.stringify(bad)})`}`);

process.exit(listOk && rejected ? 0 : 1);
