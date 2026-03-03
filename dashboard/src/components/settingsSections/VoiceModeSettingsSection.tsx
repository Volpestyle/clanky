import React from "react";
import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { FullPromptPreview } from "../FullPromptPreview";
import { rangeStyle } from "../../utils";
import { LlmProviderOptions } from "./LlmProviderOptions";

export function VoiceModeSettingsSection({
  id,
  form,
  set,
  showVoiceAdvanced,
  isVoiceAgentMode,
  isOpenAiRealtimeMode,
  isGeminiRealtimeMode,
  isElevenLabsRealtimeMode,
  setVoiceReplyDecisionProvider,
  selectVoiceReplyDecisionPresetModel,
  voiceReplyDecisionModelOptions,
  selectedVoiceReplyDecisionPresetModel,
  setVoiceGenerationProvider,
  selectVoiceGenerationPresetModel,
  voiceGenerationModelOptions,
  selectedVoiceGenerationPresetModel,
  setVoiceThoughtEngineProvider,
  selectVoiceThoughtEnginePresetModel,
  voiceThoughtEngineModelOptions,
  selectedVoiceThoughtEnginePresetModel,
  xAiVoiceOptions,
  openAiRealtimeModelOptions,
  openAiRealtimeVoiceOptions,
  openAiTranscriptionModelOptions,
  geminiRealtimeModelOptions,
  onResetVoiceReplyDecisionPrompts
}) {
  const isRealtimeMode =
    isVoiceAgentMode || isOpenAiRealtimeMode || isGeminiRealtimeMode || isElevenLabsRealtimeMode;
  const replyPath = String(form.voiceReplyPath || "bridge").trim().toLowerCase();
  const isBridgePath = replyPath === "bridge";
  const isBrainPath = replyPath === "brain";
  const isNativePath = replyPath === "native";
  const brainProvider = String(form.voiceBrainProvider || "openai")
    .trim()
    .toLowerCase();
  const usesBrainLlm = !isNativePath;
  const openAiPerUserAsrBridge =
    isBridgePath &&
    Boolean(form.voiceOpenAiRealtimeUsePerUserAsrBridge);
  const usesBrainGeneration = isRealtimeMode && usesBrainLlm && !openAiPerUserAsrBridge;
  const classifierMergedWithGeneration =
    !form.voiceReplyDecisionLlmEnabled &&
    usesBrainGeneration;
  const classifierDisabledNativeRealtime =
    !form.voiceReplyDecisionLlmEnabled && isRealtimeMode && isNativePath;
  return (
    <SettingsSection id={id} title="Voice Mode" active={form.voiceEnabled}>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.voiceEnabled} onChange={set("voiceEnabled")} />
          Enable voice sessions
        </label>
      </div>

      <Collapse open={showVoiceAdvanced}>
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
                  <span> &mdash; Raw audio in &rarr; realtime model &rarr; audio out. Fastest, but no text context or tools.</span>
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
                  <span> &mdash; Audio &rarr; ASR &rarr; text LLM &rarr; TTS &rarr; audio out. Maximum control, any text model. Requires OpenAI API key for ASR + TTS provider.</span>
                </label>
              </div>

              {(isBridgePath || isBrainPath) && (
                <>
                  <label htmlFor="voice-brain-provider">Brain provider</label>
                  <select
                    id="voice-brain-provider"
                    value={form.voiceBrainProvider || "openai"}
                    onChange={set("voiceBrainProvider")}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="xai">xAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </>
              )}

              {isBridgePath && (
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
            </>
          )}

          {usesBrainGeneration && (
            <>
              <h4>Brain LLM</h4>
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
            </>
          )}

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
          </div>

          <div className="split">
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
          </div>

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
          />

          <h4>Voice Reply Decider</h4>
          <p>Controls when Clank should chime in during VC.</p>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceReplyDecisionLlmEnabled}
                onChange={set("voiceReplyDecisionLlmEnabled")}
              />
              Enable pre-reply classifier LLM step
            </label>
          </div>
          {classifierMergedWithGeneration && (
            <p>
              With classifier disabled, reply generation decides whether to speak by returning <code>[SKIP]</code>.
            </p>
          )}
          {classifierDisabledNativeRealtime && (
            <p>
              Native realtime mode has no Brain-generation step, so disabling the classifier keeps only
              deterministic fast-path admissions.
            </p>
          )}
          {form.voiceReplyDecisionLlmEnabled && (
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

              <details>
                <summary>Advanced classifier prompts/rules</summary>
                <p>
                  These are the YES/NO gate system prompts used before voice replies. Use <code>{"{{botName}}"}</code>{" "}
                  to reference the configured bot name.
                </p>

                <FullPromptPreview form={form} />

                <label htmlFor="voice-reply-decision-wake-variant-hint">Wake-variant rule hint</label>
                <textarea
                  id="voice-reply-decision-wake-variant-hint"
                  rows={4}
                  value={form.voiceReplyDecisionWakeVariantHint}
                  onChange={set("voiceReplyDecisionWakeVariantHint")}
                />

                <label htmlFor="voice-reply-decision-system-prompt-compact">System prompt (compact)</label>
                <textarea
                  id="voice-reply-decision-system-prompt-compact"
                  rows={8}
                  value={form.voiceReplyDecisionSystemPromptCompact}
                  onChange={set("voiceReplyDecisionSystemPromptCompact")}
                />

                <button
                  type="button"
                  className="sm"
                  onClick={onResetVoiceReplyDecisionPrompts}
                >
                  Reset decider prompts
                </button>
              </details>
            </>
          )}

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
                  <label htmlFor="voice-openai-realtime-model">OpenAI realtime model</label>
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

              <div className="split">
                <div>
                  <label htmlFor="voice-openai-realtime-transcription-model">
                    OpenAI realtime input transcription model
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
                <div />
              </div>
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

          <h4>ASR Controls</h4>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.voiceAsrEnabled}
                onChange={set("voiceAsrEnabled")}
              />
              ASR enabled (disable to use slash commands only)
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.voiceAsrDuringMusic}
                onChange={set("voiceAsrDuringMusic")}
              />
              ASR during music (enables voice stop detection while music plays)
            </label>
          </div>

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
