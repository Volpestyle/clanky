# mcp-servers/minecraft

MCP server (stdio + HTTP) that lets Clanky control a Mineflayer bot with high-level Minecraft Java actions.

## Architecture

```
Discord voice/text
  -> Clanky (LLM decides to call a minecraft_* tool)
  -> HTTP POST to this server's /tools/call
  -> MinecraftBotController
  -> Mineflayer bot
  -> Minecraft Java Edition server
```

Two entry points share the same controller and tool dispatch:

- **`http-server.ts`** — HTTP server for Clanky's voice MCP pipeline (`VOICE_MCP_SERVERS_JSON`)
- **`index.ts`** — stdio MCP server for Claude Code or other MCP clients

## Tools

| Tool | Description |
|---|---|
| `minecraft_connect` | Connect bot to a Minecraft Java server |
| `minecraft_disconnect` | Disconnect cleanly |
| `minecraft_status` | Full state snapshot: health, food, position, players, inventory, task |
| `minecraft_chat` | Send a chat message |
| `minecraft_list_players` | List players with distance/position |
| `minecraft_follow_player` | Durable follow mode |
| `minecraft_guard_player` | Follow + auto-attack nearby hostiles |
| `minecraft_go_to` | Pathfind to coordinates |
| `minecraft_look_at_player` | Turn to face a player |
| `minecraft_collect_block` | Mine nearby blocks by canonical ID |
| `minecraft_attack_nearest_hostile` | Attack nearest hostile mob |
| `minecraft_inventory` | List inventory |
| `minecraft_recent_events` | Timestamped event log |
| `minecraft_stop` | Cancel all autonomous behavior |

## Requirements

- Node 22+
- Minecraft Java Edition server (local/private recommended)

## Install & build

```bash
cd mcp-servers/minecraft
npm install
npm run build
```

## Running

### HTTP server (for Clanky runtime)

```bash
npm run start:http        # production
npm run dev:http          # dev mode (tsx, no build needed)
```

Default: `http://127.0.0.1:3847`. Override with `MC_HTTP_PORT` and `MC_HTTP_HOST`.

Endpoints:
- `POST /tools/call` — `{ "toolName": "minecraft_follow_player", "arguments": { "playerName": "Steve" } }`
- `GET /tools/list` — list all available tools
- `GET /health` — connection status check

### Stdio MCP server (for Claude Code)

```bash
npm run start             # production
npm run dev               # dev mode
```

## Connecting to Clanky

Add to your `.env` (or set the env var directly):

```bash
VOICE_MCP_SERVERS_JSON='[{"serverName":"minecraft","baseUrl":"http://127.0.0.1:3847","toolPath":"/tools/call","timeoutMs":30000,"tools":[{"name":"minecraft_connect","description":"Connect bot to a Minecraft Java server. Use this before other minecraft_* tools.","inputSchema":{"type":"object","properties":{"host":{"type":"string"},"port":{"type":"number"},"username":{"type":"string"},"auth":{"type":"string"}}}},{"name":"minecraft_disconnect","description":"Disconnect the bot from the current server.","inputSchema":{"type":"object","properties":{"reason":{"type":"string"}}}},{"name":"minecraft_status","description":"Get the bot world state: health, food, position, players, inventory, current task.","inputSchema":{"type":"object","properties":{}}},{"name":"minecraft_chat","description":"Send a chat message into Minecraft.","inputSchema":{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}},{"name":"minecraft_list_players","description":"List players and their distance from the bot.","inputSchema":{"type":"object","properties":{}}},{"name":"minecraft_follow_player","description":"Start following a player. Stays active until minecraft_stop.","inputSchema":{"type":"object","required":["playerName"],"properties":{"playerName":{"type":"string"},"distance":{"type":"number"}}}},{"name":"minecraft_guard_player","description":"Guard a player: follow them and attack nearby hostile mobs.","inputSchema":{"type":"object","required":["playerName"],"properties":{"playerName":{"type":"string"},"radius":{"type":"number"},"followDistance":{"type":"number"}}}},{"name":"minecraft_go_to","description":"Pathfind to target coordinates.","inputSchema":{"type":"object","required":["x","y","z"],"properties":{"x":{"type":"number"},"y":{"type":"number"},"z":{"type":"number"},"range":{"type":"number"}}}},{"name":"minecraft_look_at_player","description":"Turn to face a player.","inputSchema":{"type":"object","required":["playerName"],"properties":{"playerName":{"type":"string"}}}},{"name":"minecraft_collect_block","description":"Collect nearby blocks by Minecraft block id (e.g. oak_log, cobblestone).","inputSchema":{"type":"object","required":["blockName"],"properties":{"blockName":{"type":"string"},"count":{"type":"number"},"maxDistance":{"type":"number"}}}},{"name":"minecraft_attack_nearest_hostile","description":"Attack the nearest hostile mob.","inputSchema":{"type":"object","properties":{"maxDistance":{"type":"number"}}}},{"name":"minecraft_inventory","description":"List the bot inventory items and counts.","inputSchema":{"type":"object","properties":{}}},{"name":"minecraft_recent_events","description":"Return recent bot events like spawn, deaths, chat, kicks, errors.","inputSchema":{"type":"object","properties":{"limit":{"type":"number"}}}},{"name":"minecraft_stop","description":"Stop current follow/guard/pathfinding/combat and return to idle.","inputSchema":{"type":"object","properties":{}}}]}]'
```

