# Text Turn Log Dive - Codex Worker Adoption Timeout

**Trigger:** `1497985713835348038`  
**Time:** 2026-04-26 15:40:25 - 15:40:58 UTC  
**Instance:** `clanky`  
**Mode:** text reply, `openai-oauth:gpt-5.5`, `spawn_code_worker` with `codex-cli` worker  
**Participants:** `vuhlp` and clanky  
**LLM calls:** 2  
**Cost:** $0.00  
**Primary files:** `src/agents/swarmLauncher.ts`, `src/llm/llmCodexCli.ts`, `docs/capabilities/code.md`

## Conversation Timeline

```
15:40:25 [runtime]: reply_admission_decision allow=true reason=recent_reply_window
15:40:32 [runtime]: reply_pipeline_gate allow=true reason=ready
15:40:32 [runtime]: reply_tool_availability includedToolCount=46 excludedToolCount=0
15:40:37 [llm]: first gpt-5.5 call returned one function_call: spawn_code_worker
15:40:52 [runtime]: swarm_worker_adoption_timeout instance=f6688d88-5a12-4a6a-861f-5390b16a5a55 harness=codex-cli
15:40:52 [runtime]: swarm_worker_exit exitCode=0 cancelled=true cancelReason="adoption timeout"
15:40:57 [llm]: follow-up gpt-5.5 call wrote the timeout reply
15:40:58 [clanky]: I tried to spawn it again and the swarm worker didn't adopt the task within the timeout...
```

## Issues Reported / Observed

1. The cwd fix got the request past workspace selection, but the Codex worker never adopted its reserved swarm instance.
2. The worker process did not crash with a non-zero exit; Clanky cancelled it after the 15s adoption deadline.
3. The tail showed a Codex MCP transport error before any swarm adoption happened.

## 1. Codex Started, But No Swarm Peer Adopted

Evidence:

| Time | Event | Metadata |
|------|-------|----------|
| 15:40:37.492 | `llm_call` | `toolCallCount=1`, `toolNames=spawn_code_worker`, `functionCallArgumentChars=437` |
| 15:40:52.572 | `swarm_worker_adoption_timeout` | `instanceId=f6688d88-5a12-4a6a-861f-5390b16a5a55`, `harness=codex-cli`, `timeoutMs=15000` |
| 15:40:52.584 | `swarm_worker_exit` | `exitCode=0`, `cancelled=true`, `cancelReason=adoption timeout` |

The adoption timeout tail was:

```text
Reading additional input from stdin...
{"type":"thread.started","thread_id":"019dca73-2daf-7003-b838-363bc69a6e8a"}
{"type":"turn.started"}
2026-04-26T15:40:39.884370Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Deserialize(Error("data did not match any variant of untagged enum JsonRpcMessage", line: 0, column: 0))
```

Interpretation:

Codex reached `turn.started`, but at least one MCP worker failed during transport setup. Since the reserved row never flipped to `adopted=1`, `spawnPeer` treated this as a launch failure and cancelled the direct child process. The process exit code was `0` because the launcher initiated cancellation after the adoption timeout; the functional failure was the missing swarm adoption.

## 2. The Failure Was In Codex MCP Launch Isolation

The direct Codex path relied on parent process env plus normal Codex config loading. That had two fragile pieces:

| Fragile piece | Why it mattered |
|---------------|-----------------|
| User Codex config was loaded | User-level MCP servers were visible to the worker, so unrelated MCP launch/transport failures could poison the session before the swarm server adopted. |
| Swarm adoption env was not present in Codex `mcp_servers.swarm.env.*` overrides | If Codex launched stdio MCP servers with only explicit server env, the swarm child did not receive `SWARM_MCP_INSTANCE_ID`, `SWARM_MCP_DIRECTORY`, `SWARM_MCP_SCOPE`, or `SWARM_MCP_FILE_ROOT`. |
| Swarm server cwd was implicit | `bun run /abs/path/to/src/index.ts` works best when the MCP process cwd is the vendored swarm-mcp package root, not the target scratch workspace. |

Code path before the fix:

| File | Behavior |
|------|----------|
| `src/agents/swarmLauncher.ts` | built Codex MCP config overrides before reserving the instance row, so dynamic adoption env was unavailable |
| `src/llm/llmCodexCli.ts` | launched `codex exec` without `--ignore-user-config` |
| `src/agents/swarmLauncher.ts` | omitted explicit Codex `-C <resolved workspace cwd>` in the direct child invocation |

Interpretation:

The swarm-mcp server itself was not proven bad. A manual stdio probe of Clanky's vendored `mcp-servers/swarm-mcp/src/index.ts` responded to MCP `initialize`. The problem was the launcher contract around Codex: the worker session was not isolated to the intended swarm server config, and the adoption env was not pinned into the server config Codex uses to spawn MCP children.

## Fixes Applied

