# Discord Voice Architecture

This is the end-to-end map for Clanky's agent-owned Discord voice path. The
important distinction is that Discord voice is not one Pi chat turn. It is a
TypeScript control plane, a Rust Discord media plane, and Pi delegation behind a
live realtime voice agent session. The realtime agent provider can be OpenAI
Realtime or xAI Grok Voice. The speech output provider is only the audio
renderer; it is not the same setting as the realtime reasoning/tool agent. There
is no ElevenLabs-only Discord voice mode: ElevenLabs can replace the final voice
rendering step, but a realtime agent still owns the conversation loop.

```mermaid
flowchart TB
  subgraph inbound["Inbound path"]
    direction LR
    speaker["Discord speaker"] --> rtp["Discord RTP"]
    rtp --> vox["clankvox media plane"]
    vox --> bridge["TypeScript voice bridge"]
    bridge --> stt["OpenAI per-speaker STT"]
    stt --> realtime["required main Realtime agent<br/>OpenAI Realtime or xAI Grok Voice"]
  end

  realtime --> toolChoice{"agent decision<br/>speak, stay silent, or call tools"}

  subgraph delegation["Delegation and media"]
    direction LR
    pi["ask_pi to warm voice supervisor"] --> supervisor["voice worker subagent"]
    supervisor --> general["voice-general subagents"]
    supervisor --> mainAgent["main Clanky handoff"]
    general --> supervisor
    mainAgent --> supervisor
    supervisor --> toolReturn["tool output"]
    statusTools["pi_status / pi_subagents"] --> controlState["runtime queue + subagent store"]
    controlState --> toolReturn
    mediaTools["media and screen tools"] --> toolReturn
  end

  toolChoice -->|ask_pi| pi
  toolChoice -->|status| statusTools
  toolChoice -->|media or stream| mediaTools
  toolChoice -->|speak without tool| speechChoice
  toolChoice -->|voice_stay_silent| silent["no Discord audio"]
  toolReturn --> speechChoice{"speech renderer<br/>selected by tts-provider"}

  subgraph outbound["Outbound speech"]
    direction LR
    realtimeAudio["selected realtime agent audio deltas"] --> playback["PCM to clankvox"]
    elevenText["realtime text response to ElevenLabs TTS"] --> playback
    playback --> outboundRtp["Opus RTP to Discord"]
  end

  speechChoice -->|tts-provider openai<br/>internal realtime audio| realtimeAudio
  speechChoice -->|tts-provider elevenlabs<br/>external TTS only| elevenText
```

## Provider Split

Discord voice has separate provider choices for reasoning and speech. Treating
ElevenLabs as "the voice agent" is the oversimplification this architecture
avoids.

| Concern | Setting | Provider | What it owns |
| --- | --- | --- | --- |
| Main realtime voice agent | `realtime-provider`, plus OpenAI/xAI model settings | OpenAI Realtime or xAI Grok Voice | Required for every joined voice session. Owns instructions, participation policy, whether to speak, realtime tool calls, Pi delegation, interruption state, and response continuation after tools. |
| Speaker transcription | OpenAI realtime transcription settings | OpenAI Realtime transcription | One STT session per active Discord speaker. Produces labeled final transcripts for the main realtime agent. |
| Speech renderer | `tts-provider` | Internal realtime audio or ElevenLabs TTS | Converts the main realtime agent's response into PCM for `clankvox`. It does not own room state, tool calls, or Pi delegation. |
| Discord media transport | native `clankvox` process | Discord voice/Go Live protocol code | Moves PCM/RTP/video/media frames between Discord and TypeScript. It does not decide what Clanky says. |

`tts-provider=openai` is the internal realtime-audio path. Despite the stored
name, it means "use audio emitted by the selected realtime agent"; if
`realtime-provider=xai`, the outbound audio comes from Grok Voice. In
`tts-provider=elevenlabs` mode, the main realtime agent is still connected, but
its `responseOutputModality` is text. TypeScript accumulates that text and sends
it to ElevenLabs for external TTS.

The practical combinations are:

- OpenAI Realtime agent with internal OpenAI realtime audio.
- OpenAI Realtime agent with ElevenLabs TTS.
- xAI Grok Voice realtime agent with internal xAI audio.
- xAI Grok Voice realtime agent with ElevenLabs TTS.

The unsupported combination is "ElevenLabs by itself." ElevenLabs never receives
Discord room audio, never sees the tool schema, never calls `ask_pi`, never
chooses `voice_stay_silent`, and never continues after a tool result. It only
renders speakable text that the realtime agent already decided to say.

## Runtime Roles

