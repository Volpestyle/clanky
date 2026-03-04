# Claude Code Orchestrator Design Spec

Status as of March 4, 2026: **Implemented.** The `code_task` tool is registered for both voice and text paths, backed by `src/agents/codeAgent.ts`. Access control uses a settings-based `allowedUserIds` list (configured via dashboard) instead of the originally proposed `BOT_OWNER_DISCORD_ID` env var. Claude Code instances are sandboxed to the configured `defaultCwd` (defaults to `../web` relative to the app root). Parallel task limits and rate limits are configurable in dashboard settings.

## Overview

Give the bot the ability to spawn Claude Code CLI workers as a tool — alongside the browser, web search, and memory tools it already has. The brain decides when coding is needed based on natural conversation, chains it with other tools as appropriate, and reports back via voice or text.

Not a rigid command. Not a fixed workflow. Just another capability the bot can reach for.

---

## Core Idea

The bot already orchestrates multiple tools through its brain layer. Claude Code becomes one more:

```
Owner (voice or text)
    │
    "hey go look at my github issues and work on #42"
    │
    ▼
Brain (existing LLM orchestration)
    ├── browser_browse  →  read the GitHub issue
    ├── code_task       →  spawn Claude Code to write the fix, create a branch, push a PR
    ├── memory_search   →  recall prior context about the codebase
    └── reply           →  "done, here's the PR link"
```

The brain composes these naturally. No special routing — it just has more tools now.

---

## Owner-Only Gate

Claude Code gets full filesystem + shell access on the host. This is owner-only.

- New env var: `BOT_OWNER_DISCORD_ID`
- The `code_task` tool is only available when the current user matches this ID
- If not set, the tool never appears in the brain's tool list
- Checked at tool execution time too (belt and suspenders)
- Short rejection message if someone else somehow triggers it: "This capability is restricted to the bot owner."

### Why Not Role-Based

This gives shell access to the host machine. An exact user ID match is the only gate that makes sense.

---

## The `code_task` Tool

### What It Does

Spawns a Claude Code CLI process to execute a coding task. Claude Code has full agentic capabilities — Read, Write, Edit, Bash, Glob, Grep, git, `gh` CLI, etc. It runs in a real project directory and can do real work.

### Tool Definition (Voice — OpenAI Realtime)

```typescript
{
  toolType: "function",
  name: "code_task",
  description: "Spawn Claude Code to perform a coding task in a project directory. Can read/write files, run commands, use git, create PRs. Owner only.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Detailed instruction for what Claude Code should do. Be specific — include repo context, file paths, issue numbers, expected behavior."
      },
      cwd: {
        type: "string",
        description: "Working directory for the task. Defaults to the configured project root if omitted."
      }
    },
    required: ["task"]
  }
}
```

### Tool Definition (Text — Anthropic tool_use)

Same schema, formatted as `Anthropic.Tool` with `input_schema` instead of `parameters`.

### Where It Gets Registered

- **Voice path**: `resolveVoiceRealtimeToolDescriptors()` in `voiceToolCalls.ts` — conditional on owner ID being set + `codeAgent.enabled`
- **Text path**: `buildReplyToolSet()` in `replyTools.ts` — same conditions
- **browseAgent-style standalone**: also callable from a `/code` slash command for direct invocation without going through the brain

---

## Execution

### `runCodeAgent()` — `src/agents/codeAgent.ts`

```typescript
interface CodeAgentOptions {
  instruction: string;
  cwd: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  model: string;
  trace: {
    guildId?: string | null;
    channelId?: string | null;
    userId?: string | null;
    source?: string | null;
  };
  store: { logAction: (entry: Record<string, unknown>) => void };
}

interface CodeAgentResult {
  text: string;
  costUsd: number;
  isError: boolean;
  errorMessage: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}
```

### Under the Hood

Uses one-shot `runClaudeCli()` from `src/llmClaudeCode.ts`. Each invocation is independent — no persistent session, no multi-turn state.

