import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fcmConfigFromEnv, fcmRequestBody } from "../agent/lib/fcm.ts";
import { listPushDevices, parsePushPlatform, registerPushDevice, type PushDevice } from "../agent/lib/push-registry.ts";
import { sendPushForPane, type PushDeliveryDeps } from "../agent/lib/push-watcher.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const originalClankyHome = process.env.CLANKY_HOME;
const home = await mkdtemp(join(tmpdir(), "clanky-push-"));
process.env.CLANKY_HOME = home;

try {
	assert(parsePushPlatform("IOS") === "ios", "iOS platform parser is case-insensitive");
	assert(parsePushPlatform("android") === "android", "Android platform parser accepts android");
	assert(parsePushPlatform("web") === undefined, "platform parser rejects unsupported platforms");
	assert(parsePushPlatform("") === undefined, "platform parser rejects empty strings");
	assert(parsePushPlatform(123) === undefined, "platform parser rejects non-strings");

	await registerPushDevice({ token: "ios-token", platform: "ios", events: [] });
	await registerPushDevice({ token: "android-token", platform: "android", events: ["done"] });

	const devices = await listPushDevices();
	assert(devices.length === 2, `expected two registered devices, got ${devices.length}`);
	assert(devices.some((device) => device.token === "ios-token" && device.platform === "ios"), "iOS device persisted with platform");
	assert(devices.some((device) => device.token === "android-token" && device.platform === "android"), "Android device persisted with platform");

	const parsedStored = JSON.parse(await readFile(join(home, "push-tokens.json"), "utf8")) as unknown;
	const stored = Array.isArray(parsedStored)
		? parsedStored.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)) as Record<string, unknown>[]
		: [];
	assert(stored.some((device) => device.token === "ios-token" && device.platform === "ios"), "registry JSON includes iOS platform");
	assert(stored.some((device) => device.token === "android-token" && device.platform === "android"), "registry JSON includes Android platform");

	const apnsSent: string[] = [];
	const fcmSent: string[] = [];
	const unregistered: string[] = [];
	const deps: PushDeliveryDeps = {
		listDevices: async () => devices,
		unregisterDevice: async (token, platform) => {
			unregistered.push(`${platform ?? "all"}:${token}`);
		},
		apnsConfigured: () => true,
		fcmConfigured: () => true,
		sendApns: async (token, note) => {
			apnsSent.push(`${token}:${note.data?.status ?? ""}`);
			return { ok: true };
		},
		sendFcm: async (token, note) => {
			fcmSent.push(`${token}:${note.data?.status ?? ""}`);
			return { ok: true };
		},
	};

	await sendPushForPane({ pane_id: "pane-1", workspace_id: "workspace-1", tab_id: "tab-1", agent: "clanky:worker" }, "done", deps);
	assert(apnsSent.join(",") === "ios-token:done", `expected APNs route for iOS token, got ${apnsSent.join(",")}`);
	assert(fcmSent.join(",") === "android-token:done", `expected FCM route for Android token, got ${fcmSent.join(",")}`);

	apnsSent.length = 0;
	fcmSent.length = 0;
	await sendPushForPane({ pane_id: "pane-1", agent: "clanky:worker" }, "blocked", deps);
	assert(apnsSent.join(",") === "ios-token:blocked", "iOS default event set should receive blocked status");
	assert(fcmSent.length === 0, "Android device with events=[done] should not receive blocked status");

	const staleAndroid: PushDevice = { token: "stale-android", platform: "android", events: [], registeredAt: new Date().toISOString() };
	const staleDeps: PushDeliveryDeps = {
		...deps,
		listDevices: async () => [staleAndroid],
		sendFcm: async () => ({ ok: false, reason: "UNREGISTERED" }),
	};
	await sendPushForPane({ pane_id: "pane-2", agent: "clanky:worker" }, "done", staleDeps);
	assert(unregistered.includes("android:stale-android"), "UNREGISTERED FCM tokens should be removed for Android only");

	const body = fcmRequestBody("fcm-token", {
		title: "Clanky test",
		body: "Push notifications are wired.",
		collapseId: "x".repeat(80),
		data: { status: "done", count: 2, nested: { ok: true } },
	});
	assert(body.message.token === "fcm-token", "FCM body targets the registration token");
	assert(body.message.notification.title === "Clanky test", "FCM body carries notification title");
	assert(body.message.android.priority === "HIGH", "FCM Android priority is high");
	assert(body.message.android.collapse_key?.length === 64, "FCM collapse key is capped at 64 chars");
	assert(body.message.android.notification.channel_id === "clanky_status", "FCM body uses the Clanky Android notification channel");
	assert(body.message.data?.status === "done", "FCM data payload includes status");
	assert(body.message.data?.count === "2", "FCM data payload stringifies numbers");
	assert(body.message.data?.nested === "{\"ok\":true}", "FCM data payload JSON-stringifies objects");

	const fcmConfig = fcmConfigFromEnv({
		CLANKY_FCM_PROJECT_ID: "clanky-android",
		CLANKY_FCM_CLIENT_EMAIL: "sender@clanky-android.iam.gserviceaccount.com",
		CLANKY_FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
	});
	assert(fcmConfig !== undefined && fcmConfig.projectId === "clanky-android", "FCM config reads env project id");
	assert(fcmConfig.privateKey.includes("\nabc\n"), "FCM config normalizes escaped private key newlines");

	console.log("push routing smoke: OK");
} finally {
	if (originalClankyHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = originalClankyHome;
	await rm(home, { recursive: true, force: true });
}
