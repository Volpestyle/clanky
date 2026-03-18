import { useState, useEffect, useMemo } from "react";
import { api } from "../api";
import { parseUniqueList } from "../../../src/settings/listNormalization.ts";
import { useDashboardGuildScope } from "../guildScope";

type GuildChannel = {
  id: string;
  name: string;
  type: "text" | "voice";
  category: string | null;
};

type ChannelChecklistProps = {
  label: string;
  hint: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  channelType?: "text" | "voice" | "all";
};

export function ChannelChecklist({
  label,
  hint,
  value,
  onChange,
  channelType = "all"
}: ChannelChecklistProps) {
  const { guilds, selectedGuildId } = useDashboardGuildScope();
  const [channels, setChannels] = useState<GuildChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const selectedIds = useMemo(() => new Set(parseUniqueList(value)), [value]);

  useEffect(() => {
    if (!selectedGuildId) return;
    setLoading(true);
    api<GuildChannel[]>(`/api/guilds/${encodeURIComponent(selectedGuildId)}/channels`)
      .then((rows) => setChannels(Array.isArray(rows) ? rows : []))
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  }, [selectedGuildId]);

  const filteredChannels = useMemo(() => {
    let list = channels;
    if (channelType !== "all") list = list.filter((c) => c.type === channelType);
    if (filter) {
      const lower = filter.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          (c.category ?? "").toLowerCase().includes(lower)
      );
    }
    return list;
  }, [channels, channelType, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, GuildChannel[]>();
    for (const ch of filteredChannels) {
      const key = ch.category ?? "Uncategorized";
      const existing = map.get(key);
      if (existing) existing.push(ch);
      else map.set(key, [ch]);
    }
    return map;
  }, [filteredChannels]);

  function toggleChannel(channelId: string) {
    const next = new Set(selectedIds);
    if (next.has(channelId)) next.delete(channelId);
    else next.add(channelId);
    onChange({ target: { value: [...next].join("\n") } });
  }

  function selectAll() {
    const next = new Set(selectedIds);
    for (const ch of filteredChannels) next.add(ch.id);
    onChange({ target: { value: [...next].join("\n") } });
  }

  function deselectAll() {
    const visibleIds = new Set(filteredChannels.map((c) => c.id));
    const next = new Set([...selectedIds].filter((id) => !visibleIds.has(id)));
    onChange({ target: { value: [...next].join("\n") } });
  }

  const prefix = channelType === "voice" ? "🔊" : "#";

  return (
    <div className="channel-checklist">
      <label className="channel-checklist-label">{label}</label>
      <p className="channel-checklist-hint">{hint}</p>

      {guilds.length > 1 && (
        <p className="channel-checklist-scope">
          Showing channels for <strong>{guilds.find((guild) => guild.id === selectedGuildId)?.name || selectedGuildId}</strong>
        </p>
      )}

      <div className="channel-checklist-toolbar">
        <input
          type="text"
          className="channel-checklist-filter"
          placeholder="Filter channels..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="channel-checklist-count">
          {selectedIds.size} selected
        </span>
        <button type="button" className="channel-checklist-btn" onClick={selectAll}>
          All
        </button>
        <button type="button" className="channel-checklist-btn" onClick={deselectAll}>
          None
        </button>
      </div>

      <div className="channel-checklist-list">
        {loading && <div className="channel-checklist-empty">Loading channels...</div>}
        {!loading && filteredChannels.length === 0 && (
          <div className="channel-checklist-empty">
            {channels.length === 0 ? "No channels found" : "No channels match filter"}
          </div>
        )}
        {!loading &&
          [...grouped.entries()].map(([category, items]) => (
            <div key={category} className="channel-checklist-group">
              <div className="channel-checklist-category">{category}</div>
              {items.map((ch) => (
                <label key={ch.id} className="channel-checklist-item">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(ch.id)}
                    onChange={() => toggleChannel(ch.id)}
                  />
                  <span className="channel-checklist-name">
                    {prefix} {ch.name}
                  </span>
                </label>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}
