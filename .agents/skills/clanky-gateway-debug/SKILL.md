---
name: clanky-gateway-debug
description: >-
  Debug Clanky's Discord gateway and presence-session behavior. Use when Clanky is online or typing in Discord but not replying, replies twice, returns [SKIP], fails to spawn a Herdr mirror, mishandles wake aliases, stalls on a local Ollama model, or needs Discord channel/gateway logs inspected from the local clanky repo.
---

# Clanky Gateway Debug

Use this as an operational runbook for `/Users/james/dev/clanky/clanky-agent`.

## First Checks

1. Confirm the running gateway and model:
   ```bash
   curl -fsS http://127.0.0.1:2000/discord-gateway/health \
     | jq '{ok,running,ready,owner,scope,status}'
   curl -fsS http://127.0.0.1:2000/eve/v1/info | jq '{model: .agent.model.id, context: .agent.model.contextWindowTokens, channels: [.channels.authored[]?.name], tools: (.tools.authored|length)}'
   ollama ps
   ```
   Check the `scope` object in gateway health, or run `/status` in Clanky and read `discord scope`.
   `owner:"other-context"` is normal under local eve dev when the gateway side
   effect and the HTTP route live in different runtime contexts inside the same
   process. In that case, use `status.ready` and `status.sessions[]` from the
   shared lock status file as the live debug surface.
2. Find the active Clanky pane and enable useful logs:
   ```bash
   herdr agent list
   herdr pane run <pane_id> "/trace all"
   herdr pane read <pane_id> --source recent-unwrapped --lines 220
   ```
   The custom Clanky face supports `/trace off|no-reply|all`; it does **not**
   support `/loglevel`. `/loglevel` belongs to older/stock eve-dev debugging
   flows and returns `Unknown command` in the custom face.
3. For raw tool arguments, use the Eve session stream instead of the compact
   TUI trace. For face-entered prompts, run `/trace status` in the Clanky pane,
   copy the `session <id>` value, then replay the durable stream:
   ```bash
   curl -fsS "http://127.0.0.1:2000/eve/v1/session/<session_id>/stream?startIndex=0" \
     | jq -c 'select(.type=="actions.requested" or .type=="action.result" or .type=="turn.failed" or .type=="step.failed")'
   ```
   For Discord-originated presence sessions, get the session id from
   `/discord-gateway/health` `status.sessions[]`, a `mirror starting
   session=...` log line, or the spawned `clanky:discord-<suffix>` mirror pane.
   The compact TUI trace is for at-a-glance counts and tool names. The raw
   stream is the source of truth when you need the exact tool input that caused
   a failure.
4. Look for these log lines:
   - `[discord] accepted reason=...`: wake gate accepted the message.
   - `[discord] mirror starting session=...`: a Herdr mirror should appear as `clanky:discord-<suffix>`.
   - `[discord] sent chars=...`: Clanky posted to Discord.
   - `[discord] no reply outcome=skip|empty`: the model produced `[SKIP]` or no visible text.
   - `discord presence route failed`: route-level exception.
   - `[eve:harness.tool-loop] tool execution failed`: model called a tool and it failed.

## Discord Reads

Use the helper for read-only channel inspection with the same local `.env.local` credential:

```bash
node ~/.agents/skills/clanky-gateway-debug/scripts/read-discord-channel.mjs <guild_id> <channel_id> [limit]
```

Run it with cwd `/Users/james/dev/clanky/clanky-agent` (or `CLANKY_REPO_DIR` pointing there) — it loads `.env.local` relative to that.

Do not print or paste Discord tokens. If a REST read returns `Unknown Channel`, first verify the exact guild/channel snowflakes. The model can mangle long numeric ids when it decides to call `discord_read_messages`; the gateway logs shorten ids and are not suitable for tool input.

## Reply Scope

By default the Discord gateway can receive events from every DM, server, and channel the token user/bot can see. Clanky should only reply after the acceptance gate, but production setups should usually scope the gateway:

```bash
CLANKY_DISCORD_ALLOWED_GUILD_IDS=866430493889134672
CLANKY_DISCORD_ALLOWED_CHANNEL_IDS=866430493889134675
CLANKY_DISCORD_ALLOW_DMS=0
```