Then start the HTTP server before (or alongside) Clanky. When Clanky joins a voice channel, the Minecraft tools appear in the LLM's available tool set.

## Environment variables

All optional — `minecraft_connect` tool can override at call time.

| Var | Default | Purpose |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | Minecraft server host |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `ClankyBuddy` | Bot username |
| `MC_AUTH` | `offline` | Auth mode (`offline` or `microsoft`) |
| `MC_VERSION` | auto-detect | Explicit protocol version |
| `MC_HTTP_PORT` | `3847` | HTTP server listen port |
| `MC_HTTP_HOST` | `127.0.0.1` | HTTP server listen host |

## Claude Code config

For using as a stdio MCP server with Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": ["C:/Users/volpe/clanky/mcp-servers/minecraft/dist/index.js"],
      "env": {
        "MC_HOST": "127.0.0.1",
        "MC_PORT": "25565",
        "MC_USERNAME": "ClankyBuddy",
        "MC_AUTH": "offline"
      }
    }
  }
}
```

## Server IP auto-discovery

When `minecraft_connect` is called without an explicit `host`, the MCP server checks
`https://volpestyle-minecraft-worlds.s3.amazonaws.com/server-info.json` for the current
server IP (written automatically by the deploy workflow in `Volpestyle/minecraft-server`).

If S3 is unreachable or the server isn't deployed, it falls back to `MC_HOST` env var or `127.0.0.1`.

## Microsoft auth (real Minecraft account)

To give Clanky a real Minecraft account with a proper skin and profile:

1. Buy a Minecraft Java Edition account (~$30) and link it to a Microsoft account
2. Set environment variables:
   ```bash
   MC_AUTH=microsoft
   MC_USERNAME=<email or gamertag>
   MC_PROFILES_FOLDER=./auth-cache
   ```
3. **First run only**: Mineflayer will print a Microsoft device-code login URL to stderr.
   Open it in a browser, log in with the Minecraft account, and approve. The token is cached
   in `MC_PROFILES_FOLDER` for subsequent runs.
4. Set `online-mode=true` on the Minecraft server (or keep offline — both work with Microsoft auth)

After the one-time auth, Clanky joins with a real profile, real skin, and shows up on friends lists.

## Runtime behavior

The `MinecraftSession` in the main bot handles the full lifecycle automatically:

- **Auto-connect**: When the LLM calls `minecraft_task` with a command like "follow me",
  the session detects the bot isn't connected and auto-connects using the MCP server's
  host resolution (S3 discovery -> `MC_HOST` env -> localhost). No explicit "connect"
  step needed from the user.
- **Reflex tick loop**: A background loop polls status every 5 seconds, evaluates
  deterministic reflexes (eat when hungry, flee when low health near hazards, attack
  nearby threats), and executes them autonomously. Hazards come from the MCP status
  snapshot's nearby hostile-entity scan.
- **Single companion session**: Discord text and voice reuse the same live Minecraft
  session for the same user. Other users cannot inspect, continue, or cancel that
  session while it is active.
- **Event tracking**: Game events (chat, death, combat) are diffed against a watermark
  so status reports only surface new events. An `onGameEvent` callback forwards events
  to the action log for proactive narration.
- **Chat brain**: When another player speaks in Minecraft chat, the session detects
  the event, feeds it to the same LLM brain used for Discord text (persona, guidance,
  memory), and replies via `minecraft_chat`. The brain can also trigger game actions
  via `[ACTION: ...]` prefixes (e.g. "follow me" in chat makes the bot follow).
- **Multi-channel**: Minecraft chat and Discord voice are independent input channels.
  Clanky responds to each in its native medium — chat replies stay in Minecraft chat,
  voice replies stay in Discord voice. Both work simultaneously.
- **Voice + text**: The `minecraft_task` tool is available on both the text reply and
  voice realtime surfaces. You can ask Clanky to join your Minecraft server via Discord
  voice chat and he'll control his character while talking to you.

## Known gaps

- No crafting pipeline
- No chest deposit / home base workflow
- No building planner
- No first-person vision (uses Mineflayer's structured game state)
- Hazard detection not yet exposed by MCP status (guard mode handles combat reactively at the Mineflayer level)
- Proactive event narration in Discord (events are logged but not yet pushed to channels unprompted)