**CLI args** (new `buildCodeAgentCliArgs()` — distinct from the brain's `buildClaudeCodeBaseCliArgs`):

```
claude -p \
  --verbose \
  --output-format stream-json \
  --model <model> \
  --max-turns <maxTurns> \
  "<instruction>"
```

Key differences from the brain session builder:
- **No `--tools ""`** — full tool access (the whole point)
- **No `--input-format stream-json`** — simple prompt string
- **No `--setting-sources` restriction** — reads the target project's CLAUDE.md
- **No `--strict-mcp-config`** — allows project-level MCP servers
- **`--no-session-persistence`** stays — ephemeral

### Output Parsing

Reuses `parseClaudeCodeStreamOutput()` from `llmClaudeCode.ts`. Already handles assistant text extraction, `{ type: "result" }` events, usage/cost parsing.

### Error Handling

Reuses `normalizeClaudeCodeCliError()` from `llmClaudeCode.ts`. Handles timeout detection, stderr extraction, human-readable messages.

---

## Entry Points

### 1. Brain Tool Call (Primary — Both Voice and Text)

The brain's LLM decides to call `code_task` during a conversation. This is the natural path — no special command needed. User says something, brain decides code work is needed, calls the tool, gets the result, continues the conversation.

Voice handler: `executeVoiceCodeTaskTool()` in `voiceToolCalls.ts`
Text handler: in `replyTools.ts` tool execution switch

### 2. `/code` Slash Command (Direct Invocation)

For when you want to bypass the brain and go straight to Claude Code:

```typescript
// src/commands/codeCommand.ts
new SlashCommandBuilder()
  .setName("code")
  .setDescription("Run a coding task via Claude Code (owner only)")
  .addStringOption((option) =>
    option.setName("task").setDescription("The coding instruction").setRequired(true)
  )
  .addStringOption((option) =>
    option.setName("cwd").setDescription("Working directory").setRequired(false)
  )
```

Handler in `bot.ts` `interactionCreate` — mirrors the `/browse` pattern: defer reply, owner check, run agent, edit reply with result.

### 3. Voice Direct (Conversational)

Just talk to the bot. "Hey, can you go fix that null pointer bug in the voice subprocess?" The brain hears it, decides `code_task` is the right tool, calls it.

---

## Example Flows

### GitHub Issue → PR

```
Owner: "go check my open github issues on clanker_conk"
Brain: calls browser_browse → navigates to github issues page → extracts list
Brain: "You have 3 open issues: #41 fix memory leak, #42 add retry logic, #43 update deps"
Owner: "work on 42"
Brain: calls code_task → "Read GitHub issue #42 on jamesvolpe/clanker_conk,
       understand the requirements, implement the fix, create a branch,
       commit, and open a PR using the gh CLI"
Claude Code: reads issue, writes code, commits, pushes, creates PR
Brain: "Done — opened PR #44 for issue #42. Added retry logic with exponential
       backoff to the voice reconnection flow. Here's the link: ..."
```

### Quick Fix

```
Owner: "there's a typo in the browse agent system prompt, it says 'alwyas'"
Brain: calls code_task → "Fix the typo 'alwyas' → 'always' in the browse agent
       system prompt in src/agents/browseAgent.ts"
Claude Code: fixes it
Brain: "Fixed it."
```

### Research + Code

```
Owner: "the openai realtime api changed their auth flow, can you look up
       the new docs and update our client?"
Brain: calls web_search → finds new docs
Brain: calls code_task → "Update the OpenAI Realtime client auth flow based
       on these changes: [context from web search]. Files likely in
       src/voice/..."
Claude Code: updates the code
Brain: "Updated the auth flow. Changed X, Y, Z. Want me to push a PR?"
```

---

## Settings

New `codeAgent` block in `settingsSchema.ts`:

```typescript
codeAgent: {
  enabled: false,
  model: "sonnet",
  maxTurns: 30,
  timeoutMs: 300_000,        // 5 minutes
  maxBufferBytes: 2 * 1024 * 1024,
  defaultCwd: "",            // empty = project root
  maxTasksPerHour: 10
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Master switch — tool doesn't register if false |
| `model` | Claude Code model shorthand (`"sonnet"`, `"opus"`, `"haiku"`) |
| `maxTurns` | Max agentic turns Claude Code can take per task |
| `timeoutMs` | Hard kill after this duration |
| `maxBufferBytes` | Truncate stdout/stderr beyond this |
| `defaultCwd` | Default working directory when `cwd` not specified |
| `maxTasksPerHour` | Rate limit |

---

## Logging

Every invocation logged via `store.logAction()`:

```typescript
store.logAction({
  kind: "code_agent_call",
  guildId: trace.guildId,
  channelId: trace.channelId,
  userId: trace.userId,
  content: instruction.slice(0, 200),
  metadata: {
    model,
    maxTurns,
    cwd,
    isError: result.isError,
    usage: result.usage,
    source: trace.source  // "voice_tool" | "text_tool" | "slash_command"
  },
  usdCost: result.costUsd
});
```

---

## Safety

| Concern | Mitigation |
|---------|------------|
| Unauthorized access | Owner-only gate via `BOT_OWNER_DISCORD_ID` |
| Runaway tasks | `timeoutMs` hard kill (default 5 min) |
| Infinite loops | `maxTurns` cap (default 30) |
| Output explosion | `maxBufferBytes` truncation |
| Rate/cost | `maxTasksPerHour` + per-invocation cost logging |
| Filesystem scope | `cwd` pins Claude Code to a directory; owner accepts the risk |

Claude Code's interactive safety prompts are bypassed in `-p` mode. This is intentional — the owner is the one running the bot on their machine and already has full access.

---

## File Summary

| File | Change |
|------|--------|
| `src/agents/codeAgent.ts` | New — `runCodeAgent()`, `buildCodeAgentCliArgs()` |
| `src/commands/codeCommand.ts` | New — `/code` slash command definition |
| `src/bot.ts` | Add `/code` handler + register command |
| `src/voice/voiceToolCalls.ts` | Add `code_task` tool def + `executeVoiceCodeTaskTool()` |
| `src/tools/replyTools.ts` | Add `code_task` to text brain tool set |
| `src/settings/settingsSchema.ts` | Add `codeAgent` settings block |
| `src/llmClaudeCode.ts` | Add `buildCodeAgentCliArgs()` (new function only) |
