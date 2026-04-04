import { SettingsSection } from "../SettingsSection";

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
        Set an explicit MCP URL to connect to an external server instead.
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
        </>
      )}
    </SettingsSection>
  );
}
