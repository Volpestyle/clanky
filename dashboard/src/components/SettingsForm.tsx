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
  getSettingsValidationError,
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
import { AGENT_STACK_PRESET_OPTIONS } from "../../../src/settings/agentStackCatalog.ts";
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
  onReloadServerSettings,
  saveBusy = false,
  saveConflictText = "",
  reloadServerSettingsBusy = false,
  refreshRuntimeBusy = false,
  toast
}) {
  const [form, setForm] = useState(() => (settings ? settingsToForm(settings) : null));
  const [presetLoadBusy, setPresetLoadBusy] = useState(false);
  const [presetStatus, setPresetStatus] = useState({ text: "", type: "" });
  const savedFormRef = useRef<string>("");
  const presetRequestIdRef = useRef(0);
  const formRevisionRef = useRef(0);
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
      if (next !== current) {
        formRevisionRef.current += 1;
      }
      formRef.current = next;
      return next;
    });
  }

  function clearPresetWarning() {
    setPresetStatus((current) => (current.type === "warning" ? { text: "", type: "" } : current));
  }

  useEffect(() => {
    if (!settings) return;
    const next = settingsToFormPreserving(settings, formRef.current);
    formRef.current = next;
    setForm(next);
    savedFormRef.current = JSON.stringify(next);
    formRevisionRef.current += 1;
    setPresetStatus({ text: "", type: "" });
  }, [settings]);

  const showAdvancedStackSections = effectiveForm.stackAdvancedOverridesEnabled;

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
    if (showAdvancedStackSections) {
      items.splice(3, 0,
        { id: "sec-llm", label: "Advanced Stack" },
        { id: "sec-search", label: "Research Runtime" },
        { id: "sec-browser", label: "Browser Runtime" },
        { id: "sec-code-agent", label: "Dev Team" },
        { id: "sec-orchestration", label: "Sessions" }
      );
    }
    return items;
  }, [showAdvancedStackSections]);

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);

  const { activeId: activeSection, setClickedId } = useActiveSection(sectionIds);
  const isDirty = useMemo(() => {
    if (!form || !savedFormRef.current) return false;
    return JSON.stringify(form) !== savedFormRef.current;
  }, [form]);
  const codeAgentValidationError = useMemo(() => getCodeAgentValidationError(effectiveForm), [effectiveForm]);
  const validationError = useMemo(() => getSettingsValidationError(effectiveForm), [effectiveForm]);
  const saveDisabled = saveBusy || presetLoadBusy || Boolean(saveConflictText) || Boolean(validationError);
  const applySavedDisabled =
    refreshRuntimeBusy || saveBusy || presetLoadBusy || reloadServerSettingsBusy || isDirty || Boolean(saveConflictText);

  async function loadPresetDefaults(preset: string) {
    const requestId = ++presetRequestIdRef.current;
    const startRevision = formRevisionRef.current;
    setPresetLoadBusy(true);
    setPresetStatus({ text: "Loading preset defaults into the draft…", type: "" });
    try {
      const settings = await api<Record<string, unknown>>("/api/settings/preset-defaults", {
        method: "POST",
        body: { preset }
      });
      if (presetRequestIdRef.current !== requestId) {
        return;
      }
      if (formRevisionRef.current !== startRevision) {
        setPresetStatus({
          text: "Preset defaults loaded, but the draft changed before they could be applied. Review the current draft and try again if you still want a full reset.",
          type: "warning"
        });
        return;
      }
      const next = settingsToForm(settings);
      formRef.current = next;
      setForm(next);
      formRevisionRef.current += 1;
      setPresetStatus({
        text: "Preset defaults loaded into the draft. Save settings to apply them to the bot.",
        type: "ok"
      });
    } catch (err) {
      console.error("Failed to load preset defaults:", err);
      setPresetStatus({
        text: String(err?.message || "Failed to load preset defaults."),
        type: "error"
      });
    } finally {
      setPresetLoadBusy(false);
    }
  }

  function handlePresetDefaultsClick() {
    if (presetLoadBusy) return;
    void loadPresetDefaults(form.stackPreset);
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
    options: voiceMusicBrainModelOptions,
    selectedPresetModel: selectedVoiceMusicBrainPresetModel
  } = resolvePresetSelection("voiceMusicBrainLlmProvider", "voiceMusicBrainLlmModel");
  const {
    options: voiceGenerationModelOptions,
    selectedPresetModel: selectedVoiceGenerationPresetModel
  } = resolvePresetSelection("voiceGenerationLlmProvider", "voiceGenerationLlmModel");
  const {
    options: voiceReplyDecisionModelOptions,
    selectedPresetModel: selectedVoiceReplyDecisionPresetModel
  } = resolvePresetSelection("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const {
    options: voiceInterruptModelOptions,
    selectedPresetModel: selectedVoiceInterruptPresetModel
  } = resolvePresetSelection("voiceInterruptLlmProvider", "voiceInterruptLlmModel");
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
      syncModel("voiceInterruptLlmModel", selectedVoiceInterruptPresetModel);
      syncModel("voiceMusicBrainLlmModel", selectedVoiceMusicBrainPresetModel);
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
    selectedVoiceInterruptPresetModel,
    selectedVoiceMusicBrainPresetModel,
    selectedVisionPresetModel,
    selectedStreamWatchVisionPresetModel
  ]);

  if (!form) return null;

  function set(key) {
    return (e) => {
      clearPresetWarning();
      const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (key === "stackPreset") {
        const preset = String(value || "").trim();
        updateForm((current) => ({ ...(current || defaultForm), stackPreset: preset }));
        setPresetStatus({
          text: "Preset selection changed. Load preset defaults into the draft if you want a full reset.",
          type: ""
        });
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
    clearPresetWarning();
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
  const setVoiceInterruptProvider = createProviderSetter("voiceInterruptLlmProvider", "voiceInterruptLlmModel");
  const setVoiceMusicBrainProvider = createProviderSetter("voiceMusicBrainLlmProvider", "voiceMusicBrainLlmModel");
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
  const selectVoiceInterruptPresetModel = createPresetSelector("voiceInterruptLlmModel");
  const selectVoiceMusicBrainPresetModel = createPresetSelector("voiceMusicBrainLlmModel");
  const selectVisionPresetModel = createPresetSelector("visionModel");
  const selectStreamWatchVisionPresetModel = createPresetSelector("voiceStreamWatchBrainContextModel");

  function resetPromptGuidanceFields() {
    clearPresetWarning();
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
    if (validationError) {
      scrollTo(validationError.sectionId);
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
                {AGENT_STACK_PRESET_OPTIONS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
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
                onClick={handlePresetDefaultsClick}
                disabled={presetLoadBusy}
                title="Load preset defaults into the draft and save to apply them"
              >
                {presetLoadBusy ? "Loading preset…" : "Load preset defaults"}
              </button>
            </div>
            <div className="toggles" style={{ marginTop: 10 }}>
              <label>
                <input
                  type="checkbox"
                  checked={form.stackAdvancedOverridesEnabled}
                  onChange={set("stackAdvancedOverridesEnabled")}
                />
                Customize this preset with advanced stack controls
              </label>
            </div>
            <p className="status-msg" style={{ marginTop: 8 }}>
              Preset changes update the draft only. Save settings to apply them to the bot.
            </p>
            {presetStatus.text && (
              <p className={`status-msg ${presetStatus.type}`} style={{ marginTop: 8 }}>
                {presetStatus.text}
              </p>
            )}
          </SettingsSection>

          {showAdvancedStackSections && (
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
          )}
          {showAdvancedStackSections && <WebSearchSettingsSection id="sec-search" form={form} set={set} />}
          {showAdvancedStackSections && (
            <BrowserSettingsSection
              id="sec-browser"
              form={form}
              set={set}
              setBrowserLlmProvider={setBrowserLlmProvider}
              selectBrowserLlmPresetModel={selectBrowserLlmPresetModel}
              browserLlmModelOptions={browserLlmModelOptions}
              selectedBrowserLlmPresetModel={selectedBrowserLlmPresetModel}
            />
          )}
          {showAdvancedStackSections && (
            <CodeAgentSettingsSection
              id="sec-code-agent"
              form={form}
              set={set}
              validationError={codeAgentValidationError}
            />
          )}
          {showAdvancedStackSections && <SubAgentOrchestrationSettingsSection id="sec-orchestration" form={form} set={set} />}
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
            setVoiceInterruptProvider={setVoiceInterruptProvider}
            selectVoiceInterruptPresetModel={selectVoiceInterruptPresetModel}
            voiceInterruptModelOptions={voiceInterruptModelOptions}
            selectedVoiceInterruptPresetModel={selectedVoiceInterruptPresetModel}
            setVoiceMusicBrainProvider={setVoiceMusicBrainProvider}
            selectVoiceMusicBrainPresetModel={selectVoiceMusicBrainPresetModel}
            voiceMusicBrainModelOptions={voiceMusicBrainModelOptions}
            selectedVoiceMusicBrainPresetModel={selectedVoiceMusicBrainPresetModel}
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
        {saveConflictText && (
          <div style={{ marginBottom: 10 }}>
            <p className="status-msg error" role="status">
              {saveConflictText}
            </p>
            <button
              type="button"
              style={{
                marginTop: 6,
                padding: "6px 10px",
                fontSize: "0.76rem",
                fontWeight: 600
              }}
              onClick={onReloadServerSettings}
              disabled={reloadServerSettingsBusy || saveBusy || presetLoadBusy}
            >
              {reloadServerSettingsBusy ? "Reloading latest settings…" : "Reload latest saved settings"}
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="submit"
            className="cta"
            style={{ marginTop: 0, width: "auto", flex: "1 1 auto", minWidth: 0 }}
            disabled={saveDisabled}
          >
            {saveBusy ? "Saving…" : "Save settings"}
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
              opacity: applySavedDisabled ? 0.65 : 1,
              cursor: applySavedDisabled ? "not-allowed" : "pointer"
            }}
            onClick={onRefreshRuntime}
            disabled={applySavedDisabled}
            title={
              isDirty
                ? "Save settings before applying them to active VC sessions"
                : "Apply the last saved settings to active VC sessions"
            }
            aria-label="Apply saved settings to active VC sessions"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10M1 14l5.36 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            <span>{refreshRuntimeBusy ? "Applying…" : "Apply Saved"}</span>
          </button>
        </div>
        {validationError && !saveConflictText && (
          <p className="status-msg error" role="status">
            {validationError.message}
          </p>
        )}
        {toast.text && (
          <p className={`status-msg ${toast.type}`}>{toast.text}</p>
        )}
      </div>
    </form>
  );
}
