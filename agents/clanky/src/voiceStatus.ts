export type VoiceStatusState =
	| { kind: "unavailable" }
	| { kind: "error"; message: string }
	| { kind: "ready" }
	| { kind: "live"; channelId: string | undefined }
	| { kind: "client-live" }
	| { kind: "inactive" };

export function interpretVoiceStatus(status: unknown): VoiceStatusState {
	if (!isRecord(status)) return { kind: "unavailable" };
	const voiceConfigError = readStatusString(status, "voiceConfigError");
	if (voiceConfigError !== undefined) return { kind: "error", message: voiceConfigError };
	const voice = readStatusRecord(status, "voice");
	if (readStatusBoolean(status, "voiceBridgeActive") === true) {
		if (
			voice !== undefined &&
			readStatusBoolean(voice, "active") === false &&
			readStatusString(voice, "mode") === "dynamic"
		) {
			return { kind: "ready" };
		}
		const channelId = voice === undefined ? undefined : readStatusString(voice, "channelId");
		return { kind: "live", channelId };
	}
	if (readStatusBoolean(status, "voiceOnlyClientActive") === true) return { kind: "client-live" };
	if (
		voice !== undefined &&
		readStatusBoolean(voice, "enabled") === true &&
		readStatusBoolean(voice, "active") === false
	) {
		return { kind: "ready" };
	}
	return { kind: "inactive" };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStatusRecord(record: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(record)) return undefined;
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

export function readStatusString(record: unknown, key: string): string | undefined {
	if (!isRecord(record)) return undefined;
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readStatusBoolean(record: unknown, key: string): boolean | undefined {
	if (!isRecord(record)) return undefined;
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}