`agents/clanky/src/discordGatewayController.ts` decides whether Clanky owns the
Discord text client, a voice-only client, or no Discord client. Room-owned
AgentRoom text connectors do not own this voice bridge; voice uses Clanky's
agent-owned Discord credential.

`agents/clanky/src/agentDiscordVoice.ts` is the TypeScript voice orchestrator.
It resolves settings, starts the selected realtime agent client, starts the
OpenAI speaker transcription client, starts `clankvox`, dispatches tools,
handles interruption policy, and records voice subagent context.

`agents/clanky/src/voice/clankvox/` is the Rust media process. It owns Discord
voice transport details: voice gateway connection, RTP/RTCP, DAVE encryption,
Opus encode/decode, screen stream watch/publish, music/video playback, and PCM
IPC to Node.

Pi is downstream of the realtime agent. The voice agent can call `ask_pi`,
which either uses the voice worker subagent coordinator or serializes a prompt
through the main Pi runtime.

xAI Grok Voice supports the live audio/tool agent path but does not currently
receive Discord screen-share image frames in this bridge. OpenAI Realtime
remains the provider for screen-watch snapshot inspection.

## Startup

`createClankyRuntime()` installs the `/discord-voice` slash command and the
model-facing tools `discord_voice_status`, `discord_voice_join`, and
`discord_voice_leave`.

`ClankyDiscordGatewayController.start()` resolves Discord ownership. When text
chat is agent-owned, voice shares that Discord client. When text chat is
suppressed by `CLANKY_CHAT_GATEWAY_OWNER`, voice can still create a voice-only
client with voice-state intents.

`resolveAgentDiscordVoiceConfig()` combines environment variables, stored
profile settings from `discord-voice.json`, stored auth entries, and default
Realtime settings. A fixed guild/channel target is a saved target, not a startup
join request. Startup only joins it when auto-join is explicitly enabled for
dev/live-test runs; otherwise `/discord-voice join` or the `discord_voice_join`
tool provides the join intent.

`AgentDiscordVoiceBridge.start()` connects the pieces: stream discovery,
Realtime response session, `clankvox` IPC, per-speaker transcription manager,
tool handlers, optional ElevenLabs client, and voice worker recording. When a
subagent runtime factory is available, it also prewarms the voice worker so the
first `ask_pi` turn does not pay the worker creation cost.

The main realtime client is selected before speech rendering:

1. Build provider options from the selected realtime provider credential and base
   URL.
2. Instantiate `OpenAiRealtimeClient` or `XAiRealtimeClient`.
3. Connect it with model, voice, instructions, voice tools, `toolChoice: "auto"`,
   and `responseOutputModality`.
4. If `tts-provider=elevenlabs`, set `responseOutputModality` to `text` and
   create the ElevenLabs synthesizer beside the realtime session. If not, keep
   `responseOutputModality` as `audio` and play the realtime agent audio deltas
   directly.

## Inbound Audio

Discord audio does not go directly into the main Realtime response session.
`clankvox` receives encrypted Discord RTP, decrypts it, decodes Opus, tracks
speakers, and emits per-user PCM frames to Node over IPC.

For each active Discord speaker,
`discordVoiceSpeakerTranscription.ts` opens an individual OpenAI Realtime
transcription session. Final transcripts are labeled with the Discord user and
batched by `CLANKY_DISCORD_VOICE_TRANSCRIPT_RESPONSE_BATCH_DELAY_MS` before
being inserted as text turns into the main Realtime response session.

That design keeps speaker attribution outside the model guesswork and avoids
feeding a mixed room audio stream into the response session.

## Response Audio

The main Realtime session is the live voice brain. It receives labeled text
turns, can call tools, and creates responses.

In the default speech path, Realtime emits PCM audio deltas. TypeScript forwards
those deltas to `clankvox`, which resamples as needed, encodes Opus frames, and
sends Discord voice RTP.

In ElevenLabs mode, Realtime output modality is text. TypeScript accumulates
the response text, streams it through ElevenLabs TTS, and sends the returned
PCM to `clankvox` for the same Discord playback path.

This means the interruption and tool lifecycle is identical in both speech
paths: wake-name barge-in cancels the active realtime response, Realtime emits
function-call events, TypeScript executes local tool handlers, sends function
outputs back to Realtime, and then asks Realtime to continue. ElevenLabs only
participates after that continuation has produced text to speak.

## Tools And Pi Delegation

Realtime tool calls are handled in `agentDiscordVoice.ts`. The dispatcher
normalizes streaming and completed function-call events, dedupes call ids,
executes the local handler, sends the function output back to Realtime, and
then asks Realtime to continue the response.

