import React from "react";
import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { rangeStyle } from "../../utils";
import { LlmProviderOptions, VISION_LLM_PROVIDER_OPTIONS } from "./LlmProviderOptions";
import { OPENAI_REALTIME_TRANSCRIPTION_METHOD_OPTIONS } from "../../settingsFormModel";
import { normalizeVoiceAdmissionModeForDashboard } from "../../../../src/settings/voiceDashboardMappings.ts";

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
      <div className="ssm-title">How screen share works</div>
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

function PipelineFlowIndicator({ stages }: { stages: PipelineStage[] }) {
  return (
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
  const classifierAlwaysOn = isRealtimeMode && isBridgePath;
  const classifierToggleable = isRealtimeMode && isBrainPath && !form.voiceCommandOnlyMode;
  const classifierVisible = classifierAlwaysOn || classifierToggleable;
  const realtimeAdmissionMode = normalizeVoiceAdmissionModeForDashboard(
    form.voiceReplyDecisionRealtimeAdmissionMode
  );
  const hardClassifierMode = realtimeAdmissionMode === "classifier_gate";
  const voiceGenerationProvider = String(form.voiceGenerationLlmProvider || form.provider || "").trim();
  const voiceGenerationModel = String(form.voiceGenerationLlmModel || "").trim();
  const streamWatchProvider = String(form.voiceStreamWatchBrainContextProvider || "").trim();
  const streamWatchModel = String(
    form.voiceStreamWatchBrainContextModel || selectedStreamWatchVisionPresetModel || ""
  ).trim();
  const directFrameToBrainSupported = [
    "openai",
    "anthropic",
    "claude-oauth",
    "codex-oauth",
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

  return (
    <SettingsSection id={id} title="Voice Mode" active={form.voiceEnabled}>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
          Enable voice sessions
        </label>
      </div>

      <Collapse open={showVoiceSettings}>
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
              <PipelineFlowIndicator stages={pipelineStages} />

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
                    speaking the first sentence before the full LLM reply finishes generating.
                  </p>
                  {Boolean(form.voiceStreamingEnabled) && (
                    <div className="split">
                      <div>
                        <label htmlFor="voice-streaming-eager-first-chunk-chars">
                          Eager first chunk chars
                        </label>
                        <input
                          id="voice-streaming-eager-first-chunk-chars"
                          type="number"
                          min="20"
                          max="240"
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
                          min="40"
                          max="800"
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

          {/* ── Non-realtime ASR Controls ── */}
          {!isRealtimeMode && (
            <StagePanel number={1} label="ASR">
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
                  <label htmlFor="voice-asr-language-mode-legacy">ASR language mode</label>
                  <select
                    id="voice-asr-language-mode-legacy"
                    value={form.voiceAsrLanguageMode}
                    onChange={set("voiceAsrLanguageMode")}
                  >
                    <option value="auto">Auto detect (allow switching)</option>
                    <option value="fixed">Fixed language</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-asr-language-hint-legacy">ASR language hint (BCP-47, e.g. en, en-us)</label>
                  <input
                    id="voice-asr-language-hint-legacy"
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

          {/* ── Stage 2: Reply Classifier ── */}
          {classifierVisible && (
            <StagePanel number={2} label="Reply Classifier" pathTag={classifierAlwaysOn ? "Bridge" : "Brain"}>
              {classifierAlwaysOn ? (
                <p>
                  Bridge mode requires a classifier to decide whether to speak each turn, since the realtime provider always generates audio when given input. This gives the bot the same ability to stay silent that brain mode has natively.
                </p>
              ) : (
                <>
                  <p>
                    In brain mode the generation LLM decides whether to reply via [SKIP]. Enable the classifier to add a cheaper pre-filter before the full generation call.
                  </p>
                  <div className="split">
                    <div>
                      <label htmlFor="voice-realtime-admission-mode">Admission gate</label>
                      <select
                        id="voice-realtime-admission-mode"
                        value={realtimeAdmissionMode}
                        onChange={set("voiceReplyDecisionRealtimeAdmissionMode")}
                      >
                        <option value="generation_decides">Off (generation decides)</option>
                        <option value="classifier_gate">On (classifier gate)</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
              {(classifierAlwaysOn || hardClassifierMode) && (
                <>
                  <div className="split">
                    <div>
                      <label htmlFor="voice-music-wake-latch-seconds">Music wake latch seconds</label>
                      <input
                        id="voice-music-wake-latch-seconds"
                        type="number"
                        min="5"
                        max="60"
                        step="1"
                        value={form.voiceReplyDecisionMusicWakeLatchSeconds}
                        onChange={set("voiceReplyDecisionMusicWakeLatchSeconds")}
                      />
                    </div>
                  </div>
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

          {/* ── Reply Decision (all paths) ── */}
          <h4>Reply Decision</h4>
          <label htmlFor="voice-reply-eagerness">
            Voice reply eagerness: <strong>{form.voiceReplyEagerness}%</strong>
          </label>
          <input
            id="voice-reply-eagerness"
            type="range"
            min="0"
            max="100"
            step="1"
            value={form.voiceReplyEagerness}
            onChange={set("voiceReplyEagerness")}
            style={rangeStyle(form.voiceReplyEagerness)}
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
              : "How social the bot is in voice. Higher values mean it considers more turns and decides for itself whether to speak. Lower values keep it quiet unless addressed."}
          </p>

          <div className="split">
            <div>
              <label htmlFor="voice-default-interruption-mode">Interruption policy</label>
              <select
                id="voice-default-interruption-mode"
                value={form.voiceDefaultInterruptionMode}
                onChange={set("voiceDefaultInterruptionMode")}
              >
                <option value="speaker">Only the current speaker can interrupt</option>
                <option value="anyone">Anyone can interrupt</option>
                <option value="none">Nobody can interrupt</option>
              </select>
            </div>
          </div>
          <p>
            Who can interrupt the bot mid-speech. Speaker mode lets the person the bot is responding to cut in naturally, like a real conversation.
          </p>

          {/* ── Stage 3: Brain (brain path only) ── */}
          {usesBrainGeneration && (
            <StagePanel number={3} label="Brain" pathTag="Brain">
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

          {/* ── Stage 4: Voice Output ── */}
          <StagePanel number={usesBrainGeneration ? 4 : isBridgePath ? 3 : 2} label="Voice Output">
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
                      min="8000"
                      max="48000"
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
                      min="8000"
                      max="48000"
                      value={form.voiceGeminiRealtimeInputSampleRateHz}
                      onChange={set("voiceGeminiRealtimeInputSampleRateHz")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-gemini-realtime-output-sample-rate">Gemini output sample rate (Hz)</label>
                    <input
                      id="voice-gemini-realtime-output-sample-rate"
                      type="number"
                      min="8000"
                      max="48000"
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
                      min="8000"
                      max="48000"
                      value={form.voiceElevenLabsRealtimeInputSampleRateHz}
                      onChange={set("voiceElevenLabsRealtimeInputSampleRateHz")}
                    />
                  </div>
                  <div>
                    <label htmlFor="voice-elevenlabs-output-sample-rate">ElevenLabs output sample rate (Hz)</label>
                    <input
                      id="voice-elevenlabs-output-sample-rate"
                      type="number"
                      min="8000"
                      max="48000"
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

          {/* ── Session ── */}
          <h4>Session</h4>
          <div className="split">
            <div>
              <label htmlFor="voice-max-session-minutes">Max session minutes</label>
              <input
                id="voice-max-session-minutes"
                type="number"
                min="1"
                max="120"
                value={form.voiceMaxSessionMinutes}
                onChange={set("voiceMaxSessionMinutes")}
              />
            </div>
            <div>
              <label htmlFor="voice-inactivity-seconds">Inactivity leave seconds</label>
              <input
                id="voice-inactivity-seconds"
                type="number"
                min="20"
                max="3600"
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
                min="0"
                max="120"
                value={form.voiceMaxSessionsPerDay}
                onChange={set("voiceMaxSessionsPerDay")}
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

          {/* ── Thought Engine ── */}
          <h4>Thought Engine</h4>
          <p>
            When VC is quiet, Clank can self-prompt a candidate thought and let the brain decide if it should be spoken.
          </p>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceThoughtEngineEnabled}
                onChange={set("voiceThoughtEngineEnabled")}
              />
              Enable silence thought loop
            </label>
          </div>
          {form.voiceThoughtEngineEnabled && (
            <>
              <label htmlFor="voice-thought-eagerness">
                Thought eagerness: <strong>{form.voiceThoughtEngineEagerness}%</strong>
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
                  <label htmlFor="voice-thought-silence-seconds">Silence seconds before thought attempt</label>
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
                  <label htmlFor="voice-thought-min-gap-seconds">Min seconds between thought attempts</label>
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

          {/* ── Stream Watch ── */}
          <h4>Stream Watch</h4>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceStreamWatchEnabled}
                onChange={set("voiceStreamWatchEnabled")}
              />
              Enable stream frame ingest + commentary
            </label>
          </div>

          {form.voiceStreamWatchEnabled && (
            <p className="vps-runtime-summary-note">
              Screen share is layered context. The current frame always goes to the normal voice brain on active turns.
              These controls only affect proactive commentary and the optional rolling notes layer.
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
                Allow spontaneous screen-share commentary
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
                <span>Advanced stream watch settings</span>
                <span className="vps-advanced-summary-copy">Transport, rate limits, and scanner tuning</span>
              </summary>
              <div className="vps-advanced-body">
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
                    <label htmlFor="voice-stream-watch-keyframe-interval-ms">Share-page keyframe interval (ms)</label>
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
                    <label htmlFor="voice-stream-watch-share-page-max-width-px">Share-page max width (px)</label>
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
                    <label htmlFor="voice-stream-watch-share-page-jpeg-quality">Share-page JPEG quality</label>
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

          {/* ── Soundboard ── */}
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceSoundboardEnabled}
                onChange={set("voiceSoundboardEnabled")}
              />
              Enable voice soundboard director
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

      </Collapse>
    </SettingsSection>
  );
}
