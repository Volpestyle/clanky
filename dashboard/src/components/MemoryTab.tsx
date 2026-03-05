import { useState, useEffect } from "react";
import { api } from "../api";
import MemorySnapshot from "./memoryTab/MemorySnapshot";
import MemorySearch from "./memoryTab/MemorySearch";
import MemorySimulator from "./memoryTab/MemorySimulator";
import MemoryReflections from "./memoryTab/MemoryReflections";
import MemoryAdaptiveDirectives from "./memoryTab/MemoryAdaptiveDirectives";

type SubTab = "snapshot" | "directives" | "reflections" | "search" | "simulator";

interface Guild {
  id: string;
  name: string;
}

interface Props {
  markdown: string | null | undefined;
  onRefresh: () => void;
  notify: (text: string, type?: string) => void;
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
      <div className="filter-pills" style={{ marginBottom: 14 }}>
        <button
          className={`filter-pill${subTab === "snapshot" ? " active" : ""}`}
          onClick={() => setSubTab("snapshot")}
        >
          Snapshot
        </button>
        <button
          className={`filter-pill${subTab === "directives" ? " active" : ""}`}
          onClick={() => setSubTab("directives")}
        >
          Directives
        </button>
        <button
          className={`filter-pill${subTab === "reflections" ? " active" : ""}`}
          onClick={() => setSubTab("reflections")}
        >
          Reflections
        </button>
        <button
          className={`filter-pill${subTab === "search" ? " active" : ""}`}
          onClick={() => setSubTab("search")}
        >
          Search
        </button>
        <button
          className={`filter-pill${subTab === "simulator" ? " active" : ""}`}
          onClick={() => setSubTab("simulator")}
        >
          Simulator
        </button>
      </div>
      <div style={{ display: subTab === "snapshot" ? undefined : "none" }}>
        <MemorySnapshot markdown={markdown} onRefresh={onRefresh} />
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
      <div style={{ display: subTab === "simulator" ? undefined : "none" }}>
        <MemorySimulator guilds={guilds} notify={notify} />
      </div>
    </section>
  );
}
