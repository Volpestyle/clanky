import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveIncomingSettingsDraftState,
  settingsToForm,
  type SettingsForm
} from "../settingsFormModel";

type SettingsDraftUpdater =
  | SettingsForm
  | null
  | ((draft: SettingsForm | null) => SettingsForm | null);

type UseSettingsDraftOptions = {
  settings: unknown;
  saveConflictText?: string;
  onReloadServerSettings?: () => void;
  onSavedSettingsApplied?: () => void;
  getFieldNavSection: (field: string) => string;
};

export function applySettingsDraftUpdate(
  current: SettingsForm | null,
  updater: SettingsDraftUpdater
): SettingsForm | null {
  return typeof updater === "function"
    ? updater(current)
    : updater;
}

export function useSettingsDraft({
  settings,
  saveConflictText = "",
  onReloadServerSettings,
  onSavedSettingsApplied,
  getFieldNavSection
}: UseSettingsDraftOptions) {
  const [form, setForm] = useState<SettingsForm | null>(() => (settings ? settingsToForm(settings) : null));
  const [savedForm, setSavedForm] = useState<SettingsForm | null>(() => (settings ? settingsToForm(settings) : null));
  const [pendingServerSettings, setPendingServerSettings] = useState<{
    form: SettingsForm;
    serialized: string;
  } | null>(null);
  const savedFormRef = useRef<string>(form ? JSON.stringify(form) : "");
  const formRevisionRef = useRef(0);
  const defaultForm = useMemo(() => settingsToForm({}), []);
  const effectiveForm = form ?? defaultForm;
  const formRef = useRef<SettingsForm | null>(form);
  formRef.current = form;

  const updateForm = useCallback((updater: SettingsDraftUpdater) => {
    const current = formRef.current;
    const next = applySettingsDraftUpdate(current, updater);
    if (next !== current) {
      formRevisionRef.current += 1;
    }
    formRef.current = next;
    setForm(next);
  }, []);

  const applySavedSettingsForm = useCallback((next: SettingsForm, serialized = JSON.stringify(next)) => {
    formRef.current = next;
    setForm(next);
    setSavedForm(next);
    savedFormRef.current = serialized;
    formRevisionRef.current += 1;
    setPendingServerSettings(null);
    onSavedSettingsApplied?.();
  }, [onSavedSettingsApplied]);

  const loadLatestSavedSettings = useCallback(() => {
    const hadPendingServerSettings = Boolean(pendingServerSettings);
    if (pendingServerSettings) {
      applySavedSettingsForm(pendingServerSettings.form, pendingServerSettings.serialized);
    }
    if (!hadPendingServerSettings || saveConflictText) {
      onReloadServerSettings?.();
    }
  }, [applySavedSettingsForm, onReloadServerSettings, pendingServerSettings, saveConflictText]);

  useEffect(() => {
    if (!settings) return;
    const decision = resolveIncomingSettingsDraftState({
      settings,
      currentForm: formRef.current,
      savedFormSerialized: savedFormRef.current
    });
    if (decision.action === "hold") {
      setPendingServerSettings({
        form: decision.form,
        serialized: decision.serialized
      });
      return;
    }
    if (decision.action === "ignore") {
      setPendingServerSettings((current) => current?.serialized === decision.serialized ? null : current);
      return;
    }
    applySavedSettingsForm(decision.form, decision.serialized);
  }, [applySavedSettingsForm, settings]);

  const isDirty = useMemo(() => {
    if (!form || !savedFormRef.current) return false;
    return JSON.stringify(form) !== savedFormRef.current;
  }, [form]);

  const sectionDirty = useMemo(() => {
    const dirty = new Set<string>();
    if (!form || !savedFormRef.current) return dirty;
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(savedFormRef.current);
    } catch {
      return dirty;
    }
    for (const key of Object.keys(form)) {
      if (JSON.stringify((form as Record<string, unknown>)[key]) !== JSON.stringify(saved[key])) {
        dirty.add(getFieldNavSection(key));
      }
    }
    return dirty;
  }, [form, getFieldNavSection]);

  return {
    form,
    savedForm,
    defaultForm,
    effectiveForm,
    formRef,
    formRevisionRef,
    updateForm,
    loadLatestSavedSettings,
    isDirty,
    sectionDirty,
    hasPendingServerSettings: Boolean(pendingServerSettings)
  };
}
