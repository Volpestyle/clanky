# xAI Voice Agent API

Reference snapshot for the current Grok Voice Agent WebSocket API used by Clanky's `voice_agent` runtime.

## Endpoint

Connect with a model query parameter:

```text
wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0
```

The API defaults to `grok-voice-fast-1.0`, but that model is deprecated. Clanky uses `grok-voice-think-fast-1.0` by default.

## Quick Start

```ts
import WebSocket from "ws";

const ws = new WebSocket(
  "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0",
  {
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
  }
);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "eve",
      instructions: "You are a helpful assistant.",
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } }
      }
    }
  }));

  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello!" }]
    }
  }));
  ws.send(JSON.stringify({ type: "response.create" }));
});

ws.on("message", (data) => {
  const event = JSON.parse(String(data));
  console.log("Event:", event.type);
});
```

Browsers cannot set arbitrary WebSocket headers. Browser clients authenticate with an ephemeral token in the WebSocket protocol list:

```ts
const ws = new WebSocket("wss://api.x.ai/v1/realtime", [
  `xai-client-secret.${XAI_EPHEMERAL_TOKEN}`
]);
```

## Authentication

| Method | Use Case | Notes |
|---|---|---|
| Ephemeral token | Browser and mobile clients | Preferred for client-side apps so the xAI API key stays server-side |
| API key header | Server-side clients | `Authorization: Bearer <XAI_API_KEY>` |

Ephemeral tokens are created by a server-side call to `POST https://api.x.ai/v1/realtime/client_secrets`.

## Models

| Model | Status | Description |
|---|---|---|
| `grok-voice-think-fast-1.0` | Current | Flagship Grok voice model |
| `grok-voice-fast-1.0` | Legacy | Deprecated default model |

## Session Parameters

Send `session.update` after the WebSocket opens.

| Parameter | Type | Description |
|---|---|---|
| `instructions` | string | System prompt |
| `voice` | string | Built-in voice or custom voice ID |
| `tools` | array | `file_search`, `web_search`, `x_search`, `mcp`, or `function` tools |
| `turn_detection.type` | string or null | `"server_vad"` for server VAD, `null` for manual turns |
| `turn_detection.threshold` | number | Optional VAD activation threshold, 0.1-0.9, default `0.85` |
| `turn_detection.silence_duration_ms` | number | Optional server-VAD silence duration, 0-10000 |
| `turn_detection.prefix_padding_ms` | number | Optional pre-speech padding, 0-10000, default `333` |
| `audio.input.format.type` | string | `"audio/pcm"`, `"audio/pcmu"`, or `"audio/pcma"` |
| `audio.input.format.rate` | number | PCM input sample rate |
| `audio.output.format.type` | string | `"audio/pcm"`, `"audio/pcmu"`, or `"audio/pcma"` |
| `audio.output.format.rate` | number | PCM output sample rate |

Supported PCM sample rates are `8000`, `16000`, `22050`, `24000`, `32000`, `44100`, and `48000` Hz. G.711 mu-law (`audio/pcmu`) and A-law (`audio/pcma`) use 8000 Hz.

Clanky's xAI bridge only sends and receives `audio/pcm` today. The bridge would advertise the codec on `session.update` but `XaiRealtimeClient.appendInputAudioPcm` and the playback path still operate on PCM16 — until G.711 encode/decode is added, the `audio/pcmu` and `audio/pcma` formats stay out of the user-selectable list to avoid corrupting voice audio.

Clanky uses manual turn detection for its Discord runtime because local capture, admission, barge-in, and output locking decide when audio is eligible to commit.

## Voices

| Voice | Type | Tone |
|---|---|---|
| `eve` | Female | Energetic, upbeat |
| `ara` | Female | Warm, friendly |
| `rex` | Male | Confident, clear |
| `sal` | Neutral | Smooth, balanced |
| `leo` | Male | Authoritative, strong |

Custom voice IDs from the Custom Voices API can be used as `voice` exactly like a built-in voice.

## Audio Events

Client events:

| Event | Purpose |
|---|---|
| `input_audio_buffer.append` | Append base64 PCM16 or configured input audio |
| `input_audio_buffer.commit` | Commit manually buffered audio when not using server VAD |
| `input_audio_buffer.clear` | Discard uncommitted audio |
| `conversation.item.create` | Add text messages or function outputs |
| `response.create` | Ask the model to continue/respond |
| `response.cancel` | Cancel the active response |

Server events:

| Event | Purpose |
|---|---|
| `session.created` / `session.updated` | Session lifecycle |
| `response.created` | Response lifecycle start |
| `response.output_audio.delta` | Base64 output audio chunk |
| `response.output_audio_transcript.delta` / `done` | Output transcript stream |
| `response.text.delta` / `done` | Text output stream |
| `conversation.item.input_audio_transcription.completed` | Input transcription event |
| `response.function_call_arguments.done` | Complete function-call arguments |
| `response.done` | Response lifecycle completion |
| `error` | Provider error payload |

## Tools

The Voice Agent API supports server-side tools and client-side function tools in `session.update`.

| Tool Type | Description |
|---|---|
| `file_search` | Search uploaded document collections |
| `web_search` | Search the web |
| `x_search` | Search X posts and handles |
| `mcp` | Connect to remote MCP servers over Streaming HTTP or SSE |
| `function` | Client-executed function tools with JSON Schema parameters |

Function tool example:

```json
{
  "type": "function",
  "name": "generate_random_number",
  "description": "Generate a random number between min and max values",
  "parameters": {
    "type": "object",
    "properties": {
      "min": { "type": "number" },
      "max": { "type": "number" }
    },
    "required": ["min", "max"]
  }
}
```

Function-call flow:

| Step | Event |
|---|---|
| Model requests a function | Server sends `response.function_call_arguments.done` |
| Client returns output | Client sends `conversation.item.create` with `item.type = "function_call_output"` |
| Client asks the model to continue | Client sends one `response.create` after all function outputs are submitted |

When the model emits multiple function calls for one response, resolve all of them, send one function output item for each call, then send a single `response.create`. Do not create the continuation response before every function output is available.

## OpenAI Realtime Compatibility Notes

The API is mostly compatible with OpenAI Realtime clients when the base URL is changed to `wss://api.x.ai/v1/realtime`.

Event naming difference:

| OpenAI GA Event | xAI Event |
|---|---|
| `response.output_text.delta` | `response.text.delta` |

Unsupported client events include `conversation.item.retrieve`, `conversation.item.truncate`, and WebRTC/SIP-only `output_audio_buffer.clear`.

Unsupported server events include `conversation.item.done`, `conversation.item.input_audio_transcription.delta`, `conversation.item.input_audio_transcription.failed`, `conversation.item.input_audio_transcription.segment`, `rate_limits.updated`, and WebRTC/SIP-only output-buffer events.
