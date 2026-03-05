import React from "react";
import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { rangeStyle } from "../../utils";
import { LlmProviderOptions } from "./LlmProviderOptions";
import { OPENAI_REALTIME_TRANSCRIPTION_METHOD_OPTIONS } from "../../settingsFormModel";

/* ── Inline constants ── */

const OPENAI_TTS_MODEL_OPTIONS = Object.freeze([
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd"
]);

/* ── Pipeline flow indicator ── */

type PipelineStage = { label: string; active: boolean };

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
  showVoiceAdvanced,
  isVoiceAgentMode,
  isOpenAiRealtimeMode,
  isGeminiRealtimeMode,
  isElevenLabsRealtimeMode,
  setVoiceGenerationProvider,
  selectVoiceGenerationPresetModel,
  voiceGenerationModelOptions,
  selectedVoiceGenerationPresetModel,
  setVoiceThoughtEngineProvider,
  selectVoiceThoughtEnginePresetModel,
  voiceThoughtEngineModelOptions,
  selectedVoiceThoughtEnginePresetModel,
  setVoiceReplyDecisionProvider,
  selectVoiceReplyDecisionPresetModel,
  voiceReplyDecisionModelOptions,
  selectedVoiceReplyDecisionPresetModel,
  xAiVoiceOptions,
  openAiRealtimeModelOptions,
  openAiRealtimeVoiceOptions,
  openAiTranscriptionModelOptions,
  geminiRealtimeModelOptions
}) {
  const isRealtimeMode =
    isVoiceAgentMode || isOpenAiRealtimeMode || isGeminiRealtimeMode || isElevenLabsRealtimeMode;
  const replyPath = String(form.voiceReplyPath || "bridge").trim().toLowerCase();
  const isBridgePath = replyPath === "bridge";
  const isBrainPath = replyPath === "brain";
  const isNativePath = replyPath === "native";
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
  const classifierVisible = isRealtimeMode && isBridgePath && !form.voiceCommandOnlyMode;

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
        { label: "Classifier", active: true },
        { label: "Realtime Brain + TTS", active: true },
        { label: "Audio Out", active: true }
      ]
    : [
        { label: "Audio In", active: true },
        { label: "ASR", active: true },
        { label: "Classifier", active: true },
        { label: "Text Brain", active: true },
        { label: "TTS", active: true },
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

      <Collapse open={showVoiceAdvanced}>
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
                  <span> &mdash; Audio &rarr; realtime model &rarr; audio out. Fastest, but no text context or tools.</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="voiceReplyPath"
                    value="bridge"
                    checked={isBridgePath}
                    onChange={set("voiceReplyPath")}
                  />
                  <strong>Bridge</strong> (Recommended)
                  <span> &mdash; Audio &rarr; ASR transcript &rarr; realtime model &rarr; audio out. Rich context, tools, multi-speaker labels. Requires OpenAI API key for ASR.</span>
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
                  <span> &mdash; Audio &rarr; ASR transcript &rarr; text LLM &rarr; TTS &rarr; audio out. Maximum control, any text model. Requires OpenAI API key for ASR + TTS provider.</span>
                </label>
              </div>

              {/* ── Pipeline Flow Indicator ── */}
              <PipelineFlowIndicator stages={pipelineStages} />
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

          {/* ── Stage 2: Reply Classifier (bridge mode only) ── */}
          {classifierVisible && (
            <StagePanel number={2} label="Reply Classifier" pathTag="Bridge">
              <p>
                LLM gate for bridge mode. Classifies each non-direct-address turn as YES/NO before forwarding to the realtime brain. Replaces heuristic engagement gates with actual language understanding.
              </p>
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.voiceReplyDecisionLlmEnabled)}
                    onChange={set("voiceReplyDecisionLlmEnabled")}
                  />
                  Enable reply classifier
                </label>
              </div>
              {form.voiceReplyDecisionLlmEnabled && (
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
              )}
              {!form.voiceReplyDecisionLlmEnabled && (
                <p>
                  When disabled, all non-direct-address turns in bridge mode are blocked (conservative fallback).
                </p>
              )}
            </StagePanel>
          )}

          {/* ── Reply Decision (all paths) ── */}
          <h4>Reply Decision</h4>
          <label htmlFor="voice-reply-eagerness">
            Voice reply eagerness (unaddressed turns): <strong>{form.voiceReplyEagerness}%</strong>
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
              ? "Command-only mode overrides reply eagerness. Clanker will only respond to wake-word or direct-address turns. Music playback also forces this mode automatically while audible."
              : "When disabled, Clanker can answer unaddressed turns based on reply eagerness. Music playback still forces command-only mode while audible."}
          </p>

          <div className="split">
            <div>
              <label htmlFor="voice-intent-threshold">Intent confidence threshold</label>
              <input
                id="voice-intent-threshold"
                type="number"
                min="0.4"
                max="0.99"
                step="0.01"
                value={form.voiceIntentConfidenceThreshold}
                onChange={set("voiceIntentConfidenceThreshold")}
              />
            </div>
            <div />
          </div>

          {/* ── Stage 3: Brain (brain path only) ── */}
          {usesBrainGeneration && (
            <StagePanel number={3} label="Brain" pathTag="Brain">
              <p>Used for voice reply generation when the reply path is set to Brain.</p>
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
                ? "In Brain mode, the realtime API speaks generated text; OpenAI TTS API is the fallback."
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

            {/* ── TTS Fallback (brain path only) ── */}
            {usesBrainGeneration && (
              <>
                <h4>TTS Fallback</h4>
                <p>
                  When the realtime API utterance path is unavailable, the OpenAI TTS API is used as a fallback to speak generated text.
                </p>
                <div className="split">
                  <div>
                    <label htmlFor="voice-stt-pipeline-tts-model">TTS model</label>
                    <select
                      id="voice-stt-pipeline-tts-model"
                      value={form.voiceSttPipelineTtsModel}
                      onChange={set("voiceSttPipelineTtsModel")}
                    >
                      {OPENAI_TTS_MODEL_OPTIONS.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="voice-stt-pipeline-tts-voice">TTS voice</label>
                    <select
                      id="voice-stt-pipeline-tts-voice"
                      value={form.voiceSttPipelineTtsVoice}
                      onChange={set("voiceSttPipelineTtsVoice")}
                    >
                      {openAiRealtimeVoiceOptions.map((voiceName) => (
                        <option key={voiceName} value={voiceName}>
                          {voiceName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="split">
                  <div>
                    <label htmlFor="voice-stt-pipeline-tts-speed">TTS speed</label>
                    <input
                      id="voice-stt-pipeline-tts-speed"
                      type="number"
                      min="0.25"
                      max="4"
                      step="0.05"
                      value={form.voiceSttPipelineTtsSpeed}
                      onChange={set("voiceSttPipelineTtsSpeed")}
                    />
                  </div>
                  <div />
                </div>
              </>
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
              <div className="split">
                <div>
                  <label htmlFor="voice-thought-engine-provider">Provider</label>
                  <select
                    id="voice-thought-engine-provider"
                    value={form.voiceThoughtEngineProvider}
                    onChange={setVoiceThoughtEngineProvider}
                  >
                    <LlmProviderOptions />
                  </select>
                </div>
                <div>
                  <label htmlFor="voice-thought-engine-model-preset">Model ID</label>
                  <select
                    id="voice-thought-engine-model-preset"
                    value={selectedVoiceThoughtEnginePresetModel}
                    onChange={selectVoiceThoughtEnginePresetModel}
                  >
                    {voiceThoughtEngineModelOptions.map((modelId) => (
                      <option key={modelId} value={modelId}>
                        {modelId}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label htmlFor="voice-thought-temperature">Thought temperature</label>
              <input
                id="voice-thought-temperature"
                type="number"
                min="0"
                max="2"
                step="0.05"
                value={form.voiceThoughtEngineTemperature}
                onChange={set("voiceThoughtEngineTemperature")}
              />

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
            <div className="split">
              <div>
                <label htmlFor="voice-stream-watch-commentary-interval">
                  Min seconds between stream commentary turns
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
          )}

          {form.voiceStreamWatchEnabled && (
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
                  min="250"
                  max="5000"
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
          )}

          {form.voiceStreamWatchEnabled && (
            <div className="split">
              <div>
                <label htmlFor="voice-stream-watch-commentary-path">Screen-watch vision path</label>
                <select
                  id="voice-stream-watch-commentary-path"
                  value={form.voiceStreamWatchCommentaryPath}
                  onChange={set("voiceStreamWatchCommentaryPath")}
                >
                  <option value="auto">Auto (native video when available)</option>
                  <option value="anthropic_keyframes">Anthropic keyframes (forced fallback)</option>
                </select>
              </div>
              <div />
            </div>
          )}

          {form.voiceStreamWatchEnabled && (
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(form.voiceStreamWatchAutonomousCommentaryEnabled)}
                  onChange={set("voiceStreamWatchAutonomousCommentaryEnabled")}
                />
                Auto-speak stream commentary turns
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(form.voiceStreamWatchBrainContextEnabled)}
                  onChange={set("voiceStreamWatchBrainContextEnabled")}
                />
                Feed keyframe context into Brain prompt
              </label>
            </div>
          )}

          {form.voiceStreamWatchEnabled && form.voiceStreamWatchBrainContextEnabled && (
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
          )}

          {form.voiceStreamWatchEnabled && form.voiceStreamWatchBrainContextEnabled && (
            <>
              <label htmlFor="voice-stream-watch-brain-context-prompt">Brain keyframe context instruction</label>
              <textarea
                id="voice-stream-watch-brain-context-prompt"
                rows={3}
                value={form.voiceStreamWatchBrainContextPrompt}
                onChange={set("voiceStreamWatchBrainContextPrompt")}
              />
            </>
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

          {/* ── Access Control ── */}
          <label htmlFor="voice-allowed-channels">Allowed voice channel IDs (optional)</label>
          <textarea
            id="voice-allowed-channels"
            rows={3}
            value={form.voiceAllowedChannelIds}
            onChange={set("voiceAllowedChannelIds")}
          />

          <label htmlFor="voice-blocked-channels">Blocked voice channel IDs</label>
          <textarea
            id="voice-blocked-channels"
            rows={3}
            value={form.voiceBlockedChannelIds}
            onChange={set("voiceBlockedChannelIds")}
          />

          <label htmlFor="voice-blocked-users">Blocked voice user IDs</label>
          <textarea
            id="voice-blocked-users"
            rows={3}
            value={form.voiceBlockedUserIds}
            onChange={set("voiceBlockedUserIds")}
          />
      </Collapse>
    </SettingsSection>
  );
}
