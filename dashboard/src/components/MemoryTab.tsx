import { useState, useEffect } from "react";
import { api } from "../api";
import { FilterPills } from "./ui";
import MemoryRuntimeSnapshot from "./memoryTab/MemoryRuntimeSnapshot";
import MemorySnapshot from "./memoryTab/MemorySnapshot";
import MemorySearch from "./memoryTab/MemorySearch";
import MemoryFactProfiles from "./memoryTab/MemoryFactProfiles";
import MemoryReflections from "./memoryTab/MemoryReflections";
import MemoryInspector from "./memoryTab/MemoryInspector";

const MEMORY_SUB_TABS = ["runtime", "snapshot", "inspector", "profiles", "reflections", "search"] as const;
const MEMORY_SUB_TAB_STORAGE_KEY = "dashboard_memory_sub_tab";

type SubTab = (typeof MEMORY_SUB_TABS)[number];

interface Guild {
  id: string;
  name: string;
}

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void;
  notify: (text: string, type?: string) => void;
}

function loadStoredMemorySubTab(fallback: SubTab): SubTab {
  try {
    const raw = localStorage.getItem(MEMORY_SUB_TAB_STORAGE_KEY);
    if (raw && MEMORY_SUB_TABS.some((tab) => tab === raw)) {
      return raw as SubTab;
    }
  } catch {
    // ignore localStorage failures and fall back to the default tab
  }
  return fallback;
}

function saveStoredMemorySubTab(value: SubTab) {
  try {
    localStorage.setItem(MEMORY_SUB_TAB_STORAGE_KEY, value);
  } catch {
    // ignore localStorage failures
  }
}

function isMemorySubTab(value: string): value is SubTab {
  return MEMORY_SUB_TABS.some((tab) => tab === value);
}

export default function MemoryTab({ markdown, onRefresh, notify }: Props) {
  const [subTab, setSubTab] = useState<SubTab>(() =>
    loadStoredMemorySubTab("runtime")
  );
  const [guilds, setGuilds] = useState<Guild[]>([]);

  useEffect(() => {
    api<Guild[]>("/api/guilds")
      .then((data) => setGuilds(data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    saveStoredMemorySubTab(subTab);
  }, [subTab]);

  return (
    <section className="panel">
      <FilterPills
        items={MEMORY_SUB_TABS}
        active={subTab}
        onChange={(value) => {
          if (isMemorySubTab(value)) {
            setSubTab(value);
          }
        }}
        label={(t) => {
          if (t === "runtime") return "Runtime";
          if (t === "snapshot") return "Summary";
          return t.charAt(0).toUpperCase() + t.slice(1);
        }}
      />
      <div style={{ display: subTab === "runtime" ? undefined : "none" }}>
        <MemoryRuntimeSnapshot guilds={guilds} notify={notify} />
      </div>
      <div style={{ display: subTab === "snapshot" ? undefined : "none" }}>
        <MemorySnapshot markdown={markdown} onRefresh={onRefresh} />
      </div>
      <div style={{ display: subTab === "inspector" ? undefined : "none" }}>
        <MemoryInspector guilds={guilds} onMemoryMutated={onRefresh} />
      </div>
      <div style={{ display: subTab === "reflections" ? undefined : "none" }}>
        <MemoryReflections guilds={guilds} />
      </div>
      <div style={{ display: subTab === "search" ? undefined : "none" }}>
        <MemorySearch guilds={guilds} notify={notify} />
      </div>
      <div style={{ display: subTab === "profiles" ? undefined : "none" }}>
        <MemoryFactProfiles guilds={guilds} notify={notify} />
      </div>
    </section>
  );
}