The core work tool is `ask_pi`. It passes the voice context to Pi for longer
reasoning, repo-aware work, skills, and normal Clanky tool use. If a voice
worker subagent is configured, `ask_pi` goes through the always-warm voice
supervisor in `discordVoiceSubagentCoordinator.ts`; otherwise it uses the main
runtime through a serial queue so voice requests do not race each other.

The voice supervisor is a real Clanky subagent: it uses the same runtime
factory shape as the main agent, with the subagent effort default. Its context
explicitly says that it is below the main foreground Clanky agent, that the
main agent owns the user's primary window, AgentRoom/tmux authority, and final
foreground coordination, and that the realtime voice agent owns live speech and
media.

Only the voice supervisor gets the privileged `voice_delegate_to_subagent`
tool. That tool runs a `voice-general` subagent for bounded helper work. Those
general workers get normal Clanky tools, skills, memory, `main_session_context`,
`subagent_status`, and `delegate_to_main_worker`, but they do not receive the
child-spawn tool. Ordinary Discord text subagents also do not receive it.

The realtime voice agent does not mirror every tool that the main Pi agent can use.
That would duplicate authorization, tool schemas, and runtime policy in the
low-latency Realtime session. Instead, voice has a small control surface:

- `ask_pi` delegates work to the Pi layer.
- `pi_status` reports the main runtime queue, current voice bridge state, and
  a concise subagent summary.
- `pi_subagents` lists tracked subagents and workers, with filters for kind,
  state, stale entries, and result limit.

Those status tools read the same runtime queue and `DiscordSubagentStore` that
the text gateway and subagent coordinator already use. They are meant for
questions like "what is the main agent doing?", "is the voice worker busy?",
or "did a subagent fail?" without creating a new Pi turn just to inspect local
state.

Media tools are intentionally URL-first:

- `play_music_url`
- `play_video_url`
- `start_music_visualizer`
- `media_pause`
- `media_resume`
- `media_stop`
- `media_status`

Search, selection, and higher-level media decisions should happen through
`ask_pi`; the media tools only play resolved URLs.

## Screen Share And Go Live

`discordStreamDiscovery.ts` watches raw Discord gateway stream events and sends
the native stream opcodes needed to watch, stop watching, publish, pause, or
delete streams. TypeScript forwards stream metadata to `clankvox`, which owns
the Discord voice/video media details.

Bot tokens are enough for normal voice audio and music playback. Native screen
watch and Go Live publish depend on Discord user-token behavior and should be
treated as live-gated.

## Floor Control

The bridge tracks when Clanky is speaking through Realtime output duration,
pending playback buffer depth, and active external TTS. While Clanky is
speaking, ordinary speaker transcripts are recorded but not forwarded to the
response session.

Addressed wake-name transcripts interrupt. Saying `Clanky`, `clank`, or a
configured alias stops playback, cancels the active Realtime response, and
forwards the transcript so the model can answer the interruption.

## Operational Checks

Use `docs/discord-voice-live-runbook.md` for live verification. The important
counters prove separate parts of the bridge:

- Discord join and input audio prove the gateway and `clankvox` capture path.
- Realtime session acceptance proves model connectivity and configuration.
- Output audio proves the selected speech output provider and Discord playback path.
- Tool-call and `ask_pi` counters prove Realtime-to-Pi delegation.
- Stream and media counters prove native Go Live or media playback behavior.

Non-live checks are still useful before credentials are involved:

```bash
pnpm check
pnpm smoke:voice
pnpm voice:native:check
pnpm voice:build
```

## Source Map

- TypeScript orchestrator: `agents/clanky/src/agentDiscordVoice.ts`
- Discord ownership: `agents/clanky/src/discordGatewayController.ts`
- Voice settings: `agents/clanky/src/discordVoiceSettings.ts`
- Realtime adapter: `agents/clanky/src/voice/openAiRealtimeClient.ts`
- xAI realtime adapter: `agents/clanky/src/voice/xAiRealtimeClient.ts`
- Per-speaker STT: `agents/clanky/src/voice/discordVoiceSpeakerTranscription.ts`
- ElevenLabs TTS adapter: `agents/clanky/src/voice/elevenLabsTtsClient.ts`
- Rust IPC client: `agents/clanky/src/voice/clankvoxIpcClient.ts`
- Rust media process: `agents/clanky/src/voice/clankvox/src/main.rs`
- Rust voice/audio pipeline:
  `agents/clanky/src/voice/clankvox/docs/audio-pipeline.md`
- Rust Go Live details: `agents/clanky/src/voice/clankvox/docs/go-live.md`
