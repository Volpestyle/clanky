import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";
import { rangeStyle } from "../../utils";

type KnownIdentity = {
  mcUsername: string;
  discordUsername: string;
  label: string;
  relationship: string;
  notes: string;
};

function emptyIdentity(): KnownIdentity {
  return { mcUsername: "", discordUsername: "", label: "", relationship: "", notes: "" };
}

export function MinecraftSettingsSection({
  id,
  form,
  set
}: {
  id: string;
  form: Record<string, unknown>;
  set: (key: string) => (e: unknown) => void;
}) {
  const enabled = Boolean(form.minecraftEnabled);
  const useTextModel = Boolean(form.minecraftBrainUseTextModel);
  const narrationEagerness = Number(form.minecraftNarrationEagerness) || 0;
  const knownIdentities: KnownIdentity[] = Array.isArray(form.minecraftKnownIdentities)
    ? (form.minecraftKnownIdentities as KnownIdentity[])
    : [];
  const setKnownIdentities = (next: KnownIdentity[]) => {
    set("minecraftKnownIdentities")({ target: { value: next } });
  };

  const updateIdentity = (index: number, field: keyof KnownIdentity, value: string) => {
    const next = knownIdentities.map((entry, i) =>
      i === index ? { ...entry, [field]: value } : entry
    );
    setKnownIdentities(next);
  };

  const addIdentity = () => {
    setKnownIdentities([...knownIdentities, emptyIdentity()]);
  };

  const removeIdentity = (index: number) => {
    setKnownIdentities(knownIdentities.filter((_, i) => i !== index));
  };

  return (
    <SettingsSection id={id} title="Minecraft Agent" active={enabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={set("minecraftEnabled")}
          />
          Enable Minecraft agent
        </label>
      </div>

      <p className="status-msg" style={{ marginTop: 0, marginBottom: 12 }}>
        When enabled, the bot auto-spawns a Minecraft MCP server and exposes
        the <code>minecraft_task</code> tool on both text and voice surfaces.
        Those surfaces feed the same embodied Minecraft session brain once it is
        active. Set an explicit MCP URL to connect to an external server instead.
      </p>

      {enabled && (
        <>
          <div className="field">
            <label>MCP server URL</label>
            <input
              type="text"
              value={String(form.minecraftMcpUrl || "")}
              onChange={set("minecraftMcpUrl")}
              placeholder="Leave empty to auto-spawn (default: http://127.0.0.1:3847)"
            />
            <p className="status-msg">
              Leave blank to auto-spawn the bundled MCP server. Set a URL to
              connect to a remote or manually started server.
            </p>
          </div>

          <div className="field">
            <label>Known identities (optional)</label>
            <p className="status-msg" style={{ marginTop: 0, marginBottom: 8 }}>
              Optional Discord↔Minecraft address book. Empty is a first-class
              mode — Clanky forms impressions about every MC player organically
              from chat, behavior, and memory. Populated entries are background
              context, not a permission list. Anyone NOT listed is still worth
              engaging with.
            </p>
            {knownIdentities.length === 0 && (
              <p className="status-msg" style={{ marginTop: 0, marginBottom: 8, fontStyle: "italic" }}>
                No identities configured. Clanky will treat every MC player as
                a peer.
              </p>
            )}
            {knownIdentities.map((entry, index) => (
              <div
                key={index}
                style={{
                  border: "1px solid var(--border, #333)",
                  borderRadius: 4,
                  padding: 8,
                  marginBottom: 8
                }}
              >
                <div className="split" style={{ gap: 8 }}>
                  <div>
                    <label>MC username (required)</label>
                    <input
                      type="text"
                      value={entry.mcUsername}
                      onChange={(e) => updateIdentity(index, "mcUsername", (e.target as HTMLInputElement).value)}
                      placeholder="e.g. Volpestyle"
                    />
                  </div>
                  <div>
                    <label>Discord username</label>
                    <input
                      type="text"
                      value={entry.discordUsername}
                      onChange={(e) => updateIdentity(index, "discordUsername", (e.target as HTMLInputElement).value)}
                      placeholder="e.g. volpestyle"
                    />
                  </div>
                </div>
                <div className="split" style={{ gap: 8, marginTop: 8 }}>
                  <div>
                    <label>Label</label>
                    <input
                      type="text"
                      value={entry.label}
                      onChange={(e) => updateIdentity(index, "label", (e.target as HTMLInputElement).value)}
                      placeholder="e.g. Volpe"
                    />
                  </div>
                  <div>
                    <label>Relationship</label>
                    <input
                      type="text"
                      value={entry.relationship}
                      onChange={(e) => updateIdentity(index, "relationship", (e.target as HTMLInputElement).value)}
                      placeholder="e.g. operator, trusted collab, friend"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <label>Notes</label>
                  <input
                    type="text"
                    value={entry.notes}
                    onChange={(e) => updateIdentity(index, "notes", (e.target as HTMLInputElement).value)}
                    placeholder="e.g. plays weekends, likes redstone"
                  />
                </div>
                <div style={{ marginTop: 8, textAlign: "right" }}>
                  <button type="button" onClick={() => removeIdentity(index)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={addIdentity}>
              Add identity
            </button>
          </div>

          <label htmlFor="minecraft-narration-eagerness">
            Proactive narration eagerness: <strong>{narrationEagerness}%</strong>
          </label>
          <input
            id="minecraft-narration-eagerness"
            type="range"
            min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.minecraft.narration.eagerness.min}
            max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.minecraft.narration.eagerness.max}
            step="1"
            value={narrationEagerness}
            onChange={set("minecraftNarrationEagerness")}
            style={rangeStyle(narrationEagerness)}
          />
          <p className="status-msg">
            Cost gate that shortlists significant in-world events (deaths, combat,
            player joins/leaves, first-time major finds) before the model decides
            whether to post to the owning Discord channel. Higher widens the
            filter; the model can still <code>[SKIP]</code>.
          </p>

          <div className="field">
            <label htmlFor="minecraft-narration-min-gap">
              Minimum seconds between narration posts
            </label>
            <input
              id="minecraft-narration-min-gap"
              type="number"
              min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.minecraft.narration.minSecondsBetweenPosts.min}
              max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.minecraft.narration.minSecondsBetweenPosts.max}
              value={Number(form.minecraftNarrationMinSecondsBetweenPosts) || 0}
              onChange={set("minecraftNarrationMinSecondsBetweenPosts")}
            />
            <p className="status-msg">
              Per-channel cooldown between narration attempts (including SKIPs).
              Prevents rapid-fire posts when several significant events fire close
              together.
            </p>
          </div>

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={useTextModel}
                onChange={set("minecraftBrainUseTextModel")}
              />
              Use the main text model for the Minecraft brain
            </label>
          </div>
          <div className="split">
            <div>
              <label>Minecraft brain provider</label>
              <select
                value={String(form.minecraftBrainLlmProvider || "")}
                onChange={set("minecraftBrainLlmProvider")}
                disabled={useTextModel}
              >
                <LlmProviderOptions />
              </select>
            </div>
            <div>
              <label>Minecraft brain model ID</label>
              <input
                type="text"
                value={String(form.minecraftBrainLlmModel || "")}
                onChange={set("minecraftBrainLlmModel")}
                placeholder="e.g. claude-opus-4-6"
                disabled={useTextModel}
              />
            </div>
          </div>
          <p className="status-msg">
            This is the model that interprets Minecraft instructions, reacts to
            in-game chat, and chooses the next high-level in-world action. It
            stays the same whether the input came from Discord text or voice.
          </p>
        </>
      )}
    </SettingsSection>
  );
}