`CLANKY_DISCORD_ALLOWED_GUILD_IDS` restricts guild/server messages to those ids. `CLANKY_DISCORD_ALLOWED_CHANNEL_IDS` further narrows guild traffic to listed channel, thread, or parent-channel ids; leave it empty to allow all channels in the allowed guilds. DMs are allowed by default unless `CLANKY_DISCORD_ALLOW_DMS=0|false|no|off`.

From the Clanky TUI, use `/discord-scope` to open the interactive reply-scope picker. Typed shortcuts still work: `/discord-scope status`, `/discord-scope guilds <id...>`, `/discord-scope channels <id...>`, `/discord-scope add|remove guilds|channels <id...>`, `/discord-scope clear guilds|channels|dms|all`, and `/discord-scope dms on|off`.

## Known Failure Modes

- **`clanky up` times out even though `127.0.0.1:2000` is free:** check the tailnet
  address separately. Tailscale Serve can own `100.x.y.z:2000` while forwarding
  to `localhost:2000`, which makes `0.0.0.0:2000` fail with `EADDRINUSE` even
  when loopback binds cleanly and normal process tables do not show a Node/eve
  listener. On macOS, the CLI may only be available as
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; run
  `.../Tailscale serve status --json` and look for
  `{"TCP":{"2000":{"TCPForward":"localhost:2000"}}}`. With that Serve config,
  bind Clanky to loopback (`CLANKY_EVE_HOST=127.0.0.1 clanky up`) or let the
  current `clanky up` default detect Serve; the tailnet path stays live through
  Tailscale Serve.
- **Gateway lock points at the wrong repo after moving directories:** inspect
  `$TMPDIR/clanky-discord-gateway-*.lock/owner.json`. If `repo` is the parent
  directory (for example `/Users/james/dev/clanky`) instead of
  `/Users/james/dev/clanky/clanky-agent`, a direct script launch inherited the
  wrong cwd. Start through the installed `clanky` CLI or set `CLANKY_REPO_DIR`.
  Current gateway health/status removes dead-owner locks for the active repo;
  wrong-repo lock dirs are only relevant to processes still launched from that
  old cwd.
