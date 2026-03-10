import React, { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../api";
import {
  GEMINI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_VOICE_OPTIONS,
  OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
  XAI_VOICE_OPTIONS,
  formToSettingsPatch,
  getCodeAgentValidationError,
  resolveBrowserProviderModelOptions,
  resolveModelOptions,
  resolveModelOptionsFromText,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  sanitizeAliasListInput,
  settingsToForm,
  settingsToFormPreserving
} from "../settingsFormModel";
import { useActiveSection } from "../hooks/useActiveSection";
import { SettingsSection } from "./SettingsSection";
import { CoreBehaviorSettingsSection } from "./settingsSections/CoreBehaviorSettingsSection";
import { PromptGuidanceSettingsSection } from "./settingsSections/PromptGuidanceSettingsSection";
import { LlmConfigurationSettingsSection } from "./settingsSections/LlmConfigurationSettingsSection";
import { WebSearchSettingsSection } from "./settingsSections/WebSearchSettingsSection";
import { BrowserSettingsSection } from "./settingsSections/BrowserSettingsSection";
import { CodeAgentSettingsSection } from "./settingsSections/CodeAgentSettingsSection";
import { VisionSettingsSection } from "./settingsSections/VisionSettingsSection";
import { VideoContextSettingsSection } from "./settingsSections/VideoContextSettingsSection";
import { VoiceModeSettingsSection } from "./settingsSections/VoiceModeSettingsSection";
import { RateLimitsSettingsSection } from "./settingsSections/RateLimitsSettingsSection";
import { StartupCatchupSettingsSection } from "./settingsSections/StartupCatchupSettingsSection";
import { DiscoverySettingsSection } from "./settingsSections/DiscoverySettingsSection";
import { ChannelsPermissionsSettingsSection } from "./settingsSections/ChannelsPermissionsSettingsSection";
import { SubAgentOrchestrationSettingsSection } from "./settingsSections/SubAgentOrchestrationSettingsSection";

export default function SettingsForm({
  settings,
  modelCatalog,
  onSave,
  onRefreshRuntime,
  refreshRuntimeBusy = false,
  toast
}) {
  const [form, setForm] = useState(() => (settings ? settingsToForm(settings) : null));
  const savedFormRef = useRef<string>("");
  const presetRequestIdRef = useRef(0);
  const defaultForm = useMemo(() => settingsToForm({}), []);
  const effectiveForm = form ?? defaultForm;
  const formRef = useRef(form);
  formRef.current = form;

  function updateForm(updater) {
    setForm((current) => {
      const next =
        typeof updater === "function"
          ? updater(current)
          : updater;
      formRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    if (!settings) return;
    const next = settingsToFormPreserving(settings, formRef.current);
    formRef.current = next;
    setForm(next);
    savedFormRef.current = JSON.stringify(next);
  }, [settings]);

  const sections = useMemo(() => {
    const items = [
      { id: "sec-core", label: "Identity" },
      { id: "sec-prompts", label: "Prompting" },
      { id: "sec-stack", label: "Stack Preset" },
      { id: "sec-vision", label: "Vision" },
      { id: "sec-video", label: "Video Context" },
      { id: "sec-voice", label: "Voice" },
      { id: "sec-rate", label: "Rate Limits" },
      { id: "sec-startup", label: "Startup" },
      { id: "sec-discovery", label: "Feed & Media" },
      { id: "sec-channels", label: "Channels" }
    ];
    if (effectiveForm.stackAdvancedOverridesEnabled) {
      items.splice(3, 0,
        { id: "sec-llm", label: "Advanced Stack" },
        { id: "sec-search", label: "Research Runtime" },
        { id: "sec-browser", label: "Browser Runtime" },
        { id: "sec-code-agent", label: "Dev Team" },
        { id: "sec-orchestration", label: "Sessions" }
      );
    }
    return items;
  }, [effectiveForm.stackAdvancedOverridesEnabled]);

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);

  const { activeId: activeSection, setClickedId } = useActiveSection(sectionIds);
  const isDirty = useMemo(() => {
    if (!form || !savedFormRef.current) return false;
    return JSON.stringify(form) !== savedFormRef.current;
  }, [form]);
  const codeAgentValidationError = useMemo(() => getCodeAgentValidationError(effectiveForm), [effectiveForm]);

  async function loadPresetDefaults(preset: string) {
    const requestId = ++presetRequestIdRef.current;
    try {
      const settings = await api<Record<string, unknown>>("/api/settings/preset-defaults", {
        method: "POST",
        body: { preset }
      });
      if (presetRequestIdRef.current !== requestId) {
        return;
      }
      const next = settingsToForm(settings);
      formRef.current = next;
      setForm(next);
    } catch (err) {
      console.error("Failed to load preset defaults:", err);
    }
  }

  function resolvePresetSelection(providerField, modelField) {
    return resolvePresetModelSelection({
      modelCatalog,
      provider: effectiveForm[providerField],
      model: effectiveForm[modelField]
    });
  }

  const {
    options: providerModelOptions,
    selectedPresetModel
  } = resolvePresetSelection("provider", "model");
  const {
    options: textInitiativeModelOptions,
    selectedPresetModel: selectedTextInitiativePresetModel
  } = resolvePresetSelection("textInitiativeLlmProvider", "textInitiativeLlmModel");
  const {
    options: replyFollowupModelOptions,
    selectedPresetModel: selectedReplyFollowupPresetModel
  } = resolvePresetSelection("replyFollowupLlmProvider", "replyFollowupLlmModel");
  const {
    options: memoryLlmModelOptions,
    selectedPresetModel: selectedMemoryLlmPresetModel
  } = resolvePresetSelection("memoryLlmProvider", "memoryLlmModel");
  const {
    options: browserLlmModelOptions,
    selectedPresetModel: selectedBrowserLlmPresetModel
  } = resolvePresetModelSelection({
    modelCatalog: {
      ...modelCatalog,
      [effectiveForm.browserLlmProvider]: resolveBrowserProviderModelOptions(
        modelCatalog,
        effectiveForm.browserLlmProvider
      )
    },
    provider: effectiveForm.browserLlmProvider,
    model: effectiveForm.browserLlmModel
  });
  const {
    options: visionModelOptions,
    selectedPresetModel: selectedVisionPresetModel
  } = resolvePresetSelection("visionProvider", "visionModel");
  const {
    options: voiceGenerationModelOptions,
    selectedPresetModel: selectedVoiceGenerationPresetModel
  } = resolvePresetSelection("voiceGenerationLlmProvider", "voiceGenerationLlmModel");
  const {
    options: voiceReplyDecisionModelOptions,
    selectedPresetModel: selectedVoiceReplyDecisionPresetModel
  } = resolvePresetSelection("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const {
    options: streamWatchVisionModelOptions,
    selectedPresetModel: selectedStreamWatchVisionPresetModel
  } = resolvePresetSelection("voiceStreamWatchBrainContextProvider", "voiceStreamWatchBrainContextModel");
  const openAiRealtimeModelOptions = resolveModelOptions(
    OPENAI_REALTIME_MODEL_OPTIONS,
    effectiveForm.voiceOpenAiRealtimeModel
  );
  const openAiRealtimeVoiceOptions = resolveModelOptions(
    OPENAI_REALTIME_VOICE_OPTIONS,
    effectiveForm.voiceOpenAiRealtimeVoice
  );
  const xAiVoiceOptions = resolveModelOptions(
    XAI_VOICE_OPTIONS,
    effectiveForm.voiceXaiVoice
  );
  const openAiTranscriptionModelOptions = resolveModelOptions(
    OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
    effectiveForm.voiceOpenAiRealtimeInputTranscriptionModel
  );
  const geminiRealtimeModelOptions = resolveModelOptions(
    GEMINI_REALTIME_MODEL_OPTIONS,
    effectiveForm.voiceGeminiRealtimeModel
  );
  const discoveryImageModelOptions = resolveModelOptionsFromText(
    effectiveForm.discoveryAllowedImageModels,
    effectiveForm.discoverySimpleImageModel,
    effectiveForm.discoveryComplexImageModel
  );
  const discoveryVideoModelOptions = resolveModelOptionsFromText(
    effectiveForm.discoveryAllowedVideoModels,
    effectiveForm.discoveryVideoModel
  );
  const isVoiceAgentMode = effectiveForm.voiceProvider === "xai";
  const isOpenAiRealtimeMode = effectiveForm.voiceProvider === "openai";
  const isGeminiRealtimeMode = effectiveForm.voiceProvider === "gemini";
  const isElevenLabsRealtimeMode = effectiveForm.voiceProvider === "elevenlabs";
  const showVoiceSettings = effectiveForm.voiceEnabled;
  const showDiscoveryFeedControls = effectiveForm.discoveryFeedEnabled;
  const showDiscoveryImageControls = effectiveForm.discoveryImageEnabled || effectiveForm.replyImageEnabled;
  const showDiscoveryVideoControls = effectiveForm.discoveryVideoEnabled || effectiveForm.replyVideoEnabled;

  useEffect(() => {
    updateForm((current) => {
      if (!current) return current;
      let changed = false;
      const next = { ...current };
      const syncModel = (field, value) => {
        if (!value) return;
        if (String(next[field] || "").trim() === value) return;
        next[field] = value;
        changed = true;
      };
      syncModel("model", selectedPresetModel);
      syncModel("textInitiativeLlmModel", selectedTextInitiativePresetModel);
      syncModel("replyFollowupLlmModel", selectedReplyFollowupPresetModel);
      syncModel("memoryLlmModel", selectedMemoryLlmPresetModel);
      syncModel("browserLlmModel", selectedBrowserLlmPresetModel);
      syncModel("visionModel", selectedVisionPresetModel);
      syncModel("voiceGenerationLlmModel", selectedVoiceGenerationPresetModel);
      syncModel("voiceReplyDecisionLlmModel", selectedVoiceReplyDecisionPresetModel);
      syncModel("voiceStreamWatchBrainContextModel", selectedStreamWatchVisionPresetModel);
      if (next.voiceGenerationLlmUseTextModel) {
        syncModel("voiceGenerationLlmProvider", next.provider);
        syncModel("voiceGenerationLlmModel", selectedPresetModel);
      }
      if (next.memoryLlmInheritTextModel) {
        syncModel("memoryLlmProvider", next.provider);
        syncModel("memoryLlmModel", selectedPresetModel);
      }
      if (next.textInitiativeUseTextModel) {
        syncModel("textInitiativeLlmProvider", next.provider);
        syncModel("textInitiativeLlmModel", selectedPresetModel);
      }
      return changed ? next : current;
    });
  }, [
    selectedPresetModel,
    selectedTextInitiativePresetModel,
    selectedReplyFollowupPresetModel,
    selectedMemoryLlmPresetModel,
    selectedBrowserLlmPresetModel,
    selectedVoiceGenerationPresetModel,
    selectedVoiceReplyDecisionPresetModel,
    selectedVisionPresetModel,
    selectedStreamWatchVisionPresetModel
  ]);

  if (!form) return null;

  function set(key) {
    return (e) => {
      const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (key === "stackPreset") {
        const preset = String(value || "").trim();
        updateForm((current) => ({ ...(current || defaultForm), stackPreset: preset }));
        void loadPresetDefaults(preset);
        return;
      }
      if (key === "memoryLlmInheritTextModel") {
        updateForm((current) => {
          if (!current) return current;
          const next = { ...current, memoryLlmInheritTextModel: Boolean(value) };
          if (next.memoryLlmInheritTextModel) {
            next.memoryLlmProvider = next.provider;
            next.memoryLlmModel = next.model;
          }
          return next;
        });
        return;
      }
      updateForm((current) => ({ ...current, [key]: value }));
    };
  }

  function sanitizeBotNameAliases() {
    updateForm((current) => {
      if (!current) return current;
      const normalized = sanitizeAliasListInput(current.botNameAliases);
      if (normalized === String(current.botNameAliases || "").trim()) return current;
      return {
        ...current,
        botNameAliases: normalized
      };
    });
  }

  function setProviderWithPresetFallback(providerField, modelField, provider) {
    updateForm((current) => {
      const next = { ...current, [providerField]: provider };
      const options =
        providerField === "browserLlmProvider"
          ? resolveBrowserProviderModelOptions(modelCatalog, provider)
          : resolveProviderModelOptions(modelCatalog, provider);
      const currentModel = String(current?.[modelField] || "").trim();
      if (options.includes(currentModel)) return next;
      next[modelField] = options[0] || currentModel;
      return next;
    });
  }

  function createProviderSetter(providerField, modelField) {
    return (e) => {
      setProviderWithPresetFallback(providerField, modelField, String(e.target.value || "").trim());
    };
  }

  const setProvider = createProviderSetter("provider", "model");
  const setTextInitiativeProvider = createProviderSetter("textInitiativeLlmProvider", "textInitiativeLlmModel");
  const setMemoryLlmProvider = createProviderSetter("memoryLlmProvider", "memoryLlmModel");
  const setReplyFollowupProvider = createProviderSetter("replyFollowupLlmProvider", "replyFollowupLlmModel");
  const setBrowserLlmProvider = createProviderSetter("browserLlmProvider", "browserLlmModel");
  const setVoiceGenerationProvider = createProviderSetter("voiceGenerationLlmProvider", "voiceGenerationLlmModel");
  const setVoiceReplyDecisionProvider = createProviderSetter("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const setVisionProvider = createProviderSetter("visionProvider", "visionModel");
  const setStreamWatchVisionProvider = createProviderSetter("voiceStreamWatchBrainContextProvider", "voiceStreamWatchBrainContextModel");

  function selectModelFieldPreset(modelField, selected) {
    updateForm((current) => ({ ...current, [modelField]: selected }));
  }

  function createPresetSelector(modelField) {
    return (e) => {
      selectModelFieldPreset(modelField, String(e.target.value || ""));
    };
  }

  const selectPresetModel = createPresetSelector("model");
  const selectTextInitiativePresetModel = createPresetSelector("textInitiativeLlmModel");
  const selectReplyFollowupPresetModel = createPresetSelector("replyFollowupLlmModel");
  const selectMemoryLlmPresetModel = createPresetSelector("memoryLlmModel");
  const selectBrowserLlmPresetModel = createPresetSelector("browserLlmModel");
  const selectVoiceGenerationPresetModel = createPresetSelector("voiceGenerationLlmModel");
  const selectVoiceReplyDecisionPresetModel = createPresetSelector("voiceReplyDecisionLlmModel");
  const selectVisionPresetModel = createPresetSelector("visionModel");
  const selectStreamWatchVisionPresetModel = createPresetSelector("voiceStreamWatchBrainContextModel");

  function resetPromptGuidanceFields() {
    updateForm((current) => ({
      ...current,
      promptCapabilityHonestyLine: defaultForm.promptCapabilityHonestyLine,
      promptImpossibleActionLine: defaultForm.promptImpossibleActionLine,
      promptMemoryEnabledLine: defaultForm.promptMemoryEnabledLine,
      promptMemoryDisabledLine: defaultForm.promptMemoryDisabledLine,
      promptSkipLine: defaultForm.promptSkipLine,
      promptTextGuidance: defaultForm.promptTextGuidance,
      promptVoiceGuidance: defaultForm.promptVoiceGuidance,
      promptVoiceOperationalGuidance: defaultForm.promptVoiceOperationalGuidance,
      promptMediaPromptCraftGuidance: defaultForm.promptMediaPromptCraftGuidance
    }));
  }

  function submit(e) {
    e.preventDefault();
    if (codeAgentValidationError) {
      scrollTo("sec-code-agent");
      return;
    }
    const currentForm = formRef.current ?? form ?? defaultForm;
    onSave(formToSettingsPatch(currentForm));
  }

  function scrollTo(id: string) {
    setClickedId(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <form className="panel settings-form" onSubmit={submit}>
      <h3 className="settings-title">Settings</h3>
      <div className="settings-layout">
        <nav className="settings-sidebar">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${activeSection === s.id ? " active" : ""}`}
              onClick={() => scrollTo(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content" style={{ paddingBottom: "60vh" }}>
          <CoreBehaviorSettingsSection
            id="sec-core"
            form={form}
            set={set}
            onSanitizeBotNameAliases={sanitizeBotNameAliases}
          />
          <PromptGuidanceSettingsSection
            id="sec-prompts"
            form={form}
            set={set}
            onResetPromptGuidance={resetPromptGuidanceFields}
          />

          <SettingsSection id="sec-stack" title="Stack Preset">
            <label htmlFor="stack-preset">Preset</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select id="stack-preset" value={form.stackPreset} onChange={set("stackPreset")} style={{ flex: 1 }}>
                <option value="claude_oauth">Claude OAuth</option>
                <option value="claude_api">Claude API</option>
                <option value="openai_native_realtime">OpenAI Native Realtime</option>
                <option value="openai_api">OpenAI API</option>
                <option value="openai_oauth">OpenAI OAuth</option>
                <option value="grok_native_agent">Grok Native Agent</option>
              </select>
              <button
                type="button"
                style={{
                  flex: "0 0 auto",
                  padding: "6px 10px",
                  whiteSpace: "nowrap",
                  fontSize: "0.76rem",
                  fontWeight: 600,
                  background: "transparent",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)"
                }}
                onClick={() => void loadPresetDefaults(form.stackPreset)}
                title="Load preset defaults into the form and save to apply them"
              >
                Reset to preset defaults
              </button>
            </div>
            <p className="status-msg" style={{ marginTop: 8 }}>
              Preset changes update the form only. Save to apply them to the bot.
            </p>
          </SettingsSection>

          <LlmConfigurationSettingsSection
            id="sec-llm"
            form={form}
            set={set}
            setProvider={setProvider}
            selectPresetModel={selectPresetModel}
            providerModelOptions={providerModelOptions}
            selectedPresetModel={selectedPresetModel}
            setTextInitiativeProvider={setTextInitiativeProvider}
            selectTextInitiativePresetModel={selectTextInitiativePresetModel}
            textInitiativeModelOptions={textInitiativeModelOptions}
            selectedTextInitiativePresetModel={selectedTextInitiativePresetModel}
            setReplyFollowupProvider={setReplyFollowupProvider}
            selectReplyFollowupPresetModel={selectReplyFollowupPresetModel}
            replyFollowupModelOptions={replyFollowupModelOptions}
            selectedReplyFollowupPresetModel={selectedReplyFollowupPresetModel}
            setMemoryLlmProvider={setMemoryLlmProvider}
            selectMemoryLlmPresetModel={selectMemoryLlmPresetModel}
            memoryLlmModelOptions={memoryLlmModelOptions}
            selectedMemoryLlmPresetModel={selectedMemoryLlmPresetModel}
          />
          <WebSearchSettingsSection id="sec-search" form={form} set={set} />
          <BrowserSettingsSection
            id="sec-browser"
            form={form}
            set={set}
            setBrowserLlmProvider={setBrowserLlmProvider}
            selectBrowserLlmPresetModel={selectBrowserLlmPresetModel}
            browserLlmModelOptions={browserLlmModelOptions}
            selectedBrowserLlmPresetModel={selectedBrowserLlmPresetModel}
          />
          <CodeAgentSettingsSection
            id="sec-code-agent"
            form={form}
            set={set}
            validationError={codeAgentValidationError}
          />
          <SubAgentOrchestrationSettingsSection id="sec-orchestration" form={form} set={set} />
          <VisionSettingsSection
            id="sec-vision"
            form={form}
            set={set}
            setVisionProvider={setVisionProvider}
            selectVisionPresetModel={selectVisionPresetModel}
            visionModelOptions={visionModelOptions}
            selectedVisionPresetModel={selectedVisionPresetModel}
          />
          <VideoContextSettingsSection id="sec-video" form={form} set={set} />

          <VoiceModeSettingsSection
            id="sec-voice"
            form={form}
            set={set}
            showVoiceSettings={showVoiceSettings}
            isVoiceAgentMode={isVoiceAgentMode}
            isOpenAiRealtimeMode={isOpenAiRealtimeMode}
            isGeminiRealtimeMode={isGeminiRealtimeMode}
            isElevenLabsRealtimeMode={isElevenLabsRealtimeMode}
            setVoiceGenerationProvider={setVoiceGenerationProvider}
            selectVoiceGenerationPresetModel={selectVoiceGenerationPresetModel}
            voiceGenerationModelOptions={voiceGenerationModelOptions}
            selectedVoiceGenerationPresetModel={selectedVoiceGenerationPresetModel}
            setVoiceReplyDecisionProvider={setVoiceReplyDecisionProvider}
            selectVoiceReplyDecisionPresetModel={selectVoiceReplyDecisionPresetModel}
            voiceReplyDecisionModelOptions={voiceReplyDecisionModelOptions}
            selectedVoiceReplyDecisionPresetModel={selectedVoiceReplyDecisionPresetModel}
            xAiVoiceOptions={xAiVoiceOptions}
            openAiRealtimeModelOptions={openAiRealtimeModelOptions}
            openAiRealtimeVoiceOptions={openAiRealtimeVoiceOptions}
            openAiTranscriptionModelOptions={openAiTranscriptionModelOptions}
            geminiRealtimeModelOptions={geminiRealtimeModelOptions}
            setStreamWatchVisionProvider={setStreamWatchVisionProvider}
            selectStreamWatchVisionPresetModel={selectStreamWatchVisionPresetModel}
            streamWatchVisionModelOptions={streamWatchVisionModelOptions}
            selectedStreamWatchVisionPresetModel={selectedStreamWatchVisionPresetModel}
          />

          <RateLimitsSettingsSection id="sec-rate" form={form} set={set} />
          <StartupCatchupSettingsSection id="sec-startup" form={form} set={set} />

          <DiscoverySettingsSection
            id="sec-discovery"
            form={form}
            set={set}
            showDiscoveryFeedControls={showDiscoveryFeedControls}
            showDiscoveryImageControls={showDiscoveryImageControls}
            showDiscoveryVideoControls={showDiscoveryVideoControls}
            discoveryImageModelOptions={discoveryImageModelOptions}
            discoveryVideoModelOptions={discoveryVideoModelOptions}
          />

          <ChannelsPermissionsSettingsSection id="sec-channels" form={form} set={set} />
        </div>
      </div>

      <div className="save-bar">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button type="submit" className="cta" style={{ marginTop: 0, width: "auto", flex: "1 1 auto", minWidth: 0 }}>
            Save settings
            {isDirty && <span className="unsaved-dot" />}
          </button>
          <button
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flex: "0 0 auto",
              marginTop: 0,
              padding: "6px 10px",
              whiteSpace: "nowrap",
              fontSize: "0.76rem",
              fontWeight: 600,
              opacity: refreshRuntimeBusy ? 0.65 : 1,
              cursor: refreshRuntimeBusy ? "not-allowed" : "pointer"
            }}
            onClick={onRefreshRuntime}
            disabled={refreshRuntimeBusy}
            title="Apply current settings to active VC sessions"
            aria-label="Refresh active VC sessions"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10M1 14l5.36 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>{refreshRuntimeBusy ? "Syncing" : "Live"}</span>
          </button>
        </div>
        {toast.text && (
          <p className={`status-msg ${toast.type}`}>{toast.text}</p>
        )}
      </div>
    </form>
  );
}
