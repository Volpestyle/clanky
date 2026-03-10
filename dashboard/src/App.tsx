import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense, type ReactNode } from "react";
import { api, ApiError, getDashboardAuthState, type DashboardAuthState } from "./api";
import { usePolling } from "./hooks/usePolling";
import { useActivitySSE } from "./hooks/useActivitySSE";
import Header from "./components/Header";
import MetricsBar from "./components/MetricsBar";
import ActionStream from "./components/ActionStream";
import DailyCost from "./components/DailyCost";
import PerformancePanel from "./components/PerformancePanel";
import StaleIndicator from "./components/StaleIndicator";
import { loadStoredTab, saveStoredTab } from "./tabState";

const SettingsForm = lazy(() => import("./components/SettingsForm"));
const MemoryTab = lazy(() => import("./components/MemoryTab"));
const VoiceMonitor = lazy(() => import("./components/VoiceMonitor"));
const TextTab = lazy(() => import("./components/TextTab"));
const AgentsTab = lazy(() => import("./components/AgentsTab"));

const MAIN_TAB_IDS = ["activity", "text", "agents", "memory", "voice", "settings"] as const;
const MAIN_TAB_STORAGE_KEY = "dashboard_main_tab";

type MainTab = (typeof MAIN_TAB_IDS)[number];

interface MainTabDefinition {
  id: MainTab;
  label: string;
  icon: ReactNode;
}

const MAIN_TABS: MainTabDefinition[] = [
  {
    id: "activity",
    label: "Activity",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    )
  },
  {
    id: "text",
    label: "Text",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    )
  },
  {
    id: "agents",
    label: "Agents",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    )
  },
  {
    id: "memory",
    label: "Memory",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
        <line x1="10" y1="22" x2="14" y2="22" />
      </svg>
    )
  },
  {
    id: "voice",
    label: "Voice",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    )
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }
];

export default function App() {
  const auth = usePolling(() => getDashboardAuthState(), 0);
  const authState = (auth.data as DashboardAuthState | null) || null;
  const refreshAuth = useCallback(async () => {
    await auth.reload();
  }, [auth.reload]);

  if (!authState) {
    return (
      <main className="shell">
        <Header authState={null} onAuthChanged={refreshAuth} />
        <section className="grid-secondary">
          <p className="status-msg" role="status">
            Checking dashboard session...
          </p>
        </section>
      </main>
    );
  }

  if (authState.requiresToken && !authState.authenticated) {
    const lockMessage = authState.configurationError
      ? `Dashboard auth is misconfigured: ${authState.configurationError}`
      : "Enter the dashboard token in the header to unlock the control room.";

    return (
      <main className="shell">
        <Header authState={authState} onAuthChanged={refreshAuth} />
        <section className="grid-secondary">
          <p className={`status-msg ${authState.configurationError ? "error" : ""}`} role="status">
            {lockMessage}
          </p>
        </section>
      </main>
    );
  }

  return <AuthenticatedDashboard authState={authState} onAuthChanged={refreshAuth} />;
}

