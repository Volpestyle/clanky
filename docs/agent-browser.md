# Discord Bot Browser Integration Spec

## Overview

Add headless browser capabilities to an existing LLM-powered Discord bot using `agent-browser` (Vercel Labs) as a Rust CLI sidecar — alongside the existing Rust voice subprocess.

---

## Current Architecture (Assumed)

```
Discord Gateway
    │
    ▼
Bot Process (Node/TS)
    ├── Message Handler → LLM (tool-use enabled)
    ├── Voice Subprocess (Rust)
    └── [NEW] Browser Subprocess (agent-browser)
```

---

## Phase 1: Install & Bootstrap agent-browser

**Goal:** Get agent-browser running as a managed subprocess.

### Tasks

1. Install agent-browser globally on the host or bundle the Rust binary
   ```bash
   npm install -g agent-browser
   agent-browser install  # downloads Chromium
   ```
2. Create a `BrowserManager` service class that:
   - Spawns `agent-browser` commands via `child_process.execFile`
   - Manages sessions (open/close browser contexts)
   - Handles timeouts and cleanup (kill stale sessions after N minutes)
   - Caps concurrent browser sessions (start with 1-2 max)
3. Verify basic lifecycle:
   ```
   agent-browser open https://example.com
   agent-browser snapshot -i
   agent-browser close
   ```

### Deliverables
- `src/services/BrowserManager.ts`
- Health check: bot can open a page and return a snapshot on command

---

## Phase 2: Define LLM Tool Schemas

**Goal:** Give the LLM a clean set of browser tools it can invoke.

### Tool Definitions

| Tool | Parameters | Returns |
|------|-----------|---------|
| `browser_open` | `url: string` | Page title, URL confirmation |
| `browser_snapshot` | `interactive_only?: boolean` | Accessibility tree with element refs (@e1, @e2...) |
| `browser_click` | `ref: string` | Updated snapshot or confirmation |
| `browser_type` | `ref: string, text: string` | Confirmation |
| `browser_scroll` | `direction: "up" \| "down", pixels?: number` | Updated snapshot |
| `browser_extract` | `ref?: string` | Text content of element or page |
| `browser_screenshot` | — | Base64 image (for vision-capable models) |
| `browser_close` | — | Confirmation |

### Design Decisions

- **Snapshot as primary state representation.** Use `snapshot -i` (interactive elements only) as default — ~200-400 tokens vs 3000-5000 for full DOM. Fall back to full snapshot or screenshot only when the LLM explicitly requests it.
- **Ref-based interaction.** The LLM references elements by `@e1`, `@e2` etc. from the snapshot. No CSS selectors, no XPaths — keeps tool calls simple and reliable.
- **No compound actions.** Each tool does one thing. The LLM chains them. This keeps the failure surface small and makes debugging easy.

### Deliverables
- `src/tools/browserTools.ts` — tool definitions + execution wrappers
- Tool schemas registered with your LLM provider (Claude tool_use, OpenAI function calling, etc.)

---

## Phase 3: Agent Loop

**Goal:** Wire the LLM into a browse → observe → act → observe loop.

### Flow

```
User: "go to hackernews and get me the top 5 stories"
         │
         ▼
   ┌─────────────────────┐
   │  LLM decides:       │
   │  browser_open(url)   │
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │  Execute action      │
   │  Return new state    │
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │  LLM sees snapshot   │◄──── loop (max N steps)
   │  Decides next action │
   └──────────┬──────────┘
              │
         (repeats until LLM returns final answer)
              │
              ▼
   Discord reply with results
```

### Key Parameters

| Parameter | Starting Value | Notes |
|-----------|---------------|-------|
| Max steps per task | 15 | Hard cap to prevent runaway token burn |
| Step timeout | 30s | Kill step if browser hangs |
| Session timeout | 5min | Auto-close forgotten sessions |
| Snapshot mode | interactive (-i) | Compact by default |
| Max concurrent sessions | 2 | Per-server or global |

### Agent Loop Pseudocode

```typescript
async function browseAgent(task: string, maxSteps = 15): Promise<string> {
  const messages = [
    { role: "system", content: BROWSER_AGENT_SYSTEM_PROMPT },
    { role: "user", content: task }
  ];

  for (let step = 0; step < maxSteps; step++) {
    const response = await llm.chat(messages, { tools: browserTools });

    if (response.type === "text") {
      // LLM is done — return final answer
      return response.content;
    }

    if (response.type === "tool_use") {
      const result = await executeBrowserTool(response.tool, response.params);
      messages.push({ role: "assistant", content: response });
      messages.push({ role: "tool", content: result });
    }
  }

  await browserManager.close();
  return "I hit the step limit. Here's what I found so far: ...";
}
```

