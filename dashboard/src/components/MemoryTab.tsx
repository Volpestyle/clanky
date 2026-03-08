import { useState, useEffect } from "react";
import { api } from "../api";
import { FilterPills } from "./ui";
import MemorySnapshot from "./memoryTab/MemorySnapshot";
import MemorySearch from "./memoryTab/MemorySearch";
import MemoryFactProfiles from "./memoryTab/MemoryFactProfiles";
import MemoryReflections from "./memoryTab/MemoryReflections";
import MemoryAdaptiveDirectives from "./memoryTab/MemoryAdaptiveDirectives";
import MemoryInspector from "./memoryTab/MemoryInspector";

type SubTab = "snapshot" | "inspector" | "profiles" | "directives" | "reflections" | "search";
const MEMORY_SUB_TABS = ["snapshot", "inspector", "profiles", "directives", "reflections", "search"] as const;

interface Guild {
  id: string;
  name: string;
}

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void;
  notify: (text: string, type?: string) => void;
}

function isMemorySubTab(value: string): value is SubTab {
  return MEMORY_SUB_TABS.some((tab) => tab === value);
}

export default function MemoryTab({ markdown, onRefresh, notify }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("snapshot");
  const [guilds, setGuilds] = useState<Guild[]>([]);

  useEffect(() => {
    api<Guild[]>("/api/guilds")
      .then((data) => setGuilds(data || []))
      .catch(() => {});
  }, []);

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
        label={(t) => t.charAt(0).toUpperCase() + t.slice(1)}
      />
      <div style={{ display: subTab === "snapshot" ? undefined : "none" }}>
        <MemorySnapshot markdown={markdown} onRefresh={onRefresh} />
      </div>
      <div style={{ display: subTab === "inspector" ? undefined : "none" }}>
        <MemoryInspector guilds={guilds} />
      </div>
      <div style={{ display: subTab === "directives" ? undefined : "none" }}>
        <MemoryAdaptiveDirectives guilds={guilds} />
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
