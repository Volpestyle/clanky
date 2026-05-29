# Command Reference

This page lists the user-facing commands a new Clanky user is likely to need.
Most slash commands are Pi commands, Clanky extension commands, or skill
commands registered inside the Pi TUI.

For deeper behavior of inherited Pi commands, use the upstream
[Pi command docs](https://pi.dev/docs/latest/usage#slash-commands). This page
focuses on the Clanky-specific command surface and how the Pi commands show up
inside Clanky.

## CLI

Run Clanky:

```bash
clanky
clanky --profile personal --home ~/.clanky --cwd .
clanky --message "Summarize this repository"
```

Options:

| Option | Meaning |
| --- | --- |
| `--profile <name>` | Active Clanky profile. Defaults to env `CLANKY_PROFILE`, active profile file, or `default`. |
| `--home <dir>` | Clanky home dir. Defaults to env `CLANKY_HOME` or `~/.clanky`. |
| `--cwd <dir>` | Working directory for Pi tools, context files, and session grouping. |
| `--message <text>` | Initial message sent when the TUI opens. |

Discord operator CLI:

```bash
clanky discord guilds
clanky discord channels <guild-id-or-name> --since 24h
clanky discord messages <channel-id> --limit 50
clanky discord recent [guild-id-or-name] --since 24h
clanky discord send <channel-id> "message text" --file ./path.png
clanky discord emojis <guild-id-or-name>
clanky discord react <channel-id> <message-id> <emoji>
```

Log dive CLI:

```bash
clanky logs
clanky logs --profile personal --home ~/.clanky --session latest
clanky logs --json
```

## Setup Slash Commands

| Command | Meaning |
| --- | --- |
| `/setup` | Open the profile-local onboarding and connector setup wizard. |
| `/setup status` | Show profile paths and connector status. |
| `/setup fresh` | Show the fresh-user test command. |
| `/profile` | Show Clanky profile paths and chat gateway ownership. |
| `/effort` | Show main and subagent reasoning effort. |
| `/effort main <level>` | Set main Clanky thinking level. |
| `/effort subagents <level>` | Set active/default subagent thinking level. |
| `/effort all <level>` | Set both. |
| `/auth` | List stored provider credentials in the active Clanky profile. |
| `/auth remove <provider>` | Remove stored credentials for one provider. |
| `/auth remove all` | Remove all stored provider credentials from the active profile. |

Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

## Pi Slash Commands

These are inherited from Pi and work inside Clanky:

| Command | Meaning |
| --- | --- |
| `/login`, `/logout` | Manage Pi provider credentials. |
| `/model` | Select model. |
| `/scoped-models` | Configure model cycling. |
| `/settings` | Open Pi settings. |
| `/resume` | Pick a previous session. |
| `/new` | Start a new session. |
| `/name <name>` | Set session display name. |
| `/session` | Show session file, ID, messages, tokens, and cost. |
| `/tree` | Navigate the current session tree. |
| `/fork` | Create a new session from an earlier user message. |
| `/clone` | Duplicate the active branch into a new session. |
| `/compact [prompt]` | Manually compact context. |
| `/copy` | Copy the last assistant message. |
| `/export [file]` | Export the session. |
| `/share` | Share session as a private gist-backed HTML page. |
| `/reload` | Reload context files, skills, prompts, themes, and extensions. |
| `/hotkeys` | Show all keyboard shortcuts. |
| `/changelog` | Show Pi version history. |
| `/quit` | Quit the TUI. |

## Auth Commands

| Command | Meaning |
| --- | --- |
| `/openai-login` | Store an OpenAI API key in the active Clanky profile. |
| `/openai-whoami` | Show active OpenAI credential source. |
| `/openai-logout` | Remove the stored OpenAI credential. |
| `/discord-login` | Configure Clanky's agent-owned Discord credential. |
| `/discord-whoami` | Show which Discord credential the next launch will use. |
| `/discord-status` | Show active Discord adapter chat and voice bridge counters. |
| `/discord-logout` | Remove the stored Discord credential. |
| `/xai-login` | Store an xAI API key in the active profile. |
| `/xai-whoami` | Show active xAI credential source. |
| `/xai-logout` | Remove the stored xAI credential. |
| `/elevenlabs-login` | Store an ElevenLabs API key in the active profile. |
| `/elevenlabs-whoami` | Show active ElevenLabs credential source. |
| `/elevenlabs-logout` | Remove the stored ElevenLabs credential. |

`/auth remove` edits only the active profile `auth.json`. Environment variables
and `models.json` request auth still override stored credentials where supported.

## Discord Voice Commands

| Command | Meaning |
| --- | --- |
| `/discord-voice` | Show status or open setup when unconfigured. |
| `/discord-voice setup` | Open voice setup UI. |
| `/discord-voice status` | Show voice settings and bridge state. |
| `/discord-voice enable` | Enable voice access. |
| `/discord-voice join <guild-id> <voice-channel-id>` | Pin and join a voice channel. |
| `/discord-voice allow-server <guild-id> [...]` | Configure allowed voice servers. |
| `/discord-voice allow-channel <voice-channel-id> [...]` | Configure allowed voice channels. |
| `/discord-voice allow <voice-channel-id> [...]` | Alias for channel allowlist. |
| `/discord-voice set auto-join on\|off` | Toggle startup auto-join for the pinned voice channel. |
| `/discord-voice set realtime-provider xai` | Use xAI Grok Voice as the realtime reasoning/tool agent. |
| `/discord-voice set realtime-provider openai` | Use OpenAI Realtime as the realtime reasoning/tool agent. |
| `/discord-voice set xai-model <model-id>` | Override the xAI Grok Voice realtime model. |
| `/discord-voice set xai-voice <voice-id>` | Override the xAI Grok Voice output voice. |
| `/discord-voice set tts-provider elevenlabs` | Use ElevenLabs as the speech output provider instead of the selected realtime agent audio. |
| `/discord-voice set elevenlabs-voice <voice-id>` | Store ElevenLabs voice id. |
| `/discord-voice set elevenlabs-output-format pcm_24000` | Store ElevenLabs PCM output format. |
| `/discord-voice set eagerness <0-100>` | Set how often Clanky chooses to speak in voice. |
| `/discord-voice clear` | Clear stored voice settings. |
| `/discord-voice disable` | Disable voice access. |
| `/voice-logs` or `/voice_logs` | Open live Discord voice logs. |
| `/voice-logs tail` | Show the recent voice log tail. |
| `/voice-logs path` | Show voice log path. |
| `/voice-logs clear` | Clear the voice log. |

## Memory Commands

| Command | Meaning |
| --- | --- |
| `/who_are_you` | Show Clanky's self memory. |
| `/privacy` | Show the memory privacy policy. |
| `/why_did_you_say_that` | Show the latest memory packet used for a response. |
| `/what_do_you_remember [query]` | Search memory. |
| `/forget_me` | Forget local user-scoped memories. |
| `/forget_this_channel <channel-id>` | Forget memories scoped to a channel. |
| `/memory view [query]` | View/search memory. |
| `/memory remember <claim>` | Store an explicit memory claim. |
| `/memory reflect` | Queue a daily reflection over enough recent transcript and propose durable memories. |
| `/memory forget <id>` | Forget a memory atom. |
| `/memory export` | Export profile memory. |
| `/memory on` | Enable local user memory. |
| `/memory off` | Disable local user memory. |
| `/memory_reflect` | Alias for `/memory reflect`. |
| `/memory_export` | Export profile memory. |
| `/memory_off` | Disable local user memory. |

## Operations Commands

| Command | Meaning |
| --- | --- |
| `/skills` | Show loaded Clanky skills. |
| `/skill list` | List skills. |
| `/skill add <name>` | Create a profile-local Clanky skill. |
| `/skill:<name>` | Force-load a skill through Pi's skill command path. |
| `/mcp` | Show configured external MCP servers and tool status. |
| `/web` | Show web operator backend status. |
| `/media` | Show media backend status. |
| `/subagents` | Toggle the live subagent panel. |
| `/subagents focus` | Focus panel keyboard selection. |
| `/subagents chat` | Open the selected subagent transcript. |
| `/subagents modal` | Open the subagent browser. |
| `/subagents panel` | Show the panel. |
| `/subagents hide` | Hide the panel. |
| `/subagents status` | Print subagent status once. |
| `/subagents json` | Print raw subagent status. |
| `/cron` | Show configured Clanky scheduled jobs when scheduler handlers are wired. |

## Model-Facing Tool Families

Users usually ask in natural language. The model can call these tools when they
are available and credentials/policy allow it:

- Memory: `memory_remember`, `memory_search`, `memory_forget`.
- Web: `web_search`, `web_backend_status`.
- Media: `openai_image_generate`, `xai_image_generate`, `xai_video_generate`,
  `media_backend_status`.
- Discord text/media: `discord_list_guilds`, `discord_list_channels`,
  `discord_read_messages`, `discord_recent_activity`,
  `discord_recent_attachments`, `discord_send_message`,
  `discord_list_emojis`, `discord_add_reaction`.
- Discord voice: `discord_voice_status`, `discord_voice_join`,
  `discord_voice_leave`.
- Coordination: `main_session_context`, `delegate_to_main_worker`,
  `subagent_status`.
- Work tracking: `work_tracker_link` for binding issues created or found through
  MCP, CLI, or tracker-specific skills to the current Clanky session.
- MCP: `mcp_list_tools`, `mcp_call`.

`schedule_cron` exists in the shared tool layer, but is only present in a
runtime when its handler is wired. It is not part of the default Pi
foreground-thread path.
