/**
 * Push watcher (SPEC §4.4). Subscribes to herdr's `pane.agent_status_changed`
 * event stream (all panes) and pushes an APNs alert to every registered device
 * on a transition into a notify-worthy state. The subscription only fires on
 * transitions, so unlike the old poll-and-diff loop there's no "skip the first
 * read" priming and no per-tick `pane.list` traffic.
 *
 * Started lazily on the first device registration (relay `register-push`), so it
 * never runs when no phone is listening. Idempotent. Reconnects with backoff if
 * herdr restarts or the socket drops.
 */
import { apnsConfigured, sendApns } from "./apns.ts";
import { herdrStreamLines } from "./herdr-socket.ts";
import { listPushDevices, unregisterPushDevice } from "./push-registry.ts";

const NOTIFY_STATUSES = new Set(["blocked", "error", "needs-human", "needs_human"]);
const DONE_STATUS = "done";
const STALE_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

interface HerdrPaneLite {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent?: string;
	agent_status?: string;
}

let started = false;

export function ensurePushWatcher(): void {
	if (started) return;
	started = true;
	void runSubscription();
}

/** Hold an `events.subscribe` stream open, reconnecting with backoff. */
async function runSubscription(): Promise<void> {
	let backoffMs = RECONNECT_MIN_MS;
	for (;;) {
		await subscribeOnce(() => {
			backoffMs = RECONNECT_MIN_MS;
		});
		// Stream closed or errored — herdr may be down; wait, then reconnect.
		await delay(backoffMs);
		backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
	}
}

/** Resolves when the subscription stream closes or errors. */
function subscribeOnce(onEvent: () => void): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			stream.close();
			resolve();
		};
		const stream = herdrStreamLines(
			{
				id: `push_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
				method: "events.subscribe",
				params: { subscriptions: [{ type: "pane.agent_status_changed" }] },
			},
			(line) => {
				onEvent();
				const pane = parseStatusEvent(line);
				if (pane && shouldNotify(pane.agent_status ?? "")) {
					void pushForPane(pane, (pane.agent_status ?? "").toLowerCase());
				}
			},
			() => finish(),
			() => finish(),
		);
	});
}

/**
 * Pull pane id + status out of a herdr event line, tolerant of envelope drift
 * (dotted vs underscored event names, flattened vs `data`/`pane`-nested fields).
 */
function parseStatusEvent(line: string): HerdrPaneLite | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const env = (parsed as { params?: unknown })?.params ?? parsed;
	const record = env as Record<string, unknown>;
	const name = String(record?.event ?? record?.type ?? "")
		.toLowerCase()
		.replace(/_/g, ".");
	if (!name.includes("status.changed")) return null;
	const data = ((record?.data as Record<string, unknown>) ?? record) as Record<string, unknown>;
	const nestedPane = data?.pane as Record<string, unknown> | undefined;
	const pane_id = (data?.pane_id ?? nestedPane?.pane_id) as string | undefined;
	const agent_status = (data?.agent_status ?? data?.status ?? nestedPane?.agent_status) as string | undefined;
	if (!pane_id || !agent_status) return null;
	return {
		pane_id,
		agent_status: String(agent_status).toLowerCase(),
		workspace_id: (data?.workspace_id ?? nestedPane?.workspace_id) as string | undefined,
		tab_id: (data?.tab_id ?? nestedPane?.tab_id) as string | undefined,
		agent: (data?.agent ?? nestedPane?.agent) as string | undefined,
	};
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
