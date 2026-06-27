/**
 * Push watcher (SPEC §4.4). herdr's agent-status subscription is per-pane, so
 * rather than juggle a subscription per pane we poll `pane.list` and diff each
 * pane's agent_status. On a transition into a notify-worthy state we push an
 * APNs alert to every registered device. Push latency of a few seconds is fine
 * for "agent blocked / done".
 *
 * Started lazily on the first device registration (relay `register-push`), so it
 * never runs when no phone is listening. Idempotent.
 */
import { apnsConfigured, sendApns } from "./apns.ts";
import { herdrRequest } from "./herdr-socket.ts";
import { listPushDevices, unregisterPushDevice } from "./push-registry.ts";

const POLL_MS = 5000;
const NOTIFY_STATUSES = new Set(["blocked", "error", "needs-human", "needs_human"]);
const DONE_STATUS = "done";
const STALE_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

interface HerdrPaneLite {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent?: string;
	agent_status?: string;
}

let started = false;
const lastStatus = new Map<string, string>();

export function ensurePushWatcher(): void {
	if (started) return;
	started = true;
	void loop();
}

async function loop(): Promise<void> {
	let primed = false;
	for (;;) {
		try {
			const result = await herdrRequest("pane.list");
			const panes = ((result as { panes?: HerdrPaneLite[] })?.panes ?? []) as HerdrPaneLite[];
			for (const pane of panes) {
				const status = (pane.agent_status ?? "").toLowerCase();
				const previous = lastStatus.get(pane.pane_id);
				lastStatus.set(pane.pane_id, status);
				// Skip the first poll so we don't alert for panes already blocked/done.
				if (primed && status !== previous && shouldNotify(status)) {
					await pushForPane(pane, status);
				}
			}
			const live = new Set(panes.map((pane) => pane.pane_id));
			for (const id of [...lastStatus.keys()]) {
				if (!live.has(id)) lastStatus.delete(id);
			}
			primed = true;
		} catch {
			// herdr unreachable (session down) — keep polling, it may come back.
		}
		await delay(POLL_MS);
	}
}

function shouldNotify(status: string): boolean {
	return status === DONE_STATUS || NOTIFY_STATUSES.has(status);
}

async function pushForPane(pane: HerdrPaneLite, status: string): Promise<void> {
	if (!apnsConfigured()) return;
	const devices = await listPushDevices();
	if (devices.length === 0) return;

	const name = pane.agent ?? pane.pane_id;
	const note = {
		title: `Clanky · ${name}`,
		body: statusBody(status, name),
		collapseId: `${pane.pane_id}:${status}`,
		data: {
			pane_id: pane.pane_id,
			workspace_id: pane.workspace_id ?? "",
			tab_id: pane.tab_id ?? "",
			agent: name,
			status,
		},
	};

	for (const device of devices) {
		if (device.events.length > 0 && !device.events.includes(status)) continue;
		const result = await sendApns(device.token, note);
		if (!result.ok && result.reason && STALE_TOKEN_REASONS.has(result.reason)) {
			await unregisterPushDevice(device.token);
		}
	}
}

function statusBody(status: string, name: string): string {
	switch (status) {
		case "blocked":
			return `${name} is blocked and needs you.`;
		case "done":
			return `${name} finished its work.`;
		case "error":
			return `${name} hit an error.`;
		default:
			return `${name} needs attention (${status}).`;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
