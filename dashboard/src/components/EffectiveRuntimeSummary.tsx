import { AGENT_STACK_PRESET_OPTIONS } from "../../../src/settings/agentStackCatalog.ts";
import { getEffectiveBrowserRuntime } from "../settingsFormModel";

function RuntimeCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="ers-cell">
      <span className="ers-label">{label}</span>
      <span className={`ers-value${accent ? " ers-value-accent" : ""}`}>{value}</span>
    </div>
  );
}

function formatProviderModel(provider: string, model: string, fallback = "\u2014") {
  const p = String(provider || "").trim();
  const m = String(model || "").trim();
  if (p && m) return `${p} / ${m}`;
  if (p) return p;
  if (m) return m;
  return fallback;
}

function formatVoicePath(form: Record<string, unknown>): string {
  if (!form.voiceEnabled) return "Disabled";
  const provider = String(form.voiceProvider || "").trim();
  const replyPath = String(form.voiceReplyPath || "brain").trim();
  const ttsMode = replyPath === "brain" ? String(form.voiceTtsMode || "realtime").trim() : "";

  const providerLabel =
    provider === "xai" ? "xAI" :
    provider === "openai" ? "OpenAI" :
    provider === "gemini" ? "Gemini" :
    provider === "elevenlabs" ? "ElevenLabs" :
    provider || "Unknown";

  const pathLabel =
    replyPath === "native" ? "Native" :
    replyPath === "bridge" ? "Bridge" :
    replyPath === "brain" ? "Full Brain" :
    replyPath;

  const ttsLabel =
    replyPath === "brain" ? (ttsMode === "api" ? "API TTS" : "Realtime TTS") : "";

  return [providerLabel, pathLabel, ttsLabel].filter(Boolean).join(" \u2192 ");
}

export function EffectiveRuntimeSummary({ form }: { form: Record<string, unknown> }) {
  const presetLabel = AGENT_STACK_PRESET_OPTIONS.find(
    (p) => p.value === form.stackPreset
  )?.label || String(form.stackPreset || "");
  const browserRuntime = getEffectiveBrowserRuntime(form);

  const voiceEnabled = Boolean(form.voiceEnabled);
  const musicBrainOff = String(form.voiceMusicBrainMode || "disabled").trim() === "disabled";

  return (
    <div className="ers-card">
      <div className="ers-header">
        <span className="ers-title">Effective Runtime</span>
        <span className="ers-preset-badge">{presetLabel}</span>
      </div>
      <div className="ers-grid">
        <RuntimeCell
          label="Text Brain"
          value={formatProviderModel(form.provider as string, form.model as string)}
          accent
        />
        <RuntimeCell
          label="Voice Path"
          value={formatVoicePath(form)}
        />
        <RuntimeCell
          label="Research"
          value={String(form.stackResolvedResearchRuntime || "\u2014").replace(/_/g, " ")}
        />
        <RuntimeCell
          label="Browser"
          value={String(browserRuntime || "\u2014").replace(/_/g, " ")}
        />
        {voiceEnabled && (
          <RuntimeCell
            label="Voice Generation"
            value={
              form.voiceGenerationLlmUseTextModel
                ? formatProviderModel(form.provider as string, form.model as string) + " (text)"
                : formatProviderModel(
                    form.voiceGenerationLlmProvider as string,
                    form.voiceGenerationLlmModel as string
                  )
            }
          />
        )}
        {voiceEnabled && (
          <RuntimeCell
            label="Music Brain"
            value={
              musicBrainOff
                ? "Off"
                : formatProviderModel(
                    form.voiceMusicBrainLlmProvider as string,
                    form.voiceMusicBrainLlmModel as string
                  )
            }
          />
        )}
      </div>
    </div>
  );
}