- **Mention ignored in a server/channel:** check `/status` or `/discord-gateway/health` for `discord scope`; an addressed message outside the allowlist logs `[discord] ignored reason=blocked_guild|blocked_channel|blocked_dm`.
- **Typing but delayed reply:** local Ollama may still be generating, especially with `qwen3.6:27b-mlx-bf16` at 262k context. Check `ollama ps` and wait before changing code.
- **Typing then no reply:** inspect for `outcome=skip`, `outcome=empty`, or a tool-loop failure. A simple greeting may legitimately become `[SKIP]`.
- **Typing then the whole brain goes unreachable (esp. on "join vc"):** the face shows `eve unreachable` / `TypeError: fetch failed` and `/discord-gateway/health` `status.pid`/`startedAt` jump to a fresh process — the eve dev brain crashed mid-turn and the face/watch respawned it. A turn that dies this way never replies. The classic cause is a voice join: `startVoiceSession` spawns the ClankVox Rust helper, and if it cannot be launched the `ChildProcess` `'error'` event becomes an uncaught exception that kills the brain. Check the binary exists at `/Users/james/dev/clanky/clankvox/target/release/clankvox`; if not, run `pnpm clankvox:setup` (idempotent: installs rustup, builds release). Build gotcha: with CMake >= 4 the vendored Opus (`audiopus_sys`) needs `CMAKE_POLICY_VERSION_MINIMUM=3.5` — already set via `clankvoxNativeBuildEnv` in `agent/lib/voice/clankvoxIpcClient.ts` and reused by the setup script. The brain stderr is only piped to the face (not logged to disk), so a deterministic voice crash is faster to pin down by reading the local-voice bring-up path than by hunting logs.
- **Joined VC then left ~10s later (brain stays up):** an unexpected voice drop — the OpenAI realtime socket closed (`socket_closed`/`socket_error`) or ClankVox exited (`clankvox_crashed`). Either faults the session via `handleVoiceFault`, which does not auto-reconnect (SPEC.md §2). Distinguish from a brain crash: `/discord-gateway/health` `status.pid`/`startedAt` are unchanged and durability turns completed normally. Confirm which half died with sockets/processes: `lsof -nP -p <brain_pid> | grep ESTABLISHED` — a live `api.openai.com` socket (`172.66.x`/`162.159.140.x`, distinct from the Discord gateway `162.159.13x.234`) plus a dead `clankvox` process means ClankVox crashed; no OpenAI socket means the realtime side dropped. Every fault is now persisted to `~/.clanky/voice/faults.jsonl` (`{at,guildId,channelId,kind,detail,stderrTail}`) and surfaced as `voice.lastFault` in the voice channel `status` op — read those first; the realtime close code/reason and ClankVox stderr tail live there instead of only scrolling past in the face. Code: fault types + `crashed` wiring in `agent/lib/voice/supervisor.ts`, persistence in `agent/lib/voice/fault-log.ts`, teardown + Discord notice in `agent/channels/voice.ts` / `formatVoiceDropNotice` in `agent/lib/discord/host.ts`. Smoke: `node test/voice-fault-smoke.ts`.
- **Double replies:** inspect for duplicate `[discord] accepted` lines with the same message id. The host should log `ignored reason=duplicate_message` for duplicate gateway deliveries, and `/discord-gateway/health` should show an acquired gateway `lock`. If duplicates still happen, check the inbound dedupe in `agent/lib/discord/host.ts`, the gateway lease in `agent/channels/discord-gateway.ts`, and restart Clanky once to clear old clients.
- **Duplicate Clanky line in prompt history but only one Discord reply:** Discord echoed Clanky's sent message back through the gateway. The host should log `ignored reason=self_message` and keep only the locally recorded `Clanky` history entry.
- **No Herdr mirror or mirror in wrong tab:** inspect for `discord presence mirror failed`. If it says `Unable to spawn node`, `spawnPaneMirror` must use `process.execPath`, not `"node"`. Mirrors and voice delegate panes should start in the face tab from `CLANKY_FACE_HERDR_TAB_ID`/`CLANKY_FACE_HERDR_WORKSPACE_ID`; if those are missing, restart Clanky from its intended Herdr pane.
- **REST can fail while gateway works:** the Gateway client can receive/send in a channel even when a separate REST helper fails for a wrong or mangled channel id.
- **Wake typo ignored:** add aliases in `agent/lib/discord/wake-names.ts` and cover them in `test/discord-acceptance-smoke.ts`.
- **Model re-reads current channel via tool:** pass gateway-captured history into `buildPresenceSessionMessage` and keep the prompt instruction not to call `discord_read_messages` just to re-read the current channel.
- **Discord image inspection timeout:** a `media_inspect failed` line like `Ollama vision request timed out ... OpenAI vision fallback failed: OpenAI API key missing` means local Ollama vision exceeded the per-image timeout and no hosted fallback is configured. Check `ollama ps`, `/vision-model status`, and the `agent/lib/media.ts` chunking/timeout path. If you edit media code while `clanky dev` is running, `eve dev` may restart and the current face turn can show `Dev server is unavailable`; wait for `/discord-gateway/health` `status.ready:true`, then resend the prompt if needed.

## Code Touch Points

- Gateway lifecycle and Herdr mirror: `agent/channels/discord-gateway.ts`
- Shared Herdr pane placement: `agent/lib/herdr-placement.ts`
- Voice delegate panes: `agent/channels/voice.ts`
- Discord route, per-channel history, outcomes: `agent/lib/discord/host.ts`
- Wake aliases: `agent/lib/discord/wake-names.ts`
- Presence prompt text/history: `agent/lib/discord/prompt.ts`, `agent/lib/discord/presence-payload.ts`
- REST helpers/tools: `agent/lib/discord/rest.ts`, `agent/tools/discord_*.ts`
- TUI trace/no-reply notices: `agent/lib/tui-no-reply.ts`, `scripts/clanky.ts`

## Verification

After edits, run:

```bash
node test/discord-acceptance-smoke.ts
node test/tui-no-reply-smoke.ts
node test/local-context-smoke.ts
node test/voice-fault-smoke.ts   # when touching voice fault/teardown/diagnostics
pnpm check
```

Restart `clanky` after gateway lifecycle changes; old Gateway clients can remain alive until the owning process exits.
