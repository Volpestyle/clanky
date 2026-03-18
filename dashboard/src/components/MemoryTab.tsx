import { useEffect, useState } from "react";
import { FilterPills } from "./ui";
import MemoryRuntimeSnapshot from "./memoryTab/MemoryRuntimeSnapshot";
import MemorySnapshot from "./memoryTab/MemorySnapshot";
import MemorySearch from "./memoryTab/MemorySearch";
import MemoryFactProfiles from "./memoryTab/MemoryFactProfiles";
import MemoryReflections from "./memoryTab/MemoryReflections";
import MemoryInspector from "./memoryTab/MemoryInspector";
import { loadStoredTab, saveStoredTab } from "../tabState";

const MEMORY_SUB_TABS = ["runtime", "snapshot", "inspector", "profiles", "reflections", "search"] as const;
const MEMORY_SUB_TAB_STORAGE_KEY = "dashboard_memory_sub_tab";

type SubTab = (typeof MEMORY_SUB_TABS)[number];

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void | Promise<void>;
  notify: (text: string, type?: string) => void;
}

function isMemorySubTab(value: string): value is SubTab {
  return MEMORY_SUB_TABS.some((tab) => tab === value);
}

export default function MemoryTab({ markdown, onRefresh, notify }: Props) {
  const [subTab, setSubTab] = useState<SubTab>(() =>
    loadStoredTab(MEMORY_SUB_TAB_STORAGE_KEY, MEMORY_SUB_TABS, "runtime")
  );

  useEffect(() => {
    saveStoredTab(MEMORY_SUB_TAB_STORAGE_KEY, subTab);
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
        <MemoryRuntimeSnapshot notify={notify} />
      </div>
      <div style={{ display: subTab === "snapshot" ? undefined : "none" }}>
        <MemorySnapshot markdown={markdown} onRefresh={onRefresh} />
      </div>
      <div style={{ display: subTab === "inspector" ? undefined : "none" }}>
        <MemoryInspector onMemoryMutated={onRefresh} />
      </div>
      <div style={{ display: subTab === "reflections" ? undefined : "none" }}>
        <MemoryReflections />
      </div>
      <div style={{ display: subTab === "search" ? undefined : "none" }}>
        <MemorySearch notify={notify} />
      </div>
      <div style={{ display: subTab === "profiles" ? undefined : "none" }}>
        <MemoryFactProfiles notify={notify} />
      </div>
    </section>
  );
}