### System Prompt (Browser Agent)

```
You have access to a headless browser. You can navigate websites, 
interact with elements, and extract information.

When you receive a snapshot, elements are labeled with refs like @e1, @e2.
Use these refs to interact — e.g. browser_click({ ref: "@e3" }).

Rules:
- Always snapshot after navigating or clicking to see the new state
- Use interactive-only snapshots by default
- Extract data before closing the browser
- If a page requires scrolling, scroll and re-snapshot
- Minimize steps — plan your path before acting
- When done, return your findings as a clear answer
```

### Deliverables
- `src/agents/browseAgent.ts` — the agent loop
- System prompt tuned for your LLM of choice

---

## Phase 4: Discord Integration

**Goal:** Expose browser capabilities through Discord commands/messages.

### Trigger Options

1. **Slash command:** `/browse <task>` — explicit invocation
2. **Natural language:** LLM decides when browsing is needed based on the message (e.g., "what's on the front page of HN right now?")
3. **Hybrid:** Start with slash command, graduate to natural language once stable

### UX Considerations

- **Deferred replies.** Browser tasks take 10-60s. Use Discord's deferred interaction response immediately, then edit with progress updates.
- **Progress messages.** Stream step summaries back:
  ```
  🌐 Opening hackernews.com...
  📸 Found 30 stories, extracting top 5...
  ✅ Done!
  ```
- **Timeout messaging.** If hitting the step limit, return partial results with a note that the task was cut short.
- **Permissions.** Consider restricting browser commands to specific roles or channels to avoid abuse.

### Deliverables
- `/browse` slash command handler
- Progress update middleware
- Permission checks

---

## Phase 5: Safety & Resource Management

**Goal:** Don't let the browser burn money, get exploited, or crash the host.

### Guardrails

| Concern | Mitigation |
|---------|------------|
| Token burn | Max steps cap (15), snapshot size limit, prefer `-i` mode |
| Runaway sessions | Session timeout (5min), cleanup on bot restart |
| Malicious URLs | URL allowlist/blocklist, no `file://` or `localhost` |
| Resource exhaustion | Max concurrent sessions, memory monitoring |
| Sensitive data | Never fill payment forms, passwords, or PII via browser |
| Abuse | Rate limit per user (e.g., 5 browse tasks/hour) |
| Cost tracking | Log token count per browse session, alert on threshold |

### Docker Isolation (Optional, Recommended for Production)

Run agent-browser inside a Docker container with:
- No host network access (use bridge with restricted egress)
- Read-only filesystem except for temp dirs
- Memory and CPU limits
- No access to bot credentials or secrets

---

## Phase 6: Enhancements (Future)

| Enhancement | Description |
|-------------|-------------|
| Screenshot fallback | When snapshot is ambiguous, take a screenshot and use vision model |
| Session persistence | Keep browser open across messages for multi-turn workflows |
| Cookie/auth profiles | Logged-in sessions for sites that need auth |
| Caching | Cache snapshots for pages visited recently |
| Parallel browsing | Open multiple tabs for comparison tasks |
| Streaming results | Send extracted data to Discord as it's found, not all at end |

---

## Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Bot runtime | Node.js / TypeScript |
| Browser engine | agent-browser (Rust CLI + Chromium) |
| LLM | Claude / GPT-4 (tool-use API) |
| Voice | Existing Rust subprocess |
| Process management | child_process.execFile / spawn |
| Discord | discord.js |

---

## Milestones

| # | Milestone | Est. Effort | Dependency |
|---|-----------|-------------|------------|
| 1 | agent-browser installed and callable from Node | 1-2 hours | None |
| 2 | Tool schemas defined and wired to LLM | 2-3 hours | M1 |
| 3 | Agent loop working end-to-end in terminal | 3-4 hours | M2 |
| 4 | Discord slash command with progress updates | 2-3 hours | M3 |
| 5 | Safety guardrails and rate limiting | 2-3 hours | M4 |
| 6 | Docker isolation (optional) | 3-4 hours | M5 |

**Total estimated effort: ~2-3 days to a working MVP (M1-M4)**