function AuthenticatedDashboard({
  authState,
  onAuthChanged
}: {
  authState: DashboardAuthState;
  onAuthChanged: () => Promise<void>;
}) {
  const initialTabRef = useRef<MainTab | null>(null);
  if (initialTabRef.current === null) {
    initialTabRef.current = loadStoredTab(MAIN_TAB_STORAGE_KEY, MAIN_TAB_IDS, "activity");
  }

  const [toast, setToast] = useState({ text: "", type: "" });
  const [tab, setTab] = useState<MainTab>(initialTabRef.current ?? "activity");
  const [settingsSaveBusy, setSettingsSaveBusy] = useState(false);
  const [settingsRefreshBusy, setSettingsRefreshBusy] = useState(false);
  const [settingsReloadBusy, setSettingsReloadBusy] = useState(false);
  const [settingsConflict, setSettingsConflict] = useState("");
  const [settingsMounted, setSettingsMounted] = useState((initialTabRef.current ?? "activity") === "settings");

  useEffect(() => {
    saveStoredTab(MAIN_TAB_STORAGE_KEY, tab);
  }, [tab]);

  useEffect(() => {
    if (tab === "settings" && !settingsMounted) {
      setSettingsMounted(true);
    }
  }, [settingsMounted, tab]);

  const notify = useCallback((text, type = "ok") => {
    setToast({ text, type });
    setTimeout(() => setToast({ text: "", type: "" }), 4000);
  }, []);

  const activity = useActivitySSE();
  const textActions = usePolling(
    () => api("/api/actions?kinds=sent_reply,sent_message&sinceHours=24&limit=1000"),
    30_000
  );
  const memory = usePolling(() => api("/api/memory"), 30_000);
  const settings = usePolling(() => api("/api/settings"), 0);
  const llmModels = usePolling(() => api("/api/llm/models"), 0);
  const reloadMemory = memory.reload;
  const reloadSettings = settings.reload;
  const settingsUpdatedAt = String(settings.data?._meta?.updatedAt || "").trim();

  const handleSettingsSave = useCallback(async (patch) => {
    setSettingsSaveBusy(true);
    try {
      const requestBody = settingsUpdatedAt
        ? {
            ...patch,
            _meta: {
              expectedUpdatedAt: settingsUpdatedAt
            }
          }
        : patch;
      const result = await api<{
        _meta?: {
          saveAppliedToRuntime?: boolean;
          saveApplyError?: string;
        };
      }>("/api/settings", { method: "PUT", body: requestBody });
      await reloadSettings();
      setSettingsConflict("");
      if (result?._meta?.saveAppliedToRuntime === false) {
        const applyError = String(result?._meta?.saveApplyError || "").trim();
        notify(
          applyError
            ? `Settings saved, but active sessions were not synced: ${applyError}`
            : "Settings saved, but active sessions were not synced.",
          "error"
        );
      } else {
        notify("Settings saved");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const errorBody =
          typeof err.body === "object" && err.body !== null
            ? err.body as Record<string, unknown>
            : null;
        const detail = String(
          (errorBody?.detail || "") ||
          "Settings changed elsewhere. Reload the latest values before saving again."
        ).trim();
        setSettingsConflict(detail);
        notify(detail, "error");
        return;
      }
      notify(err.message, "error");
    } finally {
      setSettingsSaveBusy(false);
    }
  }, [notify, reloadSettings, settingsUpdatedAt]);

  const handleSettingsConflictReload = useCallback(async () => {
    setSettingsReloadBusy(true);
    try {
      await reloadSettings();
      setSettingsConflict("");
      notify("Reloaded the latest saved settings");
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setSettingsReloadBusy(false);
    }
  }, [notify, reloadSettings]);

  const handleMemoryRefresh = useCallback(async () => {
    try {
      await api("/api/memory/refresh", { method: "POST" });
      reloadMemory();
      notify("Memory regenerated");
    } catch (err) {
      notify(err.message, "error");
    }
  }, [reloadMemory, notify]);

  const handleSettingsRefresh = useCallback(async () => {
    setSettingsRefreshBusy(true);
    try {
      const result = await api<{ ok?: boolean; activeVoiceSessions?: number }>("/api/settings/refresh", {
        method: "POST"
      });
      const activeVoiceSessions = Math.max(0, Number(result?.activeVoiceSessions) || 0);
      if (activeVoiceSessions > 0) {
        notify(
          activeVoiceSessions === 1
            ? "Applied settings to 1 active VC session"
            : `Applied settings to ${activeVoiceSessions} active VC sessions`
        );
      } else {
        notify("Settings refreshed (no active VC sessions)");
      }
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setSettingsRefreshBusy(false);
    }
  }, [notify]);

  const isReady = activity.stats?.runtime?.isReady ?? false;
  const mergedTextActions = useMemo(() => {
    const persisted = Array.isArray(textActions.data) ? textActions.data : [];
    const live = Array.isArray(activity.actions)
      ? activity.actions.filter((action) => action?.kind === "sent_reply" || action?.kind === "sent_message")
      : [];
    const merged = new Map<string, Record<string, unknown>>();

    for (const action of [...live, ...persisted]) {
      const actionId = Number(action?.id || 0);
      const key = actionId > 0
        ? `id:${actionId}`
        : `${String(action?.created_at || "")}:${String(action?.message_id || "")}:${String(action?.kind || "")}`;
      if (!merged.has(key)) {
        merged.set(key, action);
      }
    }

    return [...merged.values()].sort((a, b) => {
      const aTime = Date.parse(String(a?.created_at || ""));
      const bTime = Date.parse(String(b?.created_at || ""));
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
  }, [activity.actions, textActions.data]);

  return (
    <main className="shell">
      <Header isReady={isReady} authState={authState} onAuthChanged={onAuthChanged} />

      <MetricsBar stats={activity.stats} />
      <StaleIndicator lastSuccess={activity.lastSuccess} />

      <nav className="main-tabs" role="tablist">
        {MAIN_TABS.map((mainTab) => (
          <button
            key={mainTab.id}
            role="tab"
            aria-selected={tab === mainTab.id}
            className={`main-tab${tab === mainTab.id ? " active" : ""}`}
            onClick={() => setTab(mainTab.id)}
          >
            <span className="main-tab-icon">{mainTab.icon}</span>
            {mainTab.label}
          </button>
        ))}
      </nav>

      {tab === "activity" && (
        <section className="grid-secondary">
          {toast.text && (
            <p className={`status-msg activity-status-msg ${toast.type}`} role="status" aria-live="polite">
              {toast.text}
            </p>
          )}
          <ActionStream actions={activity.actions} />
          <div className="stack">
            <PerformancePanel performance={activity.stats?.stats?.performance} />
            <DailyCost rows={activity.stats?.stats?.dailyCost} />
          </div>
        </section>
      )}

      <Suspense>
        {tab === "text" && <TextTab actions={mergedTextActions} />}

        {tab === "agents" && <AgentsTab />}

        {tab === "voice" && <VoiceMonitor />}

        {tab === "memory" && (
          <MemoryTab
            markdown={memory.data?.markdown}
            onRefresh={handleMemoryRefresh}
            notify={notify}
          />
        )}

        {settingsMounted && (
          <section className={tab === "settings" ? "" : "tab-panel-hidden"} aria-hidden={tab !== "settings"}>
            <SettingsForm
              settings={settings.data}
              modelCatalog={llmModels.data}
              onSave={handleSettingsSave}
              onRefreshRuntime={handleSettingsRefresh}
              onReloadServerSettings={handleSettingsConflictReload}
              saveBusy={settingsSaveBusy}
              saveConflictText={settingsConflict}
              reloadServerSettingsBusy={settingsReloadBusy}
              refreshRuntimeBusy={settingsRefreshBusy}
              toast={toast}
            />
          </section>
        )}
      </Suspense>
    </main>
  );
}
