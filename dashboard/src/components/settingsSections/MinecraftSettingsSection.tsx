import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";

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
