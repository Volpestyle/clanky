/**
 * Live Discord voice validation harness.
 *
 * This intentionally is not part of `pnpm smoke`: it needs real Discord and
 * OpenAI credentials and joins the configured Discord voice channel.
 *
 * Run:
 *   CLANKY_DISCORD_VOICE_ENABLED=1 \
 *   CLANKY_DISCORD_VOICE_GUILD_ID=... \
 *   CLANKY_DISCORD_VOICE_CHANNEL_ID=... \
 *   pnpm voice:live
 *
 * OpenAI credentials may come from OPENAI_API_KEY, CLANKY_OPENAI_API_KEY, or
 * a stored /openai-login API key for the active profile.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { resolveOpenAiApiKeySync } from "@clanky/core";
import { resolveAgentDiscordCredentialConfig } from "../src/agentDiscordGateway.ts";
import { createClankyRuntime } from "../src/runClanky.ts";
import {
	describeVoiceLiveValidationRequirements,
	hasVoiceLiveSuccessRequirements,
	hasVoiceLiveValidationRequirements,
	isVoiceLiveValidationSatisfied,
	parseVoiceLiveValidationRequirements,
	requiresNativeDiscordScreenWatch,
	type VoiceLiveValidationRequirements,
	validateVoiceLiveStatus,
} from "../src/voice/liveValidation.ts";
import { writeVoiceLiveValidationResult } from "../src/voice/liveValidationResult.ts";

const DEFAULT_LIVE_MS = 60_000;
const DEFAULT_STATUS_MS = 5_000;

async function main(): Promise<void> {
	const resultPath = process.env.CLANKY_DISCORD_VOICE_RESULT_PATH?.trim();
	const requirements = parseVoiceLiveValidationRequirements(process.env);
	const startedAt = new Date();
	const missing = requiredLiveEnvMissing(process.env);
	if (missing.length > 0) {
		console.error(`voice-live: missing required env: ${missing.join(", ")}`);
		console.error("voice-live: Discord token may be supplied by env or by stored /discord-login credentials.");
		await writeResultIfRequested(resultPath, {
			startedAt,
			finishedAt: new Date(),
			phase: "preflight",
			requirements,
			failures: [`missing required env: ${missing.join(", ")}`],
		});
		process.exitCode = 2;
		return;
	}

	const durationMs = resolveDurationMs(process.env.CLANKY_DISCORD_VOICE_LIVE_MS, DEFAULT_LIVE_MS);
	const statusEveryMs = resolveDurationMs(process.env.CLANKY_DISCORD_VOICE_STATUS_MS, DEFAULT_STATUS_MS);
	const scriptedPrompt = process.env.CLANKY_DISCORD_VOICE_SCRIPTED_PROMPT?.trim();
	const stopWhenValid = parseEnabled(process.env.CLANKY_DISCORD_VOICE_STOP_WHEN_VALID);
	let runtimeState: Awaited<ReturnType<typeof createClankyRuntime>> | undefined;
	let stopStatusPrinter: (() => void) | undefined;
	let resultWritten = false;
	try {
		runtimeState = await createClankyRuntime();
		const { authStorage, gatewayController } = runtimeState;
		const discordCredentials = resolveAgentDiscordCredentialConfig(process.env, authStorage);
		if (discordCredentials === undefined) {
			console.error(
				"voice-live: missing Discord credential. Set CLANKY_DISCORD_TOKEN or run /discord-login for this profile.",
			);
			await writeResultIfRequested(resultPath, {
				startedAt,
				finishedAt: new Date(),
				phase: "preflight",
				requirements,
				failures: ["missing Discord credential"],
			});
			resultWritten = true;
			process.exitCode = 2;
			return;
		}
		const openAiCredential = resolveOpenAiApiKeySync(process.env, authStorage);
		if (openAiCredential === undefined) {
			console.error(
				"voice-live: missing OpenAI credential. Set OPENAI_API_KEY, set CLANKY_OPENAI_API_KEY, or run /openai-login for this profile.",
			);
			await writeResultIfRequested(resultPath, {
				startedAt,
				finishedAt: new Date(),
				phase: "preflight",
				requirements,
				failures: ["missing OpenAI credential"],
			});
			resultWritten = true;
			process.exitCode = 2;
			return;
		}
		if (requiresNativeDiscordScreenWatch(requirements) && discordCredentials.credentialKind !== "user-token") {
			throw new Error(
				"Discord Go Live validation requires CLANKY_DISCORD_CREDENTIAL_KIND=user-token or a stored user-token /discord-login credential.",
			);
		}
		await gatewayController.start();
		const status = gatewayController.status();
		if (status.voiceBridgeActive !== true) {
			throw new Error(`Discord voice bridge did not start: ${JSON.stringify(status)}`);
		}
		console.log("voice-live: started");
		console.log(JSON.stringify(status, null, 2));
		printValidationChecklist(requirements);
		if (scriptedPrompt !== undefined && scriptedPrompt.length > 0) {
			gatewayController.requestVoiceTextUtterance(scriptedPrompt);
			console.log("voice-live: sent scripted Realtime prompt");
		}
		if (stopWhenValid && !hasVoiceLiveSuccessRequirements(requirements)) {
			console.log("voice-live: STOP_WHEN_VALID has no positive validation counters; monitoring full duration");
		}
		stopStatusPrinter = startStatusPrinter(gatewayController, statusEveryMs);
		console.log(
			durationMs === 0
				? "voice-live: running until SIGINT/SIGTERM"
				: `voice-live: holding bridge open for ${durationMs}ms; status every ${statusEveryMs}ms`,
		);
		const waitInput: Parameters<typeof waitForStop>[0] = {
			durationMs,
			status: () => gatewayController.status(),
		};
		if (stopWhenValid) waitInput.requirements = requirements;
		await waitForStop(waitInput);
		const finalStatus = gatewayController.status();
		console.log(`voice-live: final ${JSON.stringify(finalStatus)}`);
		const failures = hasVoiceLiveValidationRequirements(requirements)
			? validateVoiceLiveStatus(finalStatus, requirements)
			: [];
		await writeResultIfRequested(resultPath, {
			startedAt,
			finishedAt: new Date(),
			phase: "final",
			requirements,
			failures,
			status: finalStatus,
		});
		resultWritten = true;
		if (hasVoiceLiveValidationRequirements(requirements)) {
			if (failures.length > 0) throw new Error(`Voice live validation failed: ${failures.join("; ")}`);
			console.log("voice-live: validation PASS");
		}
	} catch (error) {
		if (!resultWritten) {
			await writeResultIfRequested(resultPath, {
				startedAt,
				finishedAt: new Date(),
				phase: "error",
				requirements,
				failures: [errorMessage(error)],
				status: safeGatewayStatus(runtimeState),
				error,
			});
		}
		throw error;
	} finally {
		stopStatusPrinter?.();
		await runtimeState?.gatewayController.stop();
		await runtimeState?.runtime.dispose();
		console.log("voice-live: stopped");
	}
}

function requiredLiveEnvMissing(env: NodeJS.ProcessEnv): string[] {
	const missing: string[] = [];
	if (!parseEnabled(env.CLANKY_DISCORD_VOICE_ENABLED ?? env.CLANKY_DISCORD_VOICE)) {
		missing.push("CLANKY_DISCORD_VOICE_ENABLED=1");
	}
	if ((env.CLANKY_DISCORD_VOICE_GUILD_ID ?? "").trim().length === 0) {
		missing.push("CLANKY_DISCORD_VOICE_GUILD_ID");
	}
	if ((env.CLANKY_DISCORD_VOICE_CHANNEL_ID ?? "").trim().length === 0) {
		missing.push("CLANKY_DISCORD_VOICE_CHANNEL_ID");
	}
	return missing;
}

function parseEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveDurationMs(raw: string | undefined, fallbackMs: number): number {
	if (raw === undefined || raw.trim().length === 0) return fallbackMs;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value < 0) return fallbackMs;
	return value;
}

function startStatusPrinter(input: { status(): unknown }, intervalMs: number): () => void {
	if (intervalMs <= 0) return () => undefined;
	const timer = setInterval(() => {
		console.log(`voice-live: status ${JSON.stringify(input.status())}`);
	}, intervalMs);
	return () => clearInterval(timer);
}

function printValidationChecklist(requirements: ReturnType<typeof parseVoiceLiveValidationRequirements>): void {
	const lines = describeVoiceLiveValidationRequirements(requirements);
	if (lines.length === 0) return;
	console.log("voice-live: validation checklist");
	for (const line of lines) console.log(`voice-live: - ${line}`);
}

async function writeResultIfRequested(
	resultPath: string | undefined,
	input: {
		startedAt: Date;
		finishedAt: Date;
		requirements: VoiceLiveValidationRequirements;
		failures: string[];
		status?: unknown;
		phase?: string;
		error?: unknown;
	},
): Promise<void> {
	if (resultPath === undefined || resultPath.length === 0) return;
	await writeVoiceLiveValidationResult(resultPath, input);
	console.log(`voice-live: wrote result ${resultPath}`);
}

function safeGatewayStatus(runtimeState: Awaited<ReturnType<typeof createClankyRuntime>> | undefined): unknown {
	if (runtimeState === undefined) return undefined;
	try {
		return runtimeState.gatewayController.status();
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function waitForStop(input: {
	durationMs: number;
	status(): unknown;
	requirements?: VoiceLiveValidationRequirements;
}): Promise<void> {
	let resolveStop: (() => void) | undefined;
	const stop = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	let validationTimer: ReturnType<typeof setInterval> | undefined;
	if (input.requirements !== undefined && hasVoiceLiveSuccessRequirements(input.requirements)) {
		const requirements = input.requirements;
		validationTimer = setInterval(() => {
			if (!isVoiceLiveValidationSatisfied(input.status(), requirements)) return;
			console.log("voice-live: validation requirements satisfied; stopping early");
			resolveStop?.();
		}, 500);
	}
	const onSignal = () => resolveStop?.();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		if (input.durationMs === 0) {
			await stop;
			return;
		}
		await Promise.race([sleep(input.durationMs), stop]);
	} finally {
		if (validationTimer !== undefined) clearInterval(validationTimer);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

main().catch((error: unknown) => {
	console.error("voice-live: FAIL");
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
