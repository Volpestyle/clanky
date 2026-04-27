import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCodeAgentConfig, resolveCodeAgentCwd } from "./codeAgentSettings.ts";
import { createTestSettings } from "../testSettings.ts";

function normalizeExpectedPath(value: string) {
  return path.resolve(value);
}

test("resolveCodeAgentConfig routes worker selection through the requested role", () => {
  const base = createTestSettings({
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"]
      }
    },
    agentStack: {
      runtimeConfig: {
        devTeam: {
          codexCli: {
            maxParallelTasks: 2,
            maxTasksPerHour: 5
          },
          claudeCode: {
            maxParallelTasks: 2,
            maxTasksPerHour: 5
          }
        }
      }
    }
  });
  const settings = {
    ...base,
    agentStack: {
      ...base.agentStack,
      overrides: {
        ...base.agentStack.overrides,
        devTeam: {
          codingWorkers: ["codex_cli", "claude_code"],
          roles: {
            design: "claude_code",
            implementation: "codex_cli",
            review: "claude_code",
            research: "codex_cli"
          }
        }
      },
      runtimeConfig: {
        ...base.agentStack.runtimeConfig,
        devTeam: {
          ...base.agentStack.runtimeConfig.devTeam,
          codexCli: {
            ...base.agentStack.runtimeConfig.devTeam.codexCli,
            enabled: true,
            defaultCwd: "/tmp/codex-cli",
            maxParallelTasks: 3
          },
          claudeCode: {
            ...base.agentStack.runtimeConfig.devTeam.claudeCode,
            enabled: true,
            defaultCwd: "/tmp/claude-code",
            maxParallelTasks: 5
          }
        }
      }
    }
  };

  const designConfig = resolveCodeAgentConfig(settings, undefined, "design");
  const implementationConfig = resolveCodeAgentConfig(settings, undefined, "implementation");
  const reviewConfig = resolveCodeAgentConfig(settings, undefined, "review");
  const researchConfig = resolveCodeAgentConfig(settings, undefined, "research");

  assert.equal(designConfig.role, "design");
  assert.equal(designConfig.worker, "claude_code");
  assert.equal(designConfig.provider, "claude-code");
  assert.equal(designConfig.cwd, normalizeExpectedPath("/tmp/claude-code"));
  assert.equal(designConfig.maxParallelTasks, 5);

  assert.equal(implementationConfig.role, "implementation");
  assert.equal(implementationConfig.worker, "codex_cli");
  assert.equal(implementationConfig.provider, "codex-cli");
  assert.equal(implementationConfig.cwd, normalizeExpectedPath("/tmp/codex-cli"));
  assert.equal(implementationConfig.maxParallelTasks, 3);

  assert.equal(reviewConfig.worker, "claude_code");
  assert.equal(reviewConfig.provider, "claude-code");
  assert.equal(researchConfig.worker, "codex_cli");
  assert.equal(researchConfig.provider, "codex-cli");
});

test("resolveCodeAgentConfig preserves swarm runtime config for launcher workers", () => {
  const settings = createTestSettings({
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"]
      }
    },
    agentStack: {
      runtimeConfig: {
        devTeam: {
          swarm: {
            enabled: true,
            command: "bun",
            args: ["run", "swarm-mcp/src/index.ts"]
          },
          codexCli: {
            enabled: true,
            defaultCwd: "/tmp/codex-cli"
          }
        }
      }
    }
  });

  const config = resolveCodeAgentConfig(settings, undefined, "implementation");
  assert.equal(config.provider, "codex-cli");
  assert.equal(config.swarm?.enabled, true);
  assert.equal(config.swarm?.command, "bun");
});

test("resolveCodeAgentCwd defaults to the provided repo root and normalizes relative paths", () => {
  assert.equal(resolveCodeAgentCwd("", "/tmp/project"), normalizeExpectedPath("/tmp/project"));
  assert.equal(
    resolveCodeAgentCwd("packages/app", "/tmp/project"),
    normalizeExpectedPath("/tmp/project/packages/app")
  );
  assert.equal(resolveCodeAgentCwd("/var/tmp/repo", "/tmp/project"), normalizeExpectedPath("/var/tmp/repo"));
});

test("resolveCodeAgentConfig anchors relative cwd overrides to the configured worker cwd", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clanky-code-agent-settings-"));
  try {
    const settings = createTestSettings({
      permissions: {
        devTasks: {
          allowedUserIds: ["user-1"],
          allowedWorkspaceRoots: [tempDir]
        }
      },
      agentStack: {
        runtimeConfig: {
          devTeam: {
            codexCli: {
              enabled: true,
              defaultCwd: tempDir
            }
          }
        }
      }
    });

    const config = resolveCodeAgentConfig(settings, "swarm-test", "implementation");

    assert.equal(config.cwd, path.join(path.resolve(tempDir), "swarm-test"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodeAgentConfig uses the first allowed workspace root when default cwd is unset", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clanky-code-agent-allowed-root-"));
  try {
    const settings = createTestSettings({
      permissions: {
        devTasks: {
          allowedUserIds: ["user-1"],
          allowedWorkspaceRoots: [tempDir]
        }
      },
      agentStack: {
        runtimeConfig: {
          devTeam: {
            codexCli: {
              enabled: true,
              defaultCwd: ""
            }
          }
        }
      }
    });

    assert.equal(resolveCodeAgentConfig(settings, undefined, "implementation").cwd, path.resolve(tempDir));
    assert.equal(
      resolveCodeAgentConfig(settings, "swarm-test", "implementation").cwd,
      path.join(path.resolve(tempDir), "swarm-test")
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
