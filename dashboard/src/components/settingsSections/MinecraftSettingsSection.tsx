import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";
import { rangeStyle } from "../../utils";

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
            <label>Operator player name</label>
            <input
              type="text"
              value={String(form.minecraftOperatorPlayerName || "")}
              onChange={set("minecraftOperatorPlayerName")}
              placeholder="e.g. Volpestyle"
            />
            <p className="status-msg">
              Your Minecraft username. Used for &quot;follow me&quot; and
              &quot;guard me&quot; commands. Can also be set via the{" "}
              <code>MC_OPERATOR_USERNAME</code> env var.
            </p>
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
