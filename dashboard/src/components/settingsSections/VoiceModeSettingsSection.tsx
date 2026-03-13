import React from "react";
import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { rangeStyle } from "../../utils";
import { LlmProviderOptions, VISION_LLM_PROVIDER_OPTIONS } from "./LlmProviderOptions";
import { OPENAI_REALTIME_TRANSCRIPTION_METHOD_OPTIONS } from "../../settingsFormModel";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";
import {
  normalizeVoiceAdmissionModeForDashboard,
  STREAM_WATCH_VISUALIZER_MODES
} from "../../../../src/settings/voiceDashboardMappings.ts";

const STREAM_WATCH_VISUALIZER_LABELS = Object.freeze({
  off: "Off (relay source video when available)",
  cqt: "Constant-Q waterfall",
  spectrum: "Scrolling spectrum",
  waves: "Waveform lines",
  vectorscope: "Stereo vectorscope"
} satisfies Record<(typeof STREAM_WATCH_VISUALIZER_MODES)[number], string>);

/* ── Screen share mental model ── */

function ScreenShareMentalModel({
  scannerLabel,
  voiceBrainLabel,
  directVisionSupported,
  autonomousCommentaryEnabled,
  brainContextEnabled,
}: {
  scannerLabel: string;
  voiceBrainLabel: string;
  directVisionSupported: boolean;
  autonomousCommentaryEnabled: boolean;
  brainContextEnabled: boolean;
}) {
  return (
    <div className="ssm-card">
      <div className="ssm-title">How screen watch works</div>
      <div className="ssm-list">
        <div className="ssm-row">
          <span className="ssm-label">Current frame</span>
          <span className="ssm-arrow">&rarr;</span>
          <span className="ssm-detail">
            {directVisionSupported
              ? `Attached to the normal voice brain on every turn — ${voiceBrainLabel}`
              : "This voice brain provider does not currently accept direct frame inputs"}
          </span>
        </div>
        <div className="ssm-row">
          <span className="ssm-label">Background scanner</span>
          <span className="ssm-arrow">&rarr;</span>
          <span className="ssm-detail">
            {brainContextEnabled
              ? `Builds rolling temporal notes for continuity — ${scannerLabel}`
              : "Disabled"}
          </span>
        </div>
        <div className="ssm-row">
          <span className="ssm-label">Proactive turns</span>
          <span className="ssm-arrow">&rarr;</span>
          <span className="ssm-detail">
            {autonomousCommentaryEnabled
              ? "Quiet moments and scene changes can trigger a normal brain turn"
              : "Disabled"}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Pipeline flow indicator ── */

type PipelineStage = { label: string; active: boolean };

function formatProviderModelLabel(
  provider: string,
  model: string,
  fallback = "Auto"
) {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(model || "").trim();
  if (normalizedProvider && normalizedModel) {
    return `${normalizedProvider} / ${normalizedModel}`;
  }
  if (normalizedProvider) return normalizedProvider;
  if (normalizedModel) return normalizedModel;
  return fallback;
}

function PipelineFlowIndicator({
  stages,
  parallel
}: {
  stages: PipelineStage[];
  parallel?: { label: string; spanFrom: string; spanTo: string }[];
}) {
  return (
    <div className="vps-pipeline-wrap">
      <div className="vps-pipeline-flow">
        {stages.map((stage, i) => (
          <React.Fragment key={stage.label}>
            {i > 0 && <span className="vps-stage-arrow">&rarr;</span>}
            <span
              className={`vps-stage-pill ${
                stage.active ? "vps-stage-pill-active" : "vps-stage-pill-bypassed"
              }`}
            >
              {stage.label}
            </span>
          </React.Fragment>
        ))}
      </div>
      {parallel && parallel.length > 0 && (
        <div className="vps-parallel-row">
          {parallel.map((p) => (
            <span key={p.label} className="vps-parallel-pill">
              &#x21BA; {p.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Stage panel wrapper ── */

function StagePanel({
  number,
  label,
  pathTag,
  children
}: {
  number: number;
  label: string;
  pathTag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="vps-stage-panel">
      <div className="vps-stage-panel-header">
        <span className="vps-stage-number">{number}</span>
        <span className="vps-stage-label">{label}</span>
        {pathTag && <span className="vps-stage-path-tag">{pathTag}</span>}
      </div>
      <div className="vps-stage-body">{children}</div>
    </div>
  );
}

/* ── Collapsible voice subpanel ── */

function VoiceSubpanel({
  label,
  defaultOpen = false,
  children
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="voice-subpanel" open={defaultOpen || undefined}>
      <summary className="voice-subpanel-summary">
        <span className="voice-subpanel-arrow">&#x25B8;</span>
        <span className="voice-subpanel-label">{label}</span>
      </summary>
      <div className="voice-subpanel-body">{children}</div>
    </details>
  );
}

/* ── Main component ── */

export function VoiceModeSettingsSection({
  id,
  form,
  set,
  showVoiceSettings,
  isVoiceAgentMode,
  isOpenAiRealtimeMode,
  isGeminiRealtimeMode,
  isElevenLabsRealtimeMode,
  setVoiceGenerationProvider,
  selectVoiceGenerationPresetModel,
  voiceGenerationModelOptions,
  selectedVoiceGenerationPresetModel,
  setVoiceReplyDecisionProvider,
  selectVoiceReplyDecisionPresetModel,
  voiceReplyDecisionModelOptions,
  selectedVoiceReplyDecisionPresetModel,
  setVoiceInterruptProvider,
  selectVoiceInterruptPresetModel,
  voiceInterruptModelOptions,
  selectedVoiceInterruptPresetModel,
  setVoiceMusicBrainProvider,
  selectVoiceMusicBrainPresetModel,
  voiceMusicBrainModelOptions,
  selectedVoiceMusicBrainPresetModel,
  xAiVoiceOptions,
  openAiRealtimeModelOptions,
  openAiRealtimeVoiceOptions,
  openAiTranscriptionModelOptions,
  geminiRealtimeModelOptions,
  setStreamWatchVisionProvider,
  selectStreamWatchVisionPresetModel,
  streamWatchVisionModelOptions,
  selectedStreamWatchVisionPresetModel
}) {
  const isRealtimeMode =
    isVoiceAgentMode || isOpenAiRealtimeMode || isGeminiRealtimeMode || isElevenLabsRealtimeMode;
  const replyPath = String(form.voiceReplyPath || "brain").trim().toLowerCase();
  const isBridgePath = replyPath === "bridge";
  const isBrainPath = replyPath === "brain";
  const isNativePath = replyPath === "native";
  const ttsMode = String(isBridgePath ? "realtime" : form.voiceTtsMode || "realtime").trim().toLowerCase();
  const isApiTts = ttsMode === "api";
  const streamingVoiceReplyActive = isBrainPath && !isApiTts;
  const openAiRealtimeTranscriptionMethodOptions = OPENAI_REALTIME_TRANSCRIPTION_METHOD_OPTIONS;
  const openAiRealtimeTranscriptionMethod = String(
    form.voiceOpenAiRealtimeTranscriptionMethod || "realtime_bridge"
  )
    .trim()
    .toLowerCase();
  const usesRealtimeAsrBridge = openAiRealtimeTranscriptionMethod !== "file_wav";
  const asrModeConfigVisible = (isBridgePath || isBrainPath) && usesRealtimeAsrBridge;
  const openAiPerUserAsrBridge =
    asrModeConfigVisible &&
    Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge);
  const usesBrainGeneration = isRealtimeMode && isBrainPath;
  const normalizedAdmissionMode = normalizeVoiceAdmissionModeForDashboard(
    form.voiceReplyDecisionRealtimeAdmissionMode
  );
  const classifierAlwaysOn = isRealtimeMode && isBridgePath;
  const classifierSelectable = isRealtimeMode && isBrainPath;
  const classifierActive = classifierAlwaysOn ||
    (classifierSelectable && normalizedAdmissionMode === "classifier_gate");
  const admissionStageVisible = isRealtimeMode && (isBridgePath || isBrainPath || isNativePath);
  const inputStageVisible = admissionStageVisible;
  const inputStageCount = inputStageVisible ? 1 : 0;
  const musicBrainVisible = isRealtimeMode;
  const musicBrainDisabled = String(form.voiceMusicBrainMode || "disabled").trim().toLowerCase() === "disabled";
  const admissionPathTag = isBridgePath ? "Bridge" : isBrainPath ? "Brain" : "Native";
  const classifierStageNumber = inputStageVisible ? 2 : 1;
  const musicBrainStageNumber = inputStageCount + (admissionStageVisible ? 1 : 0) + 1;
  const brainStageNumber =
    inputStageCount + (admissionStageVisible ? 1 : 0) + (musicBrainVisible ? 1 : 0) + 1;
  const voiceOutputStageNumber =
    inputStageCount +
    (admissionStageVisible ? 1 : 0) +
    (musicBrainVisible ? 1 : 0) +
    (usesBrainGeneration ? 1 : 0) +
    1;
  const voiceGenerationProvider = String(form.voiceGenerationLlmProvider || form.provider || "").trim();
  const soundboardEagerness = Number(form.voiceSoundboardEagerness) || 0;
  const soundboardTendencyHint =
    soundboardEagerness <= 10
      ? "Almost never use Discord sound effects unless someone clearly asks for one or the joke is painfully obvious."
      : soundboardEagerness <= 35
        ? "Keeps soundboard use conservative. The bot should mostly speak normally and save effects for clean, rare beats."
        : soundboardEagerness <= 70
          ? "Allows occasional humorous Discord sound effects when they work as reaction punctuation."
          : "Lets the bot lean into playful soundboard bits when the timing is right, while still avoiding spam.";
  const voiceGenerationModel = String(form.voiceGenerationLlmModel || "").trim();
  const voiceInterruptProvider = String(form.voiceInterruptLlmProvider || "").trim();
  const voiceInterruptModel = String(form.voiceInterruptLlmModel || "").trim();
  const streamWatchProvider = String(form.voiceStreamWatchBrainContextProvider || "").trim();
  const streamWatchModel = String(
    form.voiceStreamWatchBrainContextModel || selectedStreamWatchVisionPresetModel || ""
  ).trim();
  const directFrameToBrainSupported = [
    "openai",
    "anthropic",
    "claude-oauth",
    "openai-oauth",
    "codex-cli",
    "codex_cli_session",
    "xai"
  ].includes(voiceGenerationProvider);
  const streamWatchNotesBindingLabel = formatProviderModelLabel(streamWatchProvider, streamWatchModel, "Default scanner");

  /* Pipeline stages for indicator */
  const pipelineStages: PipelineStage[] = isNativePath
    ? [
        { label: "Audio In", active: true },
        { label: "Realtime Model", active: true },
        { label: "Audio Out", active: true }
      ]
    : isBridgePath
    ? [
        { label: "Audio In", active: true },
        { label: "ASR", active: true },
        { label: "Admission Gate", active: true },
        { label: "Realtime Model", active: true },
        { label: "Audio Out", active: true }
      ]
    : [
        { label: "Audio In", active: true },
        { label: "ASR", active: true },
        { label: "Admission Gate", active: true },
        { label: "Text Brain", active: true },
        { label: isApiTts ? "TTS API" : "Realtime TTS", active: true },
        { label: "Audio Out", active: true }
      ];
  const pipelineParallel = isNativePath
    ? undefined
    : [{ label: "Interrupt Classifier (monitors during output)", spanFrom: "Audio Out", spanTo: "Audio Out" }];

  return (
    <SettingsSection id={id} title="Voice Mode" active={form.voiceEnabled}>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
          Enable voice sessions
        </label>
      </div>

      <Collapse open={showVoiceSettings}>
        <VoiceSubpanel label="Overview" defaultOpen>
          {/* ── Top: Runtime + Reply Path ── */}
          <label htmlFor="voice-mode">Voice runtime mode</label>
          <select id="voice-mode" value={form.voiceProvider} onChange={set("voiceProvider")}>
            <option value="xai">xAI realtime (low-latency)</option>
            <option value="openai">OpenAI realtime (low-latency)</option>
            <option value="gemini">Gemini realtime (audio + stream frames)</option>
            <option value="elevenlabs">ElevenLabs realtime (agent websocket)</option>
          </select>

          {isRealtimeMode && (
            <>
              <h4>Reply Path</h4>
              <div className="radio-group">
                <label>
                  <input
                    type="radio"
                    name="voiceReplyPath"
                    value="native"
                    checked={isNativePath}
                    onChange={set("voiceReplyPath")}
                  />
                  <strong>Native</strong>
                  <span> &mdash; Audio &rarr; realtime model &rarr; audio out. Fastest path with provider-owned reasoning and provider-native tools where supported.</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="voiceReplyPath"
                    value="bridge"
                    checked={isBridgePath}
                    onChange={set("voiceReplyPath")}
                  />
                  <strong>Bridge</strong>
                  <span> &mdash; Audio &rarr; ASR transcript &rarr; realtime model &rarr; audio out. Rich context, multi-speaker labels, and provider-native tools where supported.</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="voiceReplyPath"
                    value="brain"
                    checked={isBrainPath}
                    onChange={set("voiceReplyPath")}
                  />
                  <strong>Full Brain</strong>
                  <span> &mdash; Audio &rarr; ASR transcript &rarr; text LLM &rarr; realtime or API TTS &rarr; audio out. Maximum control with orchestrator-owned tools and any text model.</span>
                </label>
              </div>

              {/* ── Pipeline Flow Indicator ── */}
              <PipelineFlowIndicator stages={pipelineStages} parallel={pipelineParallel} />

              {/* ── TTS Mode ── */}
              {isBrainPath && (
                <>
                  <h4>TTS Mode</h4>
                  <div className="radio-group">
                    <label>
                      <input
                        type="radio"
                        name="voiceTtsMode"
                        value="realtime"
                        checked={!isApiTts}
                        onChange={set("voiceTtsMode")}
                      />
                      <strong>Realtime</strong>
                      <span> &mdash; Uses the realtime WebSocket for text-to-speech. Lower latency, voice tied to realtime model.</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="voiceTtsMode"
                        value="api"
                        checked={isApiTts}
                        onChange={set("voiceTtsMode")}
                      />
                      <strong>TTS API</strong>
                      <span> &mdash; Uses OpenAI TTS REST API (gpt-4o-mini-tts). More voice options, independent of realtime model.</span>
                    </label>
                  </div>
                  <div className="toggles">
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(form.voiceStreamingEnabled)}
                        onChange={set("voiceStreamingEnabled")}
                      />
                      Stream spoken reply chunks while generation is still running
                    </label>
                  </div>
                  <p>
                    This only takes effect on the Full Brain path with Realtime TTS. When active, the bot can start
                    speaking once the streamed reply reaches the configured chunk size instead of waiting for the full
                    LLM reply to finish generating.
                  </p>
                  {Boolean(form.voiceStreamingEnabled) && (
                    <div className="split">
                      <div>
                        <label htmlFor="voice-streaming-min-sentences-per-chunk">
                          Min sentences per chunk
                        </label>
                        <input
                          id="voice-streaming-min-sentences-per-chunk"
                          type="number"
                          min={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.minSentencesPerChunk.min}
                          max={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.minSentencesPerChunk.max}
                          step="1"
                          value={form.voiceStreamingMinSentencesPerChunk}
                          onChange={set("voiceStreamingMinSentencesPerChunk")}
                        />
                      </div>
                      <div>
                        <label htmlFor="voice-streaming-eager-first-chunk-chars">
                          Eager first chunk chars
                        </label>
                        <input
                          id="voice-streaming-eager-first-chunk-chars"
                          type="number"
                          min={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.eagerFirstChunkChars.min}
                          max={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.eagerFirstChunkChars.max}
                          step="1"
                          value={form.voiceStreamingEagerFirstChunkChars}
                          onChange={set("voiceStreamingEagerFirstChunkChars")}
                        />
                      </div>
                      <div>
                        <label htmlFor="voice-streaming-max-buffer-chars">Max buffered chars</label>
                        <input
                          id="voice-streaming-max-buffer-chars"
                          type="number"
                          min={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.maxBufferChars.min}
                          max={SETTINGS_NUMERIC_CONSTRAINTS.voice.conversationPolicy.streaming.maxBufferChars.max}
                          step="1"
                          value={form.voiceStreamingMaxBufferChars}
                          onChange={set("voiceStreamingMaxBufferChars")}
                        />
                      </div>
                    </div>
                  )}
                  {Boolean(form.voiceStreamingEnabled) && !streamingVoiceReplyActive && (
                    <p>
                      Streaming stays configured, but it is currently inactive because Full Brain is not using
                      Realtime TTS.
                    </p>
                  )}
                  {isApiTts && (
                    <div className="split">
                      <div>
                        <label htmlFor="voice-tts-api-model">TTS model</label>
                        <select
                          id="voice-tts-api-model"
                          value={form.voiceApiTtsModel}
                          onChange={set("voiceApiTtsModel")}
                        >
                          <option value="gpt-4o-mini-tts">gpt-4o-mini-tts</option>
                          <option value="tts-1">tts-1</option>
                          <option value="tts-1-hd">tts-1-hd</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="voice-tts-api-voice">TTS voice</label>
                        <select
                          id="voice-tts-api-voice"
                          value={form.voiceApiTtsVoice}
                          onChange={set("voiceApiTtsVoice")}
                        >
                          <option value="alloy">alloy</option>
                          <option value="ash">ash</option>
                          <option value="ballad">ballad</option>
                          <option value="coral">coral</option>
                          <option value="echo">echo</option>
                          <option value="fable">fable</option>
                          <option value="nova">nova</option>
                          <option value="onyx">onyx</option>
                          <option value="sage">sage</option>
                          <option value="shimmer">shimmer</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="voice-tts-api-speed">TTS speed</label>
                        <input
                          id="voice-tts-api-speed"
                          type="range"
                          min="0.25"
                          max="2"
                          step="0.05"
                          value={form.voiceApiTtsSpeed}
                          onChange={set("voiceApiTtsSpeed")}
                          style={rangeStyle(form.voiceApiTtsSpeed, 0.25, 2)}
                        />
                        <span className="range-value">{Number(form.voiceApiTtsSpeed).toFixed(2)}x</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

        </VoiceSubpanel>

        <VoiceSubpanel label="Input" defaultOpen>
          {/* ── Stage 1: ASR ── */}
          {isRealtimeMode && (isBridgePath || isBrainPath) && (
            <StagePanel number={1} label="ASR" pathTag="Bridge / Brain">
              <div className="split">
                <div>
                  <label htmlFor="voice-openai-realtime-transcription-method">Transcription method</label>
                  <select
                    id="voice-openai-realtime-transcription-method"
                    value={form.voiceOpenAiRealtimeTranscriptionMethod}
                    onChange={set("voiceOpenAiRealtimeTranscriptionMethod")}
                  >
                    {openAiRealtimeTranscriptionMethodOptions.map((methodId) => (
                      <option key={methodId} value={methodId}>
                        {methodId}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-openai-realtime-transcription-model">
                    OpenAI transcription model
                  </label>
                  <select
                    id="voice-openai-realtime-transcription-model"
                    value={form.voiceOpenAiRealtimeInputTranscriptionModel}
                    onChange={set("voiceOpenAiRealtimeInputTranscriptionModel")}
                  >
                    {openAiTranscriptionModelOptions.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <p>
                {usesRealtimeAsrBridge
                  ? "Realtime bridge streams audio into OpenAI transcription sessions and uses those transcripts as the source of truth."
                  : "File WAV transcribes each finalized turn from captured PCM after the turn ends. It is slower, but does not use realtime ASR bridge sessions."}
              </p>

              {asrModeConfigVisible && (
                <div className="split">
                  <div>
                    <label>ASR mode</label>
                    <div className="toggles">
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge)}
                          onChange={set("voiceOpenAiRealtimeUsePerUserAsrBridge")}
                        />
                        Per-user ASR (separate session per speaker)
                      </label>
                    </div>
                    <p>
                      {openAiPerUserAsrBridge
                        ? "Each speaker gets a dedicated ASR session for labeled transcripts."
                        : "Single shared ASR session for all speakers."}
                    </p>
                  </div>
                </div>
              )}

              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={form.voiceAsrEnabled}
                    onChange={set("voiceAsrEnabled")}
                  />
                  ASR enabled (disable to use slash commands only)
                </label>
              </div>

              <div className="split">
                <div>
                  <label htmlFor="voice-asr-language-mode">ASR language mode</label>
                  <select
                    id="voice-asr-language-mode"
                    value={form.voiceAsrLanguageMode}
                    onChange={set("voiceAsrLanguageMode")}
                  >
                    <option value="auto">Auto detect (allow switching)</option>
                    <option value="fixed">Fixed language</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-asr-language-hint">ASR language hint (BCP-47, e.g. en, en-us)</label>
                  <input
                    id="voice-asr-language-hint"
                    type="text"
                    value={form.voiceAsrLanguageHint}
                    onChange={set("voiceAsrLanguageHint")}
                    placeholder="en"
                  />
                </div>
              </div>
              <p>
                Auto mode keeps multilingual switching and uses the hint only for ambiguity bias. Fixed mode forces that
                language for transcription.
              </p>
            </StagePanel>
          )}

          {/* ── ASR Controls (native path — minimal) ── */}
          {isRealtimeMode && isNativePath && (
            <StagePanel number={1} label="ASR" pathTag="Native">
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={form.voiceAsrEnabled}
                    onChange={set("voiceAsrEnabled")}
                  />
                  ASR enabled (disable to use slash commands only)
                </label>
              </div>

              <div className="split">
                <div>
                  <label htmlFor="voice-asr-language-mode-native">ASR language mode</label>
                  <select
                    id="voice-asr-language-mode-native"
                    value={form.voiceAsrLanguageMode}
                    onChange={set("voiceAsrLanguageMode")}
                  >
                    <option value="auto">Auto detect (allow switching)</option>
                    <option value="fixed">Fixed language</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-asr-language-hint-native">ASR language hint (BCP-47, e.g. en, en-us)</label>
                  <input
                    id="voice-asr-language-hint-native"
                    type="text"
                    value={form.voiceAsrLanguageHint}
                    onChange={set("voiceAsrLanguageHint")}
                    placeholder="en"
                  />
                </div>
              </div>
              <p>
                Auto mode keeps multilingual switching and uses the hint only for ambiguity bias. Fixed mode forces that
                language for transcription.
              </p>
            </StagePanel>
          )}

        </VoiceSubpanel>

        <VoiceSubpanel label="Reply Policy" defaultOpen>
          {/* ── Reply admission / classifier ── */}
          {admissionStageVisible && (
            <StagePanel
              number={classifierStageNumber}
              label="Reply Admission"
              pathTag={admissionPathTag}
            >
              {classifierAlwaysOn ? (
                <p>
                  Bridge mode requires a classifier to decide whether to speak each turn, since the realtime provider always generates audio when given input. This preserves the bot's ability to stay silent before bridge forwarding begins.
                </p>
              ) : classifierActive ? (
                <p>
                  Full Brain is running classifier-first admission here. Deterministic floor gates still run first, then a small YES/NO model decides whether the main brain should spend a full reply turn.
                </p>
              ) : isBrainPath ? (
                <p>
                  Full Brain is generation-owned here. Deterministic floor gates run first, then surviving turns go straight to the main reply brain, which can still choose silence via [SKIP].
                </p>
              ) : (
                <p>
                  Native path uses deterministic floor gates here. Surviving turns stay inside the realtime model, which handles reply vs silence on its own path.
                </p>
              )}
              <div className="split">
                {classifierSelectable && (
                  <div>
                    <label htmlFor="voice-reply-decision-realtime-admission-mode">Admission mode</label>
                    <select
                      id="voice-reply-decision-realtime-admission-mode"
                      value={normalizedAdmissionMode}
                      onChange={set("voiceReplyDecisionRealtimeAdmissionMode")}
                    >
                      <option value="generation_decides">Generation decides ([SKIP])</option>
                      <option value="classifier_gate">Classifier gate</option>
                    </select>
                  </div>
                )}
                <div>
                  <label htmlFor="voice-music-wake-latch-seconds">Music wake latch seconds</label>
                  <input
                    id="voice-music-wake-latch-seconds"
                    type="number"
                    min={SETTINGS_NUMERIC_CONSTRAINTS.voice.admission.musicWakeLatchSeconds.min}
                    max={SETTINGS_NUMERIC_CONSTRAINTS.voice.admission.musicWakeLatchSeconds.max}
                    step="1"
                    value={form.voiceReplyDecisionMusicWakeLatchSeconds}
                    onChange={set("voiceReplyDecisionMusicWakeLatchSeconds")}
                  />
                </div>
              </div>
              {classifierActive && (
                <>
                  <div className="split">
                    <div>
                      <label htmlFor="voice-reply-decision-provider">Provider</label>
                      <select
                        id="voice-reply-decision-provider"
                        value={form.voiceReplyDecisionLlmProvider}
                        onChange={setVoiceReplyDecisionProvider}
                      >
                        <LlmProviderOptions />
                      </select>
                    </div>
                    <div>
                      <label htmlFor="voice-reply-decision-model-preset">Model ID</label>
                      <select
                        id="voice-reply-decision-model-preset"
                        value={selectedVoiceReplyDecisionPresetModel}
                        onChange={selectVoiceReplyDecisionPresetModel}
                      >
                        {voiceReplyDecisionModelOptions.map((modelId) => (
                          <option key={modelId} value={modelId}>
                            {modelId}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}
            </StagePanel>
          )}

          {musicBrainVisible && (
            <StagePanel
              number={musicBrainStageNumber}
              label="Music Brain"
              pathTag={isNativePath ? "Native" : isBridgePath ? "Bridge" : "Brain"}
            >
              <p>
                When enabled, this small music brain handles wake-word music handoff and music tool decisions while audio is active.
              </p>
              <div className="split">
                <div>
                  <label htmlFor="voice-music-brain-mode">Music brain mode</label>
                  <select
                    id="voice-music-brain-mode"
                    value={form.voiceMusicBrainMode || "disabled"}
                    onChange={set("voiceMusicBrainMode")}
                  >
                    <option value="disabled">Off (main brain handles music handoff)</option>
                    <option value="dedicated_model">On (dedicated music brain)</option>
                  </select>
                </div>
              </div>
              {!musicBrainDisabled && (
                <div className="split">
                  <div>
                    <label htmlFor="voice-music-brain-provider">Music brain provider</label>
                    <select
                      id="voice-music-brain-provider"
                      value={form.voiceMusicBrainLlmProvider}
                      onChange={setVoiceMusicBrainProvider}
                    >
                      <LlmProviderOptions />
                    </select>
                  </div>
                  <div>
                    <label htmlFor="voice-music-brain-model-preset">Music brain model ID</label>
                    <select
                      id="voice-music-brain-model-preset"
                      value={selectedVoiceMusicBrainPresetModel}
                      onChange={selectVoiceMusicBrainPresetModel}
                    >
                      {voiceMusicBrainModelOptions.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <p>
                {musicBrainDisabled
                  ? "Wake-word music turns still get through the safety gates, but the main reply brain decides whether to pause, duck, do nothing, or ignore the turn."
                  : "It stays separate from the reply admission gate because active music handoff still uses it even when admission is set to generation decides."}
              </p>
            </StagePanel>
          )}

          {/* ── Reply Decision (all paths) ── */}
          <h4>Reply Decision</h4>
          <label htmlFor="voice-reply-eagerness">
            Voice ambient reply eagerness: <strong>{form.voiceAmbientReplyEagerness}%</strong>
          </label>
          <input
            id="voice-reply-eagerness"
            type="range"
            min="0"
            max="100"
            step="1"
            value={form.voiceAmbientReplyEagerness}
            onChange={set("voiceAmbientReplyEagerness")}
            style={rangeStyle(form.voiceAmbientReplyEagerness)}
            disabled={Boolean(form.voiceCommandOnlyMode)}
          />
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={Boolean(form.voiceCommandOnlyMode)}
                onChange={set("voiceCommandOnlyMode")}
              />
              Command-only mode
            </label>
          </div>
          <p>
            {form.voiceCommandOnlyMode
              ? "Command-only mode narrows the bot to wake-word and direct-address turns only. Music playback also forces this mode while audible."
              : "How willing the bot is to speak in voice when a turn was not clearly directed at it. Higher values widen ambient participation; the response-window slider still separately controls follow-up stickiness."}
          </p>

          <div className="split">
            <div>
              <label htmlFor="voice-default-interruption-mode">Interruption policy</label>
              <select
                id="voice-default-interruption-mode"
                value={form.voiceDefaultInterruptionMode}
                onChange={set("voiceDefaultInterruptionMode")}
              >
                <option value="speaker">Reply target interrupts first</option>
                <option value="anyone">Anyone can interrupt</option>
                <option value="none">Nobody can interrupt</option>
              </select>
            </div>
          </div>
          <p>
            Who can interrupt the bot mid-speech. Speaker mode gives the current reply target the privileged fast path, while other speakers can still seize the floor through overlap arbitration when they clearly take over.
          </p>
          <div className="split">
            <div>
              <label htmlFor="voice-interrupt-provider">Interrupt classifier provider</label>
              <select
                id="voice-interrupt-provider"
                value={form.voiceInterruptLlmProvider}
                onChange={setVoiceInterruptProvider}
              >
                <LlmProviderOptions />
              </select>
            </div>
            <div>
              <label htmlFor="voice-interrupt-model-preset">Interrupt classifier model ID</label>
              <select
                id="voice-interrupt-model-preset"
                value={selectedVoiceInterruptPresetModel}
                onChange={selectVoiceInterruptPresetModel}
              >
                {voiceInterruptModelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p>
            While the bot is already speaking, overlapping ASR snippets are grouped into short bursts and this model decides whether the room is actually taking the floor or just reacting.
          </p>
          <p className="vps-runtime-summary-note">
            Current interrupt binding: {formatProviderModelLabel(voiceInterruptProvider, voiceInterruptModel, "auto")}
          </p>

        </VoiceSubpanel>

        <VoiceSubpanel label="Output" defaultOpen>
          {/* ── Brain (brain path only) ── */}
          {usesBrainGeneration && (
            <StagePanel number={brainStageNumber} label="Brain" pathTag="Brain">
              <p>
                Used for voice reply generation when the reply path is set to Brain.
              </p>
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={form.voiceGenerationLlmUseTextModel}
                    onChange={set("voiceGenerationLlmUseTextModel")}
                  />
                  Use text model
                </label>
              </div>
              <div className="split">
                <div>
                  <label htmlFor="voice-generation-provider">Provider</label>
                  <select
                    id="voice-generation-provider"
                    value={form.voiceGenerationLlmProvider}
                    onChange={setVoiceGenerationProvider}
                    disabled={form.voiceGenerationLlmUseTextModel}
                  >
                    <LlmProviderOptions />
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-generation-model-preset">Model ID</label>
                  <select
                    id="voice-generation-model-preset"
                    value={selectedVoiceGenerationPresetModel}
                    onChange={selectVoiceGenerationPresetModel}
                    disabled={form.voiceGenerationLlmUseTextModel}
                  >
                    {voiceGenerationModelOptions.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </StagePanel>
          )}

          {/* ── Voice Output ── */}
          <StagePanel number={voiceOutputStageNumber} label="Voice Output">
            <p>
              {isBridgePath
                ? "In Bridge mode, the realtime model handles both reasoning and speech."
                : isBrainPath
                ? "In Brain mode, a text LLM generates replies and the realtime API speaks them."
                : "Model and voice used for spoken audio output. In Native mode the model handles end-to-end."}
            </p>

            {isVoiceAgentMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-xai-voice">xAI voice</label>
                    <select id="voice-xai-voice" value={form.voiceXaiVoice} onChange={set("voiceXaiVoice")}>
                      {xAiVoiceOptions.map((voiceName) => (
                        <option key={voiceName} value={voiceName}>
                          {voiceName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="voice-xai-region">xAI region</label>
                    <input id="voice-xai-region" type="text" value={form.voiceXaiRegion} onChange={set("voiceXaiRegion")} />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-xai-audio-format">xAI audio format</label>
                    <input
                      id="voice-xai-audio-format"
                      type="text"
                      value={form.voiceXaiAudioFormat}
                      onChange={set("voiceXaiAudioFormat")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-xai-sample-rate">xAI sample rate (Hz)</label>
                    <input
                      id="voice-xai-sample-rate"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max}
                      value={form.voiceXaiSampleRateHz}
                      onChange={set("voiceXaiSampleRateHz")}
                    />
                  </div>
                </div>
              </>
            )}

            {isOpenAiRealtimeMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-openai-realtime-model">OpenAI output model</label>
                    <select
                      id="voice-openai-realtime-model"
                      value={form.voiceOpenAiRealtimeModel}
                      onChange={set("voiceOpenAiRealtimeModel")}
                    >
                      {openAiRealtimeModelOptions.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="voice-openai-realtime-voice">OpenAI realtime voice</label>
                    <select
                      id="voice-openai-realtime-voice"
                      value={form.voiceOpenAiRealtimeVoice}
                      onChange={set("voiceOpenAiRealtimeVoice")}
                    >
                      {openAiRealtimeVoiceOptions.map((voiceName) => (
                        <option key={voiceName} value={voiceName}>
                          {voiceName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <p>Audio transport is fixed to `pcm16` for stable Discord playback.</p>
              </>
            )}

            {isGeminiRealtimeMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-gemini-realtime-model">Gemini realtime model</label>
                    <select
                      id="voice-gemini-realtime-model"
                      value={form.voiceGeminiRealtimeModel}
                      onChange={set("voiceGeminiRealtimeModel")}
                    >
                      {geminiRealtimeModelOptions.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="voice-gemini-realtime-voice">Gemini realtime voice</label>
                    <input
                      id="voice-gemini-realtime-voice"
                      type="text"
                      value={form.voiceGeminiRealtimeVoice}
                      onChange={set("voiceGeminiRealtimeVoice")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-gemini-realtime-api-base-url">Gemini API base URL</label>
                    <input
                      id="voice-gemini-realtime-api-base-url"
                      type="text"
                      value={form.voiceGeminiRealtimeApiBaseUrl}
                      onChange={set("voiceGeminiRealtimeApiBaseUrl")}
                    />
                  </div>
                  <div />
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-gemini-realtime-input-sample-rate">Gemini input sample rate (Hz)</label>
                    <input
                      id="voice-gemini-realtime-input-sample-rate"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max}
                      value={form.voiceGeminiRealtimeInputSampleRateHz}
                      onChange={set("voiceGeminiRealtimeInputSampleRateHz")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-gemini-realtime-output-sample-rate">Gemini output sample rate (Hz)</label>
                    <input
                      id="voice-gemini-realtime-output-sample-rate"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max}
                      value={form.voiceGeminiRealtimeOutputSampleRateHz}
                      onChange={set("voiceGeminiRealtimeOutputSampleRateHz")}
                    />
                  </div>
                </div>
              </>
            )}

            {isElevenLabsRealtimeMode && (
              <>
                <div className="split">
                  <div>
                    <label htmlFor="voice-elevenlabs-agent-id">ElevenLabs agent ID</label>
                    <input
                      id="voice-elevenlabs-agent-id"
                      type="text"
                      value={form.voiceElevenLabsRealtimeAgentId}
                      onChange={set("voiceElevenLabsRealtimeAgentId")}
                      placeholder="agent_..."
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-elevenlabs-api-base-url">ElevenLabs API base URL</label>
                    <input
                      id="voice-elevenlabs-api-base-url"
                      type="text"
                      value={form.voiceElevenLabsRealtimeApiBaseUrl}
                      onChange={set("voiceElevenLabsRealtimeApiBaseUrl")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-elevenlabs-input-sample-rate">ElevenLabs input sample rate (Hz)</label>
                    <input
                      id="voice-elevenlabs-input-sample-rate"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max}
                      value={form.voiceElevenLabsRealtimeInputSampleRateHz}
                      onChange={set("voiceElevenLabsRealtimeInputSampleRateHz")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-elevenlabs-output-sample-rate">ElevenLabs output sample rate (Hz)</label>
                    <input
                      id="voice-elevenlabs-output-sample-rate"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.voiceRuntime.sampleRateHz.max}
                      value={form.voiceElevenLabsRealtimeOutputSampleRateHz}
                      onChange={set("voiceElevenLabsRealtimeOutputSampleRateHz")}
                    />
                  </div>
                </div>
              </>
            )}

            {!isRealtimeMode && (
              <div className="split">
                <div>
                  <label htmlFor="voice-tts-api-model-nonrealtime">TTS model</label>
                  <select
                    id="voice-tts-api-model-nonrealtime"
                    value={form.voiceApiTtsModel}
                    onChange={set("voiceApiTtsModel")}
                  >
                    <option value="gpt-4o-mini-tts">gpt-4o-mini-tts</option>
                    <option value="tts-1">tts-1</option>
                    <option value="tts-1-hd">tts-1-hd</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-tts-api-voice-nonrealtime">TTS voice</label>
                  <select
                    id="voice-tts-api-voice-nonrealtime"
                    value={form.voiceApiTtsVoice}
                    onChange={set("voiceApiTtsVoice")}
                  >
                    <option value="alloy">alloy</option>
                    <option value="ash">ash</option>
                    <option value="ballad">ballad</option>
                    <option value="coral">coral</option>
                    <option value="echo">echo</option>
                    <option value="fable">fable</option>
                    <option value="nova">nova</option>
                    <option value="onyx">onyx</option>
                    <option value="sage">sage</option>
                    <option value="shimmer">shimmer</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-tts-api-speed-nonrealtime">TTS speed</label>
                  <input
                    id="voice-tts-api-speed-nonrealtime"
                    type="range"
                    min="0.25"
                    max="2"
                    step="0.05"
                    value={form.voiceApiTtsSpeed}
                    onChange={set("voiceApiTtsSpeed")}
                    style={rangeStyle(form.voiceApiTtsSpeed, 0.25, 2)}
                  />
                  <span className="range-value">{Number(form.voiceApiTtsSpeed).toFixed(2)}x</span>
                </div>
              </div>
            )}

          </StagePanel>

        </VoiceSubpanel>

        <VoiceSubpanel label="Limits">
          {/* ── Session ── */}
          <h4>Session</h4>
          <div className="split">
            <div>
              <label htmlFor="voice-max-session-minutes">Max session minutes</label>
              <input
                id="voice-max-session-minutes"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionMinutes.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionMinutes.max}
                value={form.voiceMaxSessionMinutes}
                onChange={set("voiceMaxSessionMinutes")}
              />
            </div>
            <div>
              <label htmlFor="voice-inactivity-seconds">Inactivity leave seconds</label>
              <input
                id="voice-inactivity-seconds"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.inactivityLeaveSeconds.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.inactivityLeaveSeconds.max}
                value={form.voiceInactivityLeaveSeconds}
                onChange={set("voiceInactivityLeaveSeconds")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="voice-max-sessions-day">Max sessions/day</label>
              <input
                id="voice-max-sessions-day"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionsPerDay.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxSessionsPerDay.max}
                value={form.voiceMaxSessionsPerDay}
                onChange={set("voiceMaxSessionsPerDay")}
              />
            </div>
            <div>
              <label htmlFor="voice-max-concurrent-sessions">Max concurrent sessions</label>
              <input
                id="voice-max-concurrent-sessions"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxConcurrentSessions.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.voice.sessionLimits.maxConcurrentSessions.max}
                value={form.voiceMaxConcurrentSessions}
                onChange={set("voiceMaxConcurrentSessions")}
              />
            </div>
            <div>
              <label htmlFor="voice-operational-messages">Text channel status messages</label>
              <select
                id="voice-operational-messages"
                value={form.voiceOperationalMessages}
                onChange={set("voiceOperationalMessages")}
              >
                <option value="all">All (always post)</option>
                <option value="essential">Essential (skip routine lifecycle)</option>
                <option value="minimal">Minimal (only direct requests + critical errors)</option>
                <option value="none">None (suppress all)</option>
              </select>
            </div>
          </div>
          <p>
            Controls how chatty the bot is in text when voice events happen. "Essential" lets the LLM skip routine
            messages like session end or music state changes. "Minimal" also suppresses error announcements unless
            critical. "None" silences all operational messages.
          </p>

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceAllowNsfwHumor}
                onChange={set("voiceAllowNsfwHumor")}
              />
              Voice: allow adult/NSFW humor (with safety limits)
            </label>
          </div>

          {/* ── Ambient Voice Thoughts ── */}
          <h4>Ambient Voice Thoughts</h4>
          <p>
            When VC is quiet, Clank can surface an ambient voice thought and let the brain decide if it should actually be spoken.
          </p>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceThoughtEngineEnabled}
                onChange={set("voiceThoughtEngineEnabled")}
              />
              Enable ambient voice thought loop
            </label>
          </div>
          {form.voiceThoughtEngineEnabled && (
            <>
              <label htmlFor="voice-thought-eagerness">
                Ambient voice thought eagerness: <strong>{form.voiceThoughtEngineEagerness}%</strong>
              </label>
              <input
                id="voice-thought-eagerness"
                type="range"
                min="0"
                max="100"
                step="1"
                value={form.voiceThoughtEngineEagerness}
                onChange={set("voiceThoughtEngineEagerness")}
                style={rangeStyle(form.voiceThoughtEngineEagerness)}
              />

              <div className="split">
                <div>
                  <label htmlFor="voice-thought-silence-seconds">Silence seconds before ambient thought attempt</label>
                  <input
                    id="voice-thought-silence-seconds"
                    type="number"
                    min="8"
                    max="300"
                    value={form.voiceThoughtEngineMinSilenceSeconds}
                    onChange={set("voiceThoughtEngineMinSilenceSeconds")}
                  />
                </div>
                <div>
                  <label htmlFor="voice-thought-min-gap-seconds">Min seconds between ambient thought attempts</label>
                  <input
                    id="voice-thought-min-gap-seconds"
                    type="number"
                    min="8"
                    max="600"
                    value={form.voiceThoughtEngineMinSecondsBetweenThoughts}
                    onChange={set("voiceThoughtEngineMinSecondsBetweenThoughts")}
                  />
                </div>
              </div>
            </>
          )}

        </VoiceSubpanel>

        <VoiceSubpanel label="Screen Watch">
          {/* ── Stream Watch ── */}
          <h4>Screen Watch</h4>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceStreamWatchEnabled}
                onChange={set("voiceStreamWatchEnabled")}
              />
              Enable screen watch + commentary
            </label>
          </div>

          {form.voiceStreamWatchEnabled && (
            <p className="vps-runtime-summary-note">
              Screen watch is layered context. Native Discord receive is preferred, with browser capture as fallback when needed. The current frame always goes to the normal voice brain on active turns.
              These controls tune proactive commentary, rolling notes, and fallback capture behavior when a non-native path is used.
            </p>
          )}

          {form.voiceStreamWatchEnabled && (
            <ScreenShareMentalModel
              scannerLabel={streamWatchNotesBindingLabel}
              voiceBrainLabel={formatProviderModelLabel(voiceGenerationProvider, voiceGenerationModel, "voice brain")}
              directVisionSupported={directFrameToBrainSupported}
              autonomousCommentaryEnabled={Boolean(form.voiceStreamWatchAutonomousCommentaryEnabled)}
              brainContextEnabled={Boolean(form.voiceStreamWatchBrainContextEnabled)}
            />
          )}

          {form.voiceStreamWatchEnabled && (
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(form.voiceStreamWatchAutonomousCommentaryEnabled)}
                  onChange={set("voiceStreamWatchAutonomousCommentaryEnabled")}
                />
                Allow spontaneous screen-watch commentary
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(form.voiceStreamWatchBrainContextEnabled)}
                  onChange={set("voiceStreamWatchBrainContextEnabled")}
                />
                Keep rolling keyframe notes in the brain prompt
              </label>
            </div>
          )}

          {form.voiceStreamWatchEnabled && (
            <details className="vps-advanced-card">
              <summary className="vps-advanced-summary">
                <span className="vps-advanced-arrow">&#x25B8;</span>
                <span>Advanced screen watch settings</span>
                <span className="vps-advanced-summary-copy">Native receive limits, fallback transport, and scanner tuning</span>
              </summary>
              <div className="vps-advanced-body">
                <div className="split">
                  <div>
                    <label htmlFor="voice-stream-watch-visualizer-mode">Music Go Live visualizer</label>
                    <select
                      id="voice-stream-watch-visualizer-mode"
                      value={String(form.voiceStreamWatchVisualizerMode || "cqt")}
                      onChange={set("voiceStreamWatchVisualizerMode")}
                    >
                      {STREAM_WATCH_VISUALIZER_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {STREAM_WATCH_VISUALIZER_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                    <p className="vps-runtime-summary-note">
                      Controls the video sent during music Go Live publish. `cqt` is the default shared audio+visualizer path. `off` keeps the legacy source-video relay path when the track exposes one.
                    </p>
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-stream-watch-commentary-interval">
                      Min seconds between proactive commentary turns
                    </label>
                    <input
                      id="voice-stream-watch-commentary-interval"
                      type="number"
                      min="3"
                      max="120"
                      value={form.voiceStreamWatchMinCommentaryIntervalSeconds}
                      onChange={set("voiceStreamWatchMinCommentaryIntervalSeconds")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-stream-watch-max-fpm">Max ingested stream frames/min</label>
                    <input
                      id="voice-stream-watch-max-fpm"
                      type="number"
                      min="6"
                      max="600"
                      value={form.voiceStreamWatchMaxFramesPerMinute}
                      onChange={set("voiceStreamWatchMaxFramesPerMinute")}
                    />
                  </div>
                </div>

                <div className="split">
                  <div>
                    <label htmlFor="voice-stream-watch-max-frame-bytes">Max stream frame bytes</label>
                    <input
                      id="voice-stream-watch-max-frame-bytes"
                      type="number"
                      min="50000"
                      max="4000000"
                      value={form.voiceStreamWatchMaxFrameBytes}
                      onChange={set("voiceStreamWatchMaxFrameBytes")}
                    />
                  </div>
                  <div>
                      <label htmlFor="voice-stream-watch-keyframe-interval-ms">Fallback browser capture interval (ms)</label>
                    <input
                      id="voice-stream-watch-keyframe-interval-ms"
                      type="number"
                      min="500"
                      max="2000"
                      step="50"
                      value={form.voiceStreamWatchKeyframeIntervalMs}
                      onChange={set("voiceStreamWatchKeyframeIntervalMs")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-stream-watch-share-page-max-width-px">Fallback browser capture max width (px)</label>
                    <input
                      id="voice-stream-watch-share-page-max-width-px"
                      type="number"
                      min="640"
                      max="1920"
                      step="40"
                      value={form.voiceStreamWatchSharePageMaxWidthPx}
                      onChange={set("voiceStreamWatchSharePageMaxWidthPx")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-stream-watch-share-page-jpeg-quality">Fallback browser capture JPEG quality</label>
                    <input
                      id="voice-stream-watch-share-page-jpeg-quality"
                      type="number"
                      min="0.5"
                      max="0.75"
                      step="0.05"
                      value={form.voiceStreamWatchSharePageJpegQuality}
                      onChange={set("voiceStreamWatchSharePageJpegQuality")}
                    />
                  </div>
                </div>

                {form.voiceStreamWatchBrainContextEnabled && (() => {
                  return (
                    <>
                      <div className="split">
                        <div>
                          <label htmlFor="stream-watch-vision-provider">Background keyframe notes provider</label>
                          <select
                            id="stream-watch-vision-provider"
                            value={form.voiceStreamWatchBrainContextProvider}
                            onChange={setStreamWatchVisionProvider}
                          >
                            <LlmProviderOptions options={VISION_LLM_PROVIDER_OPTIONS} />
                          </select>
                        </div>
                        <div>
                          <label htmlFor="stream-watch-vision-model">Background keyframe notes model</label>
                          <select
                            id="stream-watch-vision-model"
                            value={selectedStreamWatchVisionPresetModel}
                            onChange={selectStreamWatchVisionPresetModel}
                          >
                            {streamWatchVisionModelOptions.map((modelId) => (
                              <option key={modelId} value={modelId}>
                                {modelId}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="split">
                        <div>
                          <label htmlFor="voice-stream-watch-brain-context-interval">
                            Min seconds between keyframe analyses
                          </label>
                          <input
                            id="voice-stream-watch-brain-context-interval"
                            type="number"
                            min="1"
                            max="120"
                            value={form.voiceStreamWatchBrainContextMinIntervalSeconds}
                            onChange={set("voiceStreamWatchBrainContextMinIntervalSeconds")}
                          />
                        </div>
                        <div>
                          <label htmlFor="voice-stream-watch-brain-context-max-entries">Brain keyframe history size</label>
                          <input
                            id="voice-stream-watch-brain-context-max-entries"
                            type="number"
                            min="1"
                            max="24"
                            value={form.voiceStreamWatchBrainContextMaxEntries}
                            onChange={set("voiceStreamWatchBrainContextMaxEntries")}
                          />
                        </div>
                      </div>

                      <label htmlFor="voice-stream-watch-brain-context-prompt">Background keyframe notes instruction</label>
                      <textarea
                        id="voice-stream-watch-brain-context-prompt"
                        rows={3}
                        value={form.voiceStreamWatchBrainContextPrompt}
                        onChange={set("voiceStreamWatchBrainContextPrompt")}
                      />
                    </>
                  );
                })()}
              </div>
            </details>
          )}

        </VoiceSubpanel>

        <VoiceSubpanel label="Soundboard">
          {/* ── Soundboard ── */}
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceSoundboardEnabled}
                onChange={set("voiceSoundboardEnabled")}
              />
              Enable Discord soundboard reactions
            </label>
            {form.voiceSoundboardEnabled && (
              <label>
                <input
                  type="checkbox"
                  checked={form.voiceSoundboardAllowExternalSounds}
                  onChange={set("voiceSoundboardAllowExternalSounds")}
                />
                Allow external soundboard sounds
              </label>
            )}
          </div>

          {form.voiceSoundboardEnabled && (
            <>
              <label htmlFor="voice-soundboard-eagerness">
                Soundboard eagerness: <strong>{form.voiceSoundboardEagerness}%</strong>
              </label>
              <input
                id="voice-soundboard-eagerness"
                type="range"
                min={SETTINGS_NUMERIC_CONSTRAINTS.voice.soundboard.eagerness.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.voice.soundboard.eagerness.max}
                step="1"
                value={form.voiceSoundboardEagerness}
                onChange={set("voiceSoundboardEagerness")}
                style={rangeStyle(form.voiceSoundboardEagerness)}
              />
              <p>
                Soundboard eagerness is separate from Core Behavior reactivity, so you can keep quick reactions restrained while still letting Discord sound effects be more or less playful.
              </p>
              <p>{soundboardTendencyHint}</p>

              <label htmlFor="voice-sb-preferred">
                Sound refs (`sound_id` or `sound_id@source_guild_id`, one per line). Leave empty to auto-use guild sounds.
              </label>
              <textarea
                id="voice-sb-preferred"
                rows={3}
                value={form.voiceSoundboardPreferredSoundIds}
                onChange={set("voiceSoundboardPreferredSoundIds")}
              />
            </>
          )}

        </VoiceSubpanel>
      </Collapse>
    </SettingsSection>
  );
}
