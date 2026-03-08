import React, { useState, useEffect, useRef, useMemo } from "react";
import { api, resetSettings } from "../api";
import {
  GEMINI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_VOICE_OPTIONS,
  OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
  XAI_VOICE_OPTIONS,
  applyStackPresetDefaults,
  formToSettingsPatch,
  getCodeAgentValidationError,
  resolveBrowserProviderModelOptions,
  resolveModelOptions,
  resolveModelOptionsFromText,
  resolvePresetModelSelection,
  resolveProviderModelOptions,
  sanitizeAliasListInput,
  settingsToForm,
  settingsToFormPreserving,
  type ResolvedBindings
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

function formatCapabilityPolicy(policy) {
  if (!policy || policy.mode !== "dedicated_model") {
    return "inherit_orchestrator";
  }
  return `${policy.model?.provider || "unknown"}:${policy.model?.model || "default"}`;
}

function formatSessionPolicy(sessionPolicy) {
  if (!sessionPolicy) return "transient";
  return `${sessionPolicy.persistent ? "persistent" : "ephemeral"} (voice=${sessionPolicy.toolPolicy?.voice || "full"}, text=${sessionPolicy.toolPolicy?.text || "full"})`;
}

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
  const defaultForm = useMemo(() => settingsToForm({}), []);
  const effectiveForm = form ?? defaultForm;
  const formRef = useRef(form);
  formRef.current = form;

  useEffect(() => {
    if (!settings) return;
    const next = settingsToFormPreserving(settings, formRef.current);
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
      { id: "sec-discovery", label: "Discovery" },
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

  const resolvedStack = useMemo((): ResolvedBindings["agentStack"] => {
    const r = (settings as Record<string, unknown>)?._resolved as ResolvedBindings | undefined;
    return r?.agentStack || {
      preset: "",
      harness: "",
      orchestrator: { provider: effectiveForm.provider, model: effectiveForm.model },
      researchRuntime: "",
      browserRuntime: "",
      voiceRuntime: "",
      voiceAdmissionPolicy: { mode: "" },
      sessionPolicy: null,
      devTeam: { orchestrator: { provider: "", model: "" }, roles: {}, codingWorkers: [] }
    };
  }, [settings, effectiveForm.provider, effectiveForm.model]);
  const codeAgentValidationError = useMemo(() => getCodeAgentValidationError(effectiveForm), [effectiveForm]);

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
    options: voiceThoughtEngineModelOptions,
    selectedPresetModel: selectedVoiceThoughtEnginePresetModel
  } = resolvePresetSelection("voiceThoughtEngineProvider", "voiceThoughtEngineModel");
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
  const showDiscoveryAdvanced = effectiveForm.discoveryEnabled;
  const showDiscoveryImageControls = effectiveForm.discoveryImageEnabled || effectiveForm.replyImageEnabled;
  const showDiscoveryVideoControls = effectiveForm.discoveryVideoEnabled || effectiveForm.replyVideoEnabled;

  useEffect(() => {
    setForm((current) => {
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
      syncModel("replyFollowupLlmModel", selectedReplyFollowupPresetModel);
      syncModel("memoryLlmModel", selectedMemoryLlmPresetModel);
      syncModel("browserLlmModel", selectedBrowserLlmPresetModel);
      syncModel("visionModel", selectedVisionPresetModel);
      syncModel("voiceGenerationLlmModel", selectedVoiceGenerationPresetModel);
      syncModel("voiceThoughtEngineModel", selectedVoiceThoughtEnginePresetModel);
      syncModel("voiceReplyDecisionLlmModel", selectedVoiceReplyDecisionPresetModel);
      syncModel("voiceStreamWatchBrainContextModel", selectedStreamWatchVisionPresetModel);
      if (next.voiceGenerationLlmUseTextModel) {
        syncModel("voiceGenerationLlmProvider", next.provider);
        syncModel("voiceGenerationLlmModel", selectedPresetModel);
      }
      return changed ? next : current;
    });
  }, [
    selectedPresetModel,
    selectedReplyFollowupPresetModel,
    selectedMemoryLlmPresetModel,
    selectedBrowserLlmPresetModel,
    selectedVoiceGenerationPresetModel,
    selectedVoiceThoughtEnginePresetModel,
    selectedVoiceReplyDecisionPresetModel,
    selectedVisionPresetModel
  ]);

  if (!form) return null;

  function set(key) {
    return (e) => {
      const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (key === "stackPreset") {
        const preset = String(value || "").trim();
        setForm((current) => ({ ...(current || defaultForm), stackPreset: preset }));
        api<Record<string, unknown>>("/api/settings/preset-defaults", {
          method: "POST",
          body: { preset }
        }).then((defaults) => {
          setForm((current) => applyStackPresetDefaults(current || defaultForm, defaults));
        }).catch((err) => {
          console.error("Failed to load preset defaults:", err);
        });
        return;
      }
      setForm((current) => ({ ...current, [key]: value }));
    };
  }

  function sanitizeBotNameAliases() {
    setForm((current) => {
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
    setForm((current) => {
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
  const setMemoryLlmProvider = createProviderSetter("memoryLlmProvider", "memoryLlmModel");
  const setReplyFollowupProvider = createProviderSetter("replyFollowupLlmProvider", "replyFollowupLlmModel");
  const setBrowserLlmProvider = createProviderSetter("browserLlmProvider", "browserLlmModel");
  const setVoiceGenerationProvider = createProviderSetter("voiceGenerationLlmProvider", "voiceGenerationLlmModel");
  const setVoiceThoughtEngineProvider = createProviderSetter("voiceThoughtEngineProvider", "voiceThoughtEngineModel");
  const setVoiceReplyDecisionProvider = createProviderSetter("voiceReplyDecisionLlmProvider", "voiceReplyDecisionLlmModel");
  const setVisionProvider = createProviderSetter("visionProvider", "visionModel");
  const setStreamWatchVisionProvider = createProviderSetter("voiceStreamWatchBrainContextProvider", "voiceStreamWatchBrainContextModel");

  function selectModelFieldPreset(modelField, selected) {
    setForm((current) => ({ ...current, [modelField]: selected }));
  }

  function createPresetSelector(modelField) {
    return (e) => {
      selectModelFieldPreset(modelField, String(e.target.value || ""));
    };
  }

  const selectPresetModel = createPresetSelector("model");
  const selectReplyFollowupPresetModel = createPresetSelector("replyFollowupLlmModel");
  const selectMemoryLlmPresetModel = createPresetSelector("memoryLlmModel");
  const selectBrowserLlmPresetModel = createPresetSelector("browserLlmModel");
  const selectVoiceGenerationPresetModel = createPresetSelector("voiceGenerationLlmModel");
  const selectVoiceThoughtEnginePresetModel = createPresetSelector("voiceThoughtEngineModel");
  const selectVoiceReplyDecisionPresetModel = createPresetSelector("voiceReplyDecisionLlmModel");
  const selectVisionPresetModel = createPresetSelector("visionModel");
  const selectStreamWatchVisionPresetModel = createPresetSelector("voiceStreamWatchBrainContextModel");

  function resetPromptGuidanceFields() {
    setForm((current) => ({
      ...current,
      promptCapabilityHonestyLine: defaultForm.promptCapabilityHonestyLine,
      promptImpossibleActionLine: defaultForm.promptImpossibleActionLine,
      promptMemoryEnabledLine: defaultForm.promptMemoryEnabledLine,
      promptMemoryDisabledLine: defaultForm.promptMemoryDisabledLine,
      promptSkipLine: defaultForm.promptSkipLine,
      promptTextGuidance: defaultForm.promptTextGuidance,
      promptVoiceGuidance: defaultForm.promptVoiceGuidance,
      promptVoiceOperationalGuidance: defaultForm.promptVoiceOperationalGuidance,
      promptVoiceLookupBusySystemPrompt: defaultForm.promptVoiceLookupBusySystemPrompt,
      promptMediaPromptCraftGuidance: defaultForm.promptMediaPromptCraftGuidance
    }));
  }

  function submit(e) {
    e.preventDefault();
    if (codeAgentValidationError) {
      scrollTo("sec-code-agent");
      return;
    }
    onSave(formToSettingsPatch(form));
  }

  async function resetAllSettings() {
    if (!window.confirm("Reset all settings to defaults? This cannot be undone.")) {
      return;
    }
    try {
      const defaults = await resetSettings();
      setForm(settingsToForm(defaults));
      savedFormRef.current = JSON.stringify(settingsToForm(defaults));
    } catch (err) {
      console.error("Failed to reset settings:", err);
    }
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
            <select id="stack-preset" value={form.stackPreset} onChange={set("stackPreset")}>
              <option value="openai_native">OpenAI Native</option>
              <option value="anthropic_brain_openai_tools">Anthropic Brain + OpenAI Hosted Tools</option>
              <option value="claude_oauth_local_tools">Claude OAuth + Local Tools</option>
              <option value="custom">Custom</option>
            </select>

            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.stackAdvancedOverridesEnabled}
                  onChange={set("stackAdvancedOverridesEnabled")}
                />
                Enable advanced stack overrides
              </label>
            </div>

            <p>
              Presets choose the harness, orchestrator, research runtime, browser runtime, voice runtime, and dev-team defaults.
              Advanced overrides expose provider/model and runtime-specific tuning.
            </p>

            <div className="split">
              <div>
                <label>Harness</label>
                <input value={resolvedStack.harness} readOnly />
              </div>
              <div>
                <label>Text / Orchestrator</label>
                <input value={`${resolvedStack.orchestrator.provider}:${resolvedStack.orchestrator.model}`} readOnly />
              </div>
            </div>

            <div className="split">
              <div>
                <label>Research Runtime</label>
                <input value={resolvedStack.researchRuntime} readOnly />
              </div>
              <div>
                <label>Browser Runtime</label>
                <input value={resolvedStack.browserRuntime} readOnly />
              </div>
            </div>

            <div className="split">
              <div>
                <label>Voice Runtime</label>
                <input value={resolvedStack.voiceRuntime} readOnly />
              </div>
              <div>
                <label>Voice Admission</label>
                <input value={resolvedStack.voiceAdmissionPolicy.mode} readOnly />
              </div>
            </div>

            <div>
              <label>Dev Team</label>
              <textarea
                readOnly
                value={[
                  `session: ${formatSessionPolicy(resolvedStack.sessionPolicy)}`,
                  `orchestrator: ${resolvedStack.devTeam.orchestrator.provider}:${resolvedStack.devTeam.orchestrator.model}`,
                  `design: ${formatCapabilityPolicy(resolvedStack.devTeam.roles.design)}`,
                  `implementation: ${formatCapabilityPolicy(resolvedStack.devTeam.roles.implementation)}`,
                  `review: ${formatCapabilityPolicy(resolvedStack.devTeam.roles.review)}`,
                  `research: ${formatCapabilityPolicy(resolvedStack.devTeam.roles.research)}`,
                  `workers: ${resolvedStack.devTeam.codingWorkers.join(", ") || "none"}`
                ].join("\n")}
              />
            </div>
          </SettingsSection>

          {form.stackAdvancedOverridesEnabled && (
            <>
              <LlmConfigurationSettingsSection
                id="sec-llm"
                form={form}
                set={set}
                setProvider={setProvider}
                selectPresetModel={selectPresetModel}
                providerModelOptions={providerModelOptions}
                selectedPresetModel={selectedPresetModel}
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
            </>
          )}
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
            setVoiceThoughtEngineProvider={setVoiceThoughtEngineProvider}
            selectVoiceThoughtEnginePresetModel={selectVoiceThoughtEnginePresetModel}
            voiceThoughtEngineModelOptions={voiceThoughtEngineModelOptions}
            selectedVoiceThoughtEnginePresetModel={selectedVoiceThoughtEnginePresetModel}
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
            showDiscoveryAdvanced={showDiscoveryAdvanced}
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
              background: "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border)"
            }}
            onClick={resetAllSettings}
            title="Reset all settings to defaults"
            aria-label="Reset all settings to defaults"
          >
            Reset defaults
          </button>
        </div>
        {toast.text && (
          <p className={`status-msg ${toast.type}`}>{toast.text}</p>
        )}
      </div>
    </form>
  );
}
