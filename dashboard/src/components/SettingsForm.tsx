import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api } from "../api";
import {
  GEMINI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_MODEL_OPTIONS,
  OPENAI_REALTIME_VOICE_OPTIONS,
  OPENAI_TRANSCRIPTION_MODEL_OPTIONS,
  XAI_VOICE_OPTIONS,
  formToSettingsSnapshot,
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
import { EffectiveRuntimeSummary } from "./EffectiveRuntimeSummary";
import { CoreBehaviorSettingsSection } from "./settingsSections/CoreBehaviorSettingsSection";
import { PromptGuidanceSettingsSection } from "./settingsSections/PromptGuidanceSettingsSection";
import { LlmConfigurationSettingsSection } from "./settingsSections/LlmConfigurationSettingsSection";
import { ResearchBrowsingSettingsSection } from "./settingsSections/ResearchBrowsingSettingsSection";
import { CodeAgentSettingsSection } from "./settingsSections/CodeAgentSettingsSection";
import { VisionSettingsSection } from "./settingsSections/VisionSettingsSection";
import { VideoContextSettingsSection } from "./settingsSections/VideoContextSettingsSection";
import { VoiceModeSettingsSection } from "./settingsSections/VoiceModeSettingsSection";
import { RateLimitsSettingsSection } from "./settingsSections/RateLimitsSettingsSection";
import { StartupCatchupSettingsSection } from "./settingsSections/StartupCatchupSettingsSection";
import { DiscoverySettingsSection } from "./settingsSections/DiscoverySettingsSection";
import { ChannelsPermissionsSettingsSection } from "./settingsSections/ChannelsPermissionsSettingsSection";
import { SubAgentOrchestrationSettingsSection } from "./settingsSections/SubAgentOrchestrationSettingsSection";

const BEHAVIOR_FIELDS = new Set([
  "botName", "botNameAliases", "personaFlavor", "personaHardLimits",
  "textAmbientReplyEagerness", "responseWindowEagerness", "textInitiativeEagerness",
  "reactivity", "allowReplies", "allowUnsolicitedReplies", "allowReactions",
  "memoryEnabled", "automationsEnabled", "textInitiativeEnabled",
  "textInitiativeMinMinutesBetweenPosts", "textInitiativeMaxPostsPerDay",
  "textInitiativeLookbackMessages", "textInitiativeMaxToolSteps",
  "textInitiativeMaxToolCalls", "textInitiativeAllowActiveCuriosity"
]);

const PERMISSIONS_FIELDS = new Set([
  "maxMessages", "maxReactions", "minGap",
  "replyChannels", "discoveryChannels", "allowedChannels", "blockedChannels", "blockedUsers",
  "catchupEnabled", "catchupLookbackHours", "catchupMaxMessages", "catchupMaxReplies"
]);

const BEHAVIOR_PROMPT_FIELDS = new Set([
  "promptTextGuidance", "promptVoiceGuidance", "promptVoiceOperationalGuidance",
  "promptCapabilityHonestyLine", "promptImpossibleActionLine"
]);

function getFieldNavSection(key: string): string {
  if (BEHAVIOR_FIELDS.has(key)) return "sec-behavior";
  if (BEHAVIOR_PROMPT_FIELDS.has(key)) return "sec-behavior";
  if (PERMISSIONS_FIELDS.has(key)) return "sec-perms";
  if (key.startsWith("voice")) return "sec-voice";
  if (key.startsWith("webSearch") || key.startsWith("browser")) return "sec-research";
  if (key.startsWith("vision") || key.startsWith("videoContext") || key.startsWith("discovery") || key.startsWith("replyImage") || key.startsWith("replyVideo") || key === "maxImagesPerDay" || key === "maxVideosPerDay" || key === "maxGifsPerDay") return "sec-media";
  return "sec-advanced";
}

const SECTION_LABELS: Record<string, string> = {
  "sec-behavior": "Behavior",
  "sec-voice": "Voice",
  "sec-research": "Research",
  "sec-media": "Media",
  "sec-perms": "Permissions",
  "sec-advanced": "Advanced"
};

interface SearchEntry {
  label: string;
  scrollTo: string;
  navSection: string;
  keywords: string;
}

const SEARCH_INDEX: SearchEntry[] = [
  { label: "Behavior", scrollTo: "sec-behavior", navSection: "sec-behavior", keywords: "bot name persona aliases eagerness reactivity reactions memory automations ambient text initiative" },
  { label: "Voice Mode", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "voice vc call audio" },
  { label: "Voice Overview", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "voice provider reply path tts streaming pipeline openai xai gemini elevenlabs" },
  { label: "Voice Input", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "asr transcription language whisper speech recognition" },
  { label: "Voice Reply Policy", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "admission gate classifier reply decision eagerness command only interrupts music brain" },
  { label: "Voice Output", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "generation tts temperature tokens voice output brain" },
  { label: "Voice Limits", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "session minutes inactivity max sessions concurrent" },
  { label: "Screen Watch", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "screen watch screen share stream watch frames vision native discord" },
  { label: "Soundboard", scrollTo: "sec-voice", navSection: "sec-voice", keywords: "soundboard sounds external" },
  { label: "Research & Browsing", scrollTo: "sec-research", navSection: "sec-research", keywords: "web search scrape browse browser tools" },
  { label: "Vision", scrollTo: "sec-vision", navSection: "sec-media", keywords: "vision caption image" },
  { label: "Video Context", scrollTo: "sec-video", navSection: "sec-media", keywords: "video transcript keyframe asr" },
  { label: "Initiative Feed & Media", scrollTo: "sec-discovery", navSection: "sec-media", keywords: "discovery feed image generation video gif" },
  { label: "Channels & Permissions", scrollTo: "sec-channels", navSection: "sec-perms", keywords: "channels allowed blocked users permissions reply" },
  { label: "Rate Limits", scrollTo: "sec-rate", navSection: "sec-perms", keywords: "rate limit messages reactions per hour gap" },
  { label: "Startup Catch-up", scrollTo: "sec-startup", navSection: "sec-perms", keywords: "startup catchup lookback" },
  { label: "Stack Preset", scrollTo: "sec-stack", navSection: "sec-advanced", keywords: "preset stack defaults agent" },
  { label: "Prompt Lab", scrollTo: "sec-prompts", navSection: "sec-advanced", keywords: "prompt guidance capability honesty impossible action memory skip text voice media" },
  { label: "Text LLM", scrollTo: "sec-llm", navSection: "sec-advanced", keywords: "llm provider model temperature tokens followup" },
  { label: "Code Agent", scrollTo: "sec-code-agent", navSection: "sec-advanced", keywords: "code agent codex claude dev team" },
  { label: "Sub-Agent Orchestration", scrollTo: "sec-orchestration", navSection: "sec-advanced", keywords: "orchestration sub agent session" }
];

function buildImpactSummary(dirty: Set<string>): string {
  if (dirty.size === 0) return "";
  const labels = Array.from(dirty)
    .map((id) => SECTION_LABELS[id])
    .filter(Boolean);
  if (labels.length === 0) return "";
  const changed = labels.join(", ");
  const voiceAffected = dirty.has("sec-voice");
  return voiceAffected
    ? `${changed} changed. Save and apply to update active voice sessions.`
    : `${changed} changed. Save to apply.`;
}

export function applyFormDraftUpdate<T>(
  current: T,
  updater: T | ((draft: T) => T)
): T {
  return typeof updater === "function"
    ? (updater as (draft: T) => T)(current)
    : updater;
}

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
  const [savedForm, setSavedForm] = useState(() => (settings ? settingsToForm(settings) : null));
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
    const current = formRef.current;
    const next = applyFormDraftUpdate(current, updater);
    if (next !== current) {
      formRevisionRef.current += 1;
    }
    formRef.current = next;
    setForm(next);
  }

  function clearPresetWarning() {
    setPresetStatus((current) => (current.type === "warning" ? { text: "", type: "" } : current));
  }

  useEffect(() => {
    if (!settings) return;
    const next = settingsToFormPreserving(settings, formRef.current);
    formRef.current = next;
    setForm(next);
    setSavedForm(next);
    savedFormRef.current = JSON.stringify(next);
    formRevisionRef.current += 1;
    setPresetStatus({ text: "", type: "" });
  }, [settings]);

  const [sidebarSearch, setSidebarSearch] = useState("");
  const [searchHighlight, setSearchHighlight] = useState(0);
  const searchResults = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return [];
    return SEARCH_INDEX.filter(
      (entry) => entry.label.toLowerCase().includes(q) || entry.keywords.includes(q)
    );
  }, [sidebarSearch]);

  const showAdvancedStackSections = effectiveForm.stackAdvancedOverridesEnabled;

  const sections = useMemo(() => [
    { id: "sec-behavior", label: "Behavior" },
    { id: "sec-voice", label: "Voice" },
    { id: "sec-research", label: "Research" },
    { id: "sec-media", label: "Media" },
    { id: "sec-perms", label: "Permissions" },
    { id: "sec-advanced", label: "Advanced" }
  ], []);

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);

  const { activeId: activeSection, setClickedId } = useActiveSection(sectionIds);

  const handleSearchSelect = useCallback((entry: SearchEntry) => {
    setSidebarSearch("");
    setClickedId(entry.navSection);
    document.getElementById(entry.scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [setClickedId]);

  /* Map validation sectionIds to nav groups for sidebar indicators */
  const VALIDATION_SECTION_MAP: Record<string, string> = {
    "sec-core": "sec-behavior",
    "sec-browser": "sec-research",
    "sec-search": "sec-research",
    "sec-rate": "sec-perms",
    "sec-startup": "sec-perms",
    "sec-channels": "sec-perms",
    "sec-llm": "sec-advanced",
    "sec-code-agent": "sec-advanced",
    "sec-orchestration": "sec-advanced",
    "sec-stack": "sec-advanced",
    "sec-prompts": "sec-advanced",
    "sec-vision": "sec-media",
    "sec-video": "sec-media",
    "sec-discovery": "sec-media"
  };

  const isDirty = useMemo(() => {
    if (!form || !savedFormRef.current) return false;
    return JSON.stringify(form) !== savedFormRef.current;
  }, [form]);

  const sectionDirty = useMemo(() => {
    const dirty = new Set<string>();
    if (!form || !savedFormRef.current) return dirty;
    let saved: Record<string, unknown>;
    try { saved = JSON.parse(savedFormRef.current); } catch { return dirty; }
    for (const key of Object.keys(form)) {
      if (JSON.stringify((form as Record<string, unknown>)[key]) !== JSON.stringify(saved[key])) {
        dirty.add(getFieldNavSection(key));
      }
    }
    return dirty;
  }, [form]);

  const codeAgentValidationError = useMemo(() => getCodeAgentValidationError(effectiveForm), [effectiveForm]);
  const validationError = useMemo(() => getSettingsValidationError(effectiveForm), [effectiveForm]);
  const sectionErrors = useMemo(() => {
    const errors = new Set<string>();
    if (codeAgentValidationError) errors.add("sec-advanced");
    if (validationError?.sectionId) {
      const mapped = VALIDATION_SECTION_MAP[validationError.sectionId] || validationError.sectionId;
      errors.add(mapped);
    }
    return errors;
  }, [validationError, codeAgentValidationError]);

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
    options: streamWatchNoteModelOptions,
    selectedPresetModel: selectedStreamWatchNotePresetModel
  } = resolvePresetSelection("voiceStreamWatchNoteProvider", "voiceStreamWatchNoteModel");
  const {
    options: streamWatchCommentaryModelOptions,
    selectedPresetModel: selectedStreamWatchCommentaryPresetModel
  } = resolvePresetSelection("voiceStreamWatchCommentaryProvider", "voiceStreamWatchCommentaryModel");
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
      syncModel("voiceStreamWatchNoteModel", selectedStreamWatchNotePresetModel);
      syncModel("voiceStreamWatchCommentaryModel", selectedStreamWatchCommentaryPresetModel);
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
    selectedStreamWatchNotePresetModel,
    selectedStreamWatchCommentaryPresetModel
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
  const setStreamWatchNoteProvider = createProviderSetter("voiceStreamWatchNoteProvider", "voiceStreamWatchNoteModel");
  const setStreamWatchCommentaryProvider = createProviderSetter("voiceStreamWatchCommentaryProvider", "voiceStreamWatchCommentaryModel");

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
  const selectStreamWatchNotePresetModel = createPresetSelector("voiceStreamWatchNoteModel");
  const selectStreamWatchCommentaryPresetModel = createPresetSelector("voiceStreamWatchCommentaryModel");

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

  function applyOverlayFields(fields: Record<string, string>) {
    clearPresetWarning();
    updateForm((current) => ({ ...current, ...fields }));
  }

  function submit(e) {
    e.preventDefault();
    if (validationError) {
      scrollTo(validationError.sectionId);
      return;
    }
    const currentForm = formRef.current ?? form ?? defaultForm;
    onSave(formToSettingsSnapshot(currentForm));
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
          <div className="sidebar-search-wrap">
            <input
              type="text"
              className="sidebar-search"
              placeholder="Jump to…"
              value={sidebarSearch}
              onChange={(e) => { setSidebarSearch(e.target.value); setSearchHighlight(0); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setSidebarSearch(""); return; }
                if (searchResults.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSearchHighlight((i) => Math.min(i + 1, searchResults.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSearchHighlight((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearchSelect(searchResults[searchHighlight] || searchResults[0]);
                }
              }}
            />
            {searchResults.length > 0 && (
              <div className="sidebar-search-results" role="listbox">
                {searchResults.map((entry, i) => (
                  <button
                    key={entry.scrollTo + entry.label}
                    type="button"
                    role="option"
                    aria-selected={i === searchHighlight}
                    className={`sidebar-search-result${i === searchHighlight ? " highlighted" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); handleSearchSelect(entry); }}
                    onMouseEnter={() => setSearchHighlight(i)}
                  >
                    <span className="sidebar-search-result-label">{entry.label}</span>
                    <span className="sidebar-search-result-section">{SECTION_LABELS[entry.navSection]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${activeSection === s.id ? " active" : ""}`}
              onClick={() => scrollTo(s.id)}
            >
              {s.label}
              {sectionErrors.has(s.id) && <span className="nav-error-dot" />}
              {!sectionErrors.has(s.id) && sectionDirty.has(s.id) && <span className="nav-dirty-dot" />}
            </button>
          ))}
        </nav>

        <div className="settings-content" style={{ paddingBottom: "60vh" }}>
          {/* ── Effective Runtime Summary ── */}
          <EffectiveRuntimeSummary form={effectiveForm} />

          {/* ── Behavior ── */}
          <CoreBehaviorSettingsSection
            id="sec-behavior"
            form={form}
            savedForm={savedForm}
            set={set}
            onSanitizeBotNameAliases={sanitizeBotNameAliases}
            onApplyOverlay={applyOverlayFields}
          />

          {/* ── Voice ── */}
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
            setStreamWatchNoteProvider={setStreamWatchNoteProvider}
            selectStreamWatchNotePresetModel={selectStreamWatchNotePresetModel}
            streamWatchNoteModelOptions={streamWatchNoteModelOptions}
            selectedStreamWatchNotePresetModel={selectedStreamWatchNotePresetModel}
            setStreamWatchCommentaryProvider={setStreamWatchCommentaryProvider}
            selectStreamWatchCommentaryPresetModel={selectStreamWatchCommentaryPresetModel}
            streamWatchCommentaryModelOptions={streamWatchCommentaryModelOptions}
            selectedStreamWatchCommentaryPresetModel={selectedStreamWatchCommentaryPresetModel}
          />

          {/* ── Research & Browsing ── */}
          <ResearchBrowsingSettingsSection
            id="sec-research"
            form={form}
            set={set}
            setBrowserLlmProvider={setBrowserLlmProvider}
            selectBrowserLlmPresetModel={selectBrowserLlmPresetModel}
            browserLlmModelOptions={browserLlmModelOptions}
            selectedBrowserLlmPresetModel={selectedBrowserLlmPresetModel}
          />

          {/* ── Media ── */}
          <div id="sec-media" className="section-group">
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
          </div>

          {/* ── Permissions ── */}
          <div id="sec-perms" className="section-group">
            <ChannelsPermissionsSettingsSection id="sec-channels" form={form} set={set} />
            <RateLimitsSettingsSection id="sec-rate" form={form} set={set} />
            <StartupCatchupSettingsSection id="sec-startup" form={form} set={set} />
          </div>

          {/* ── Advanced ── */}
          <div id="sec-advanced" className="section-group">
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
                  {presetLoadBusy ? "Loading preset\u2026" : "Load preset defaults"}
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

            <PromptGuidanceSettingsSection
              id="sec-prompts"
              form={form}
              set={set}
              onResetPromptGuidance={resetPromptGuidanceFields}
            />

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
            {showAdvancedStackSections && (
              <CodeAgentSettingsSection
                id="sec-code-agent"
                form={form}
                set={set}
                validationError={codeAgentValidationError}
              />
            )}
            {showAdvancedStackSections && <SubAgentOrchestrationSettingsSection id="sec-orchestration" form={form} set={set} />}
          </div>
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
              {reloadServerSettingsBusy ? "Reloading latest settings\u2026" : "Reload latest saved settings"}
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
            {saveBusy ? "Saving\u2026" : "Save settings"}
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
            <span>{refreshRuntimeBusy ? "Applying\u2026" : "Apply Saved"}</span>
          </button>
        </div>
        {isDirty && !saveConflictText && !validationError && (
          <div className="save-bar-summary">
            {buildImpactSummary(sectionDirty)}
          </div>
        )}
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
