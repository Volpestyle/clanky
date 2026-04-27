# Text Turn Log Dive - Code Worker Could Not Find `swarm-test`

**Trigger:** `1497825965487816876`  
**Time:** 2026-04-26 05:05:43 - 05:05:58 UTC  
**Instance:** `clanky`  
**Mode:** text reply, `openai-oauth:gpt-5.5`, reply tool loop with `spawn_code_worker` available  
**Participants:** `vuhlp` and clanky  
**LLM calls:** 2  
**Cost:** $0.00  
**Primary files:** `src/tools/spawnCodeWorker.ts`, `src/agents/codeAgentSettings.ts`, `src/agents/codeAgentWorkspace.ts`, `src/prompts/promptCapabilities.ts`

## Conversation Timeline

```
05:05:43 [vuhlp]: hey clanky, can u create a short todo app in swarm-test package?
05:05:43 [runtime]: reply_admission_decision allow=true reason=hard_address
05:05:45 [runtime]: reply_pipeline_gate allow=true reason=ready
05:05:45 [runtime]: reply_tool_availability includedToolCount=46 excludedToolCount=0
05:05:50 [llm]: first gpt-5.5 call returned one function_call: spawn_code_worker
05:05:57 [llm]: follow-up gpt-5.5 call wrote the apology/failure reply
05:05:57 [runtime]: reaction requested and sent: skull emoji
05:05:58 [clanky]: I tried to spin the worker up, but the path `swarm-test` doesn't exist from where I'm allowed to run agents...
```

## Issues Reported / Observed

1. Clanky reported that `swarm-test` did not exist even though the dashboard allowed workspace root is `/Users/james.volpe/volpestyle`.
2. The sibling `swarm-mcp` repo is present and healthy; the failure occurred before the worker reached the swarm server launch path.
3. The actual `/Users/james.volpe/volpestyle/swarm-test` directory exists, but it was not a git checkout. At incident time, that was a second blocker under the then-current code-worker rules.
4. The logs do not record the exact `spawn_code_worker` input or tool result as a standalone event, so the exact model-provided `cwd` is inferred from the final reply and the matching code path.

## 1. Why Clanky Could Not Find `swarm-test`

The code-worker path resolver treats relative `cwd` values as relative to Clanky's process cwd, not relative to the first allowed workspace root.

Evidence:

| Evidence | Value |
|----------|-------|
| Dashboard/runtime settings | `permissions.devTasks.allowedWorkspaceRoots=["/Users/james.volpe/volpestyle"]` from `data/clanker.db` |
| Clanky process workspace during this dive | `/Users/james.volpe/volpestyle/clanky` |
| Real sibling directory | `/Users/james.volpe/volpestyle/swarm-test` exists |
| Reproduced code path | `resolveCodeAgentCwd("swarm-test", process.cwd())` resolves to `/Users/james.volpe/volpestyle/clanky/swarm-test` |
| Reproduced error | `Code worker directory does not exist: /Users/james.volpe/volpestyle/clanky/swarm-test` |

Code path:

| File | Lines | Behavior |
|------|-------|----------|
| `src/tools/replyTools.ts` | 1303-1312 | passes user/model `cwd` directly into `spawnCodeWorker` |
| `src/tools/spawnCodeWorker.ts` | 654-661 | uses `args.cwd` if present; GitHub repo lookup only runs when `cwd` is absent |
| `src/tools/spawnCodeWorker.ts` | 327-331 | resolves the selected cwd and asserts it is inside allowed roots |
| `src/agents/codeAgentSettings.ts` | 51-55 | resolves relative cwd with `path.resolve(fallbackBaseDir, value)` |
| `src/agents/codeAgentSettings.ts` | 117-120 | uses `process.cwd()` as the fallback base dir |
| `src/agents/codeAgentWorkspace.ts` | 28-35 | throws `Code worker directory does not exist: <absolute path>` when that resolved cwd is missing |

Interpretation:

Clanky did have the allowed root configured. The allowed root is only an authorization boundary. It is not used as the base directory for a bare relative `cwd` like `swarm-test`. A bare `cwd` resolves under the running Clanky checkout, so the tool looked for `/Users/james.volpe/volpestyle/clanky/swarm-test`, not `/Users/james.volpe/volpestyle/swarm-test`.

## 2. `swarm-mcp` Was Not The Missing Piece

The logs show the swarm/code-worker tool surface was available before generation.

Evidence:

| Time | Event | Metadata |
|------|-------|----------|
| 05:05:45.029 | `reply_tool_availability` | `allow=true`, `reason=tools_available`, `includedToolCount=46`, `excludedToolCount=0` |
| 05:05:50.978 | `llm_call` | `toolCallCount=1`, `toolNames=spawn_code_worker`, `stopReason=completed` |

