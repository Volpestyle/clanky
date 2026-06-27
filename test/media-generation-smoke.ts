// Pure smoke for multi-provider media generation config (no network, no credentials).
// Covers mediaBackendStatus provider reporting, missing-key errors for each generator, and
// xAI/Gemini brain settings resolution. Actual generation is credential-gated and verified
// live. Run: pnpm smoke:media
import { generateGeminiImage, generateXaiImage, generateXaiVideo, mediaBackendStatus } from "../agent/lib/media.ts";
import { createClankyModel, resolveClankyModelSettings } from "../agent/lib/model-selection.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const HOME = { CLANKY_HOME: "/tmp/clanky-media-smoke-home" };

// --- mediaBackendStatus reports each provider from env -------------------------------------
{
	const none = await mediaBackendStatus({ ...HOME });
	check("xaiImages unavailable without key", none.xaiImages !== undefined && (none.xaiImages as { available: boolean }).available === false);
	check("geminiImages unavailable without key", (none.geminiImages as { available: boolean }).available === false);
	check("xaiVideo unavailable without key", (none.xaiVideo as { available: boolean }).available === false);

	const withKeys = await mediaBackendStatus({ ...HOME, CLANKY_XAI_API_KEY: "x", GEMINI_API_KEY: "g" });
	const xi = withKeys.xaiImages as { available: boolean; model: string; outputDir: string };
	const gi = withKeys.geminiImages as { available: boolean; model: string };
	const xv = withKeys.xaiVideo as { available: boolean; model: string };
	check("xaiImages available with CLANKY_XAI_API_KEY", xi.available === true);
	check("xaiImages default model", xi.model === "grok-imagine-image-quality");
	check("xaiImages output dir under CLANKY_HOME", xi.outputDir.includes("/media/xai-images"));
	check("geminiImages available with GEMINI_API_KEY", gi.available === true);
	check("geminiImages default model", gi.model === "gemini-3.1-flash-image");
	check("xaiVideo available with xAI key", xv.available === true && xv.model === "grok-imagine-video");

	const overridden = await mediaBackendStatus({ ...HOME, CLANKY_XAI_API_KEY: "x", CLANKY_XAI_IMAGE_MODEL: "grok-imagine-image-fast" });
	check("xaiImages honors CLANKY_XAI_IMAGE_MODEL", (overridden.xaiImages as { model: string }).model === "grok-imagine-image-fast");
}

// --- missing-key errors are clear and provider-specific ------------------------------------
async function expectThrow(label: string, fn: () => Promise<unknown>, needle: string): Promise<void> {
	try {
		await fn();
		check(label, false);
	} catch (error) {
		check(label, error instanceof Error && error.message.includes(needle));
	}
}
await expectThrow("xai image missing key", () => generateXaiImage({ prompt: "a cat" }, { env: { ...HOME } }), "CLANKY_XAI_API_KEY");
await expectThrow("gemini image missing key", () => generateGeminiImage({ prompt: "a cat" }, { env: { ...HOME } }), "CLANKY_GEMINI_API_KEY");
await expectThrow("xai video missing key", () => generateXaiVideo({ prompt: "a cat" }, { env: { ...HOME } }), "CLANKY_XAI_API_KEY");
await expectThrow("xai image empty prompt", () => generateXaiImage({ prompt: "  " }, { env: { ...HOME, CLANKY_XAI_API_KEY: "x" } }), "prompt must not be empty");

// --- xAI / Gemini brain providers resolve and build (no network) ---------------------------
{
	const xai = resolveClankyModelSettings({ CLANKY_MODEL_PROVIDER: "xai", CLANKY_XAI_API_KEY: "x", CLANKY_XAI_MODEL: "grok-4-fast" });
	check("xai brain settings", xai.provider === "xai" && xai.modelId === "grok-4-fast");
	check("xai brain model builds", createClankyModel(xai) !== undefined);

	const gemini = resolveClankyModelSettings({ CLANKY_MODEL_PROVIDER: "gemini", CLANKY_GEMINI_API_KEY: "g" });
	check("gemini brain default model", gemini.provider === "gemini" && gemini.modelId === "gemini-2.5-pro");
	check("gemini brain model builds", createClankyModel(gemini) !== undefined);

	let threw = false;
	try {
		createClankyModel(resolveClankyModelSettings({ CLANKY_MODEL_PROVIDER: "xai" }));
	} catch {
		threw = true;
	}
	check("xai brain without key throws", threw);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
