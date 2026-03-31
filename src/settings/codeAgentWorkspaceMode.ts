export const CODE_AGENT_WORKSPACE_MODE_VALUES = [
  "auto",
  "shared_checkout",
  "isolated_worktree"
] as const;

export type CodeAgentWorkspaceModeSetting = typeof CODE_AGENT_WORKSPACE_MODE_VALUES[number];
export type ResolvedCodeAgentWorkspaceMode = Exclude<CodeAgentWorkspaceModeSetting, "auto">;

export function normalizeCodeAgentWorkspaceModeSetting(
  value: unknown,
  fallback: CodeAgentWorkspaceModeSetting = "auto"
): CodeAgentWorkspaceModeSetting {
  const normalized = String(value || "").trim().toLowerCase() as CodeAgentWorkspaceModeSetting;
  if (CODE_AGENT_WORKSPACE_MODE_VALUES.includes(normalized)) {
    return normalized;
  }
  return fallback;
}

export function resolveCodeAgentWorkspaceMode({
  configuredMode,
  swarmEnabled
}: {
  configuredMode: unknown;
  swarmEnabled: boolean;
}): ResolvedCodeAgentWorkspaceMode {
  const normalized = normalizeCodeAgentWorkspaceModeSetting(configuredMode);
  if (normalized === "auto") {
    return swarmEnabled ? "shared_checkout" : "isolated_worktree";
  }
  return normalized;
}