Filesystem checks during the dive:

| Path | Result |
|------|--------|
| `/Users/james.volpe/volpestyle/swarm-mcp` | exists and `git rev-parse --show-toplevel` returns `/Users/james.volpe/volpestyle/swarm-mcp` |
| `/Users/james.volpe/volpestyle/clanky/mcp-servers/swarm-mcp` | exists |

Interpretation:

This was not a missing `swarm-mcp` install or missing tool exposure. The spawn flow failed during cwd resolution before `spawnPeer` could launch a harness through the swarm command path in `src/tools/spawnCodeWorker.ts` lines 740-766.

## 3. `swarm-test` Was Also Not A Git Checkout

At incident time, even with the corrected sibling path, code-worker rules rejected `swarm-test` because it was not inside a git repository.

Evidence:

| Check | Result |
|-------|--------|
| Directory listing | `/Users/james.volpe/volpestyle/swarm-test` contains `.claude/`, `.mcp.json`, and `design.md` |
| Git root check | `git -C /Users/james.volpe/volpestyle/swarm-test rev-parse --show-toplevel` fails with `not a git repository` |
| Reproduced corrected cwd | `resolveCodeAgentCwd("../swarm-test", process.cwd())` resolves to `/Users/james.volpe/volpestyle/swarm-test` |
| Reproduced corrected-cwd error | `Code workers require a git repository checkout. '/Users/james.volpe/volpestyle/swarm-test' is not inside a git repo.` |

Code path:

| File | Lines | Behavior |
|------|-------|----------|
| `src/agents/codeAgentWorkspace.ts` | 40-45 | runs `git rev-parse --show-toplevel`; throws if the target cwd is not in a git checkout |
| `src/agents/codeAgentWorkspace.ts` | 48-62 | requires the requested cwd to stay inside the detected repo root |

Interpretation:

The immediate visible failure was the wrong relative base directory. The next failure would have been the git-checkout requirement. The follow-up fix removed that requirement for local scratch directories.

## 4. Logging Gap

The structured turn logs record the model choosing `spawn_code_worker`, but they do not record a standalone tool-call event with the tool input and result.

Evidence:

| Time | Event | Metadata |
|------|-------|----------|
| 05:05:50.978 | `llm_call` | `rawContentSummary.functionCallNames=["spawn_code_worker"]`, `functionCallArgumentChars=438` |
| 05:05:57.816 | `llm_call` | `metadata.event=reply_tool_loop:1`, final text says the path `swarm-test` does not exist |
| 05:05:58.329 | `sent_message` | carries `replyPrompts`, but the logged `followupUserPrompts` slice is empty |

Interpretation:

The first LLM call confirms the tool choice, and the second LLM call confirms the tool loop produced a failure message. The logs do not preserve the exact `spawn_code_worker` arguments or returned error. That makes this incident diagnosable, but not replay-perfect.

## Latency And Token Summary

| Stage | Value |
|-------|-------|
| Admission to final send | 14.570s |
| `sent_message.metadata.performance.totalMs` | 19,896ms |
| `queueMs` | 936ms |
| `memorySliceMs` | 318ms |
| `llm1Ms` | 5,820ms |
| `followupMs` | 6,841ms |
| First LLM usage | 9,563 input, 134 output |
| Follow-up LLM usage | 9,705 input, 194 output |
| Total logged LLM tokens | 19,268 input, 328 output |

## Fixes Applied

The follow-up implementation fixes the two cwd blockers identified by this dive.

| Issue | Root Cause | Fix | File |
|-------|------------|-----|------|
| Bare package names resolve under `clanky/` | `resolveCodeAgentCwd` used `process.cwd()` as the base for relative cwd values | Relative `cwd` values now anchor to the selected worker `defaultCwd`, then the first allowed workspace root, then `process.cwd()` | `src/agents/codeAgentSettings.ts`, `src/tools/spawnCodeWorker.ts` |
| `swarm-test` cannot be a worker cwd | code workers required a git checkout | Non-git directories now become their own workspace scope | `src/agents/codeAgentWorkspace.ts` |
| Exact tool input/result is missing from logs | reply tool loop does not emit a compact `spawn_code_worker` call/result event | Not applied | `src/tools/replyTools.ts` / `src/bot/replyPipeline.ts` |

## Open Items / Future Considerations

- Emit a structured `reply_tool_call` / `reply_tool_result` log for `spawn_code_worker` with redacted args, resolved cwd, allowed-root decision, and error text.
- Product language: when `defaultCwd` is blank, the first allowed workspace root is also the worker's default place to start. Relative `cwd` values are interpreted from that configured coding workspace, not from the Clanky repo.
