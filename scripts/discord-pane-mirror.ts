/**
 * Pane mirror for a Clanky presence session (SPEC.md §5.6).
 *
 * Runs as a herdr pane (clanky:discord-chat / clanky:voice) and tails an eve
 * session's NDJSON event stream, rendering reasoning, tool calls, and messages
 * so a session-only "Discord subagent" is fully watchable on the stage. It is a
 * read-only viewer; it never drives the session.
 *
 * Usage: node scripts/discord-pane-mirror.ts <eveHost> <sessionId> [label]
 */
const [, , eveHost, sessionId, label = "discord"] = process.argv;

if (eveHost === undefined || sessionId === undefined) {
	console.error("usage: discord-pane-mirror <eveHost> <sessionId> [label]");
	process.exit(2);
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function line(color: string, glyph: string, text: string): void {
	console.log(`${color}${glyph}${RESET} ${text}`);
}

interface StreamEvent {
	type: string;
	data?: Record<string, unknown>;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function render(event: StreamEvent): void {
	const data = event.data ?? {};
	switch (event.type) {
		case "session.started":
			line(DIM, "•", `session ${str(data.sessionId) || sessionId} started`);
			break;
		case "turn.started":
			line(CYAN, "▸", "turn started");
			break;
		case "message.received":
			line(CYAN, "‹", str(data.message) || "(inbound)");
			break;
		case "reasoning.completed":
			line(DIM, "✻", `${DIM}${str(data.text)}${RESET}`);
			break;
		case "actions.requested": {
			const actions = Array.isArray(data.actions) ? data.actions : [];
			line(YELLOW, "⚙", `tool calls: ${actions.length}`);
			break;
		}
		case "action.result": {
			const name = str(data.toolName) || "tool";
			const failed = data.isError === true;
			line(failed ? RED : GREEN, failed ? "✗" : "✓", `${name}${failed ? " (error)" : ""}`);
			break;
		}
		case "message.completed": {
			const text = str(data.message);
			if (text.length > 0) line(GREEN, "›", text);
			break;
		}
		case "turn.failed":
		case "session.failed":
		case "step.failed":
			line(RED, "✗", `${event.type}: ${str(data.message)}`);
			break;
		case "session.waiting":
			line(DIM, "…", "waiting for next message");
			break;
		default:
			break;
	}
}

async function main(): Promise<void> {
	const url = `${eveHost.replace(/\/$/, "")}/eve/v1/session/${sessionId}/stream`;
	line(DIM, "◆", `mirroring ${label} session ${sessionId}`);
	// Reconnect loop: the stream is durable and replayable by event index.
	let startIndex = 0;
	for (;;) {
		try {
			const response = await fetch(`${url}?startIndex=${startIndex}`, { headers: { accept: "application/x-ndjson" } });
			if (!response.ok || response.body === null) {
				throw new Error(`stream HTTP ${response.status}`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const raw = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (raw.length === 0) continue;
					startIndex += 1;
					try {
						render(JSON.parse(raw) as StreamEvent);
					} catch {
						// ignore non-JSON keepalive lines
					}
				}
			}
		} catch (error) {
			line(RED, "✗", `stream dropped: ${(error as Error).message}; retrying`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

void main();
