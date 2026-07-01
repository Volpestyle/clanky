/**
 * Push watcher (SPEC §4.4). herdr's agent-status subscription is per-pane, so
 * rather than juggle a subscription per pane we poll `pane.list` and diff each
 * pane's agent_status. On a transition into a notify-worthy state we route a
 * platform push to every registered device. Push latency of a few seconds is
 * fine for "agent blocked / done".
 *
 * Started lazily on the first device registration (relay `register-push`), so it
 * never runs when no phone is listening, and at brain boot when the registry
 * already has devices (agent/channels/eve.ts calls ensurePushWatcherIfRegistered,
 * so a restart does not silence pushes until the phone re-registers). Idempotent.
 */
import { apnsConfigured, sendApns, type ApnsNotification, type ApnsResult } from "./apns.ts";
import { fcmConfigured, isStaleFcmTokenReason, sendFcm, type FcmResult } from "./fcm.ts";
import { herdrRequest } from "./herdr-socket.ts";
import { listPushDevices, type PushDevice, type PushPlatform, unregisterPushDevice } from "./push-registry.ts";

const POLL_MS = 5000;
const NOTIFY_STATUSES = new Set(["blocked", "error", "needs-human", "needs_human"]);
const DONE_STATUS = "done";
const STALE_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export interface HerdrPaneLite {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent?: string;
	agent_status?: string;
}

export interface PushDeliveryDeps {
	listDevices(): Promise<PushDevice[]>;
	unregisterDevice(token: string, platform?: PushPlatform): Promise<void>;
	apnsConfigured(): boolean;
	fcmConfigured(): boolean;
	sendApns(token: string, note: ApnsNotification): Promise<ApnsResult>;
	sendFcm(token: string, note: ApnsNotification): Promise<FcmResult>;
}

const defaultPushDeliveryDeps: PushDeliveryDeps = {
	listDevices: listPushDevices,
	unregisterDevice: unregisterPushDevice,
	apnsConfigured,
	fcmConfigured,
	sendApns,
	sendFcm,
};

let started = false;
const lastStatus = new Map<string, string>();

export function ensurePushWatcher(): void {
	if (started) return;
	started = true;
	void loop();
}

/**
 * Boot-time start: begins polling only when devices are already registered,
 * so an idle brain with no paired phone never runs the loop. Idempotent and
 * safe alongside relay's lazy ensurePushWatcher() on register-push.
 */
export async function ensurePushWatcherIfRegistered(): Promise<void> {
	if (started) return;
	try {
		const devices = await listPushDevices();
		if (devices.length > 0) ensurePushWatcher();
	} catch (error) {
		console.error("push watcher boot check failed:", error);
	}
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
					await sendPushForPane(pane, status);
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

export async function sendPushForPane(pane: HerdrPaneLite, status: string, deps: PushDeliveryDeps = defaultPushDeliveryDeps): Promise<void> {
	const apnsReady = deps.apnsConfigured();
	const fcmReady = deps.fcmConfigured();
	if (!apnsReady && !fcmReady) return;
	const devices = await deps.listDevices();
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

	// Fan out per-device so one slow device or hung stream cannot block the
	// others (each sender also carries its own deadline).
	const sends = devices
		.filter((device) => device.events.length === 0 || device.events.includes(status))
		.map((device) => sendToDevice(device, note, apnsReady, fcmReady, deps));
	for (const result of await Promise.allSettled(sends)) {
		if (result.status === "rejected") console.error("push send failed:", result.reason);
	}
}

async function sendToDevice(device: PushDevice, note: ApnsNotification, apnsReady: boolean, fcmReady: boolean, deps: PushDeliveryDeps): Promise<void> {
	if (device.platform === "ios") {
		if (!apnsReady) return;
		const result = await deps.sendApns(device.token, note);
		if (!result.ok && result.reason !== undefined && STALE_TOKEN_REASONS.has(result.reason)) {
			await deps.unregisterDevice(device.token, device.platform);
		}
		return;
	}
	if (!fcmReady) return;
	const result = await deps.sendFcm(device.token, note);
	if (!result.ok && result.reason !== undefined && isStaleFcmTokenReason(result.reason)) {
		await deps.unregisterDevice(device.token, device.platform);
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