| Issue | Root Cause | Fix | File |
|-------|------------|-----|------|
| Codex workers can load unrelated user MCP servers | `codex exec` inherited `$CODEX_HOME/config.toml` | Add `--ignore-user-config` to Codex code-agent launches while preserving auth through `CODEX_HOME` | `src/llm/llmCodexCli.ts` |
| Swarm child may not receive adoption identity | Codex MCP config overrides were generated before Clanky reserved the instance row | Build direct-child Codex overrides after reservation and include `mcp_servers.swarm.env.*` for `SWARM_DB_PATH`, `SWARM_MCP_INSTANCE_ID`, `SWARM_MCP_DIRECTORY`, `SWARM_MCP_SCOPE`, `SWARM_MCP_FILE_ROOT`, and `SWARM_MCP_LABEL` | `src/agents/swarmLauncher.ts` |
| Vendored swarm-mcp can launch from the wrong cwd | MCP server cwd was implicit | Add `mcp_servers.swarm.cwd=<vendored swarm-mcp root>` to Codex overrides | `src/agents/swarmLauncher.ts` |
| Codex workspace root was only the process cwd | Direct child args omitted Codex's own `-C` flag | Pass the resolved worker cwd to `buildCodexCliCodeAgentArgs` | `src/agents/swarmLauncher.ts` |

## Follow-up Resolution: PTY-backed Codex Workers

After the direct-child isolation fixes, Clanky moved the preferred path to `swarm-server` PTYs so code workers are visible and attachable in `swarm-ui`. The Codex PTY path had a separate launch race:

| Symptom | Root Cause | Fix | File |
|---------|------------|-----|------|
| Codex PTY adoption timed out with only startup escape sequences in replay | Clanky interpreted the first stale `/state` snapshot as PTY exit before the server snapshot poller had published the newly-created PTY | Wait for the PTY to appear in `/state`, or for a short appearance grace period, before treating a missing PTY as exit | `src/agents/swarmLauncher.ts` |
| Adoption timeout logs had an empty tail for PTY-backed workers | Clanky only had a stdout/stderr ring buffer for direct children | Fetch `/pty/:id/replay` from `swarm-server` for PTY-backed diagnostics | `src/agents/swarmLauncher.ts`, `src/agents/swarmServerClient.ts` |
| Codex PTY MCP child did not have a stable adoption identity | The interactive Codex process needed the same dynamic swarm env pinned into its MCP server config | Create the worker identity row before launch, pass its `instance_id` to `/pty`, and include `mcp_servers.swarm.env.*` overrides in the Codex args | `src/agents/swarmLauncher.ts` |

The successful end-to-end verification was a Clanky-spawned Codex worker creating a static app in `swarm-test`, adopting through the `swarm-server` PTY path, editing files, and reporting its checks back through the normal worker result flow.

## Follow-up Optimization: Installed Skill Discovery

After the PTY adoption path was stable, Clanky reduced worker prompt size by preferring installed `swarm-mcp` skills over inlining the full vendored skill text. When the skill is reachable through the harness's normal discovery paths, the first-turn prompt now emits a short directive pointing at the on-disk skill. If no reachable install exists, Clanky still inlines the vendored skill body, preserving the old behavior. Setting `appendCoordinationPrompt=false` disables both delivery modes while leaving Clanky's launcher-specific overlays in place.

## Verification

| Check | Result |
|-------|--------|
| `codex exec --help` | Confirms `--ignore-user-config` and `--skip-git-repo-check` are supported for the actual non-interactive worker command |
| `bun test src/llm/llm.codexCli.test.ts src/agents/swarmLauncher.test.ts` | 26 pass, 0 fail |
| `bun run test` | 1540 pass, 0 fail |
| `bun run test src/agents/swarmLauncher.test.ts` | 1549 pass, 0 fail; repo script ran the full non-E2E suite |
| Installed skill discovery optimization | 1551 pass, 0 fail; adds coverage for discovery directive and inline fallback precedence |
| `cargo test -p swarm-server` | 29 pass, 0 fail |
| Live `spawnPeer` Codex PTY probe | Adopted instance `5252ef5c-8198-42b1-9953-8a4a76861546` through PTY `f38dffd6-e7be-47e2-8a52-428cc36870a1` |

## Open Items / Future Considerations

- Add a cheap preflight that starts only the configured swarm MCP stdio server and verifies MCP `initialize` before launching a paid worker turn.
- Log the concrete harness args with sensitive values redacted when adoption times out. The current tail is useful, but it does not say which MCP server produced the transport error.
- Product language: Codex code workers run with a Clanky-owned MCP server config for the spawned swarm peer, not the operator's whole user MCP toolbox. The worker gets the project workspace, the swarm identity, and only the coordination server needed to adopt and do the job.
- Product language: PTY-backed workers are live terminal sessions first. Clanky treats `swarm-server` replay as the diagnostic source of truth and does not cancel a worker just because the first `/state` poll has not caught up yet.
