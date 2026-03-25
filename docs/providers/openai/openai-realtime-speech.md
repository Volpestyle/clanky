# Realtime conversations

Once you have connected to the Realtime API through either [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) or [WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket), you can call a Realtime model (such as [gpt-realtime](https://developers.openai.com/api/docs/models/gpt-realtime)) to have speech-to-speech conversations. Doing so will require you to **send client events** to initiate actions, and **listen for server events** to respond to actions taken by the Realtime API.

This guide will walk through the event flows required to use model capabilities like audio and text generation, image input, and function calling, and how to think about the state of a Realtime Session.

If you do not need to have a conversation with the model, meaning you don't
  expect any response, you can use the Realtime API in [transcription
  mode](https://developers.openai.com/api/docs/guides/realtime-transcription).

## Realtime speech-to-speech sessions

A Realtime Session is a stateful interaction between the model and a connected client. The key components of the session are:

- The **Session** object, which controls the parameters of the interaction, like the model being used, the voice used to generate output, and other configuration.
- A **Conversation**, which represents user input Items and model output Items generated during the current session.
- **Responses**, which are model-generated audio or text Items that are added to the Conversation.

**Input audio buffer and WebSockets**

If you are using WebRTC, much of the media handling required to send and receive audio from the model is assisted by WebRTC APIs.

<br/>
If you are using WebSockets for audio, you will need to manually interact with the **input audio buffer** by sending audio to the server, sent with JSON events with base64-encoded audio.

All these components together make up a Realtime Session. You will use client events to update the state of the session, and listen for server events to react to state changes within the session.

![diagram realtime state](https://openaidevs.retool.com/api/file/11fe71d2-611e-4a26-a587-881719a90e56)

## Session lifecycle events

After initiating a session via either [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) or [WebSockets](https://developers.openai.com/api/docs/guides/realtime-websockets), the server will send a [`session.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/created) event indicating the session is ready. On the client, you can update the current session configuration with the [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) event. Most session properties can be updated at any time, except for the `voice` the model uses for audio output, after the model has responded with audio once during the session. The maximum duration of a Realtime session is **60 minutes**.

The following example shows updating the session with a `session.update` client event. See the [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc#sending-and-receiving-events) or [WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket#sending-and-receiving-events) guide for more on sending client events over these channels.

Update the system instructions used by the model in this session

```javascript
const event = {
  type: "session.update",
  session: {
      type: "realtime",
      model: "gpt-realtime",
      // Lock the output to audio (set to ["text"] if you want text without audio)
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "semantic_vad"
          }
        },
        output: {
          format: {
            type: "audio/pcm",
          },
          voice: "marin",
        }
      },
      // Use a server-stored prompt by ID. Optionally pin a version and pass variables.
      prompt: {
        id: "pmpt_123",          // your stored prompt ID
        version: "89",           // optional: pin a specific version
        variables: {
          city: "Paris"          // example variable used by your prompt
        }
      },
      // You can still set direct session fields; these override prompt fields if they overlap:
      instructions: "Speak clearly and briefly. Confirm understanding before taking actions."
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
event = {
    "type": "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      # Lock the output to audio (add "text" if you also want text)
      output_modalities: ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
          },
          turn_detection: {
            type: "semantic_vad"
          }
        },
        output: {
          format: {
            type: "audio/pcmu",
          },
          voice: "marin",
        }
      },
      # Use a server-stored prompt by ID. Optionally pin a version and pass variables.
      prompt: {
        id: "pmpt_123",          // your stored prompt ID
        version: "89",           // optional: pin a specific version
        variables: {
          city: "Paris"          // example variable used by your prompt
        }
      },
      # You can still set direct session fields; these override prompt fields if they overlap:
      instructions: "Speak clearly and briefly. Confirm understanding before taking actions."
    }
}
ws.send(json.dumps(event))
```


When the session has been updated, the server will emit a [`session.updated`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/updated) event with the new state of the session.

<table>
  <tr>
    <th>Related client events</th>
    <th>Related server events</th>
  </tr>
  <tr>
    <td>
      [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)
    </td>
    <td>
      [`session.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/created)
      <div />
      [`session.updated`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/updated)
    </td>
  </tr>
</table>

## Text inputs and outputs

To generate text with a Realtime model, you can add text inputs to the current conversation, ask the model to generate a response, and listen for server-sent events indicating the progress of the model's response. In order to generate text, the [session must be configured](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) with the `text` modality (this is true by default).

Create a new text conversation item using the [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create) client event. This is similar to sending a [user message (prompt) in Chat Completions](https://developers.openai.com/api/docs/guides/text-generation) in the REST API.

Create a conversation item with user input

```javascript
const event = {
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "What Prince album sold the most copies?",
      }
    ]
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
event = {
    "type": "conversation.item.create",
    "item": {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "What Prince album sold the most copies?",
            }
        ]
    }
}
ws.send(json.dumps(event))
```


After adding the user message to the conversation, send the [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) event to initiate a response from the model. If both audio and text are enabled for the current session, the model will respond with both audio and text content. If you'd like to generate text only, you can specify that when sending the `response.create` client event, as shown below.

Generate a text-only response

```javascript
const event = {
  type: "response.create",
  response: {
    output_modalities: [ "text" ]
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
event = {
    "type": "response.create",
    "response": {
        "output_modalities": [ "text" ]
    }
}
ws.send(json.dumps(event))
```


When the response is completely finished, the server will emit the [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done) event. This event will contain the full text generated by the model, as shown below.

Listen for response.done to see the final results

```javascript
function handleEvent(e) {
  const serverEvent = JSON.parse(e.data);
  if (serverEvent.type === "response.done") {
    console.log(serverEvent.response.output[0]);
  }
}

// Listen for server messages (WebRTC)
dataChannel.addEventListener("message", handleEvent);

// Listen for server messages (WebSocket)
// ws.on("message", handleEvent);
```

```python
def on_message(ws, message):
    server_event = json.loads(message)
    if server_event.type == "response.done":
        print(server_event.response.output[0])
```


While the model response is being generated, the server will emit a number of lifecycle events during the process. You can listen for these events, such as [`response.output_text.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_text/delta), to provide realtime feedback to users as the response is generated. A full listing of the events emitted by there server are found below under **related server events**. They are provided in the rough order of when they are emitted, along with relevant client-side events for text generation.

<table>
  <tr>
    <th>Related client events</th>
    <th>Related server events</th>
  </tr>
  <tr>
    <td>
      [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create)
      <div />
      [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create)
    </td>
    <td>
      [`conversation.item.added`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/conversation/item/added)
      <div />
      [`conversation.item.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/conversation/item/done)
      <div />
      [`response.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/created)
      <div />
      [`response.output_item.added`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_item/added)
      <div />
      [`response.content_part.added`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/content_part/added)
      <div />
      [`response.output_text.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_text/delta)
      <div />
      [`response.output_text.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_text/done)
      <div />
      [`response.content_part.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/content_part/done)
      <div />
      [`response.output_item.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_item/done)
      <div />
      [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done)
      <div />
      [`rate_limits.updated`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/rate_limits/updated)
    </td>
  </tr>
</table>

## Audio inputs and outputs

One of the most powerful features of the Realtime API is voice-to-voice interaction with the model, without an intermediate text-to-speech or speech-to-text step. This enables lower latency for voice interfaces, and gives the model more data to work with around the tone and inflection of voice input.

### Voice options

Realtime sessions can be configured to use one of several built‑in voices when producing audio output. You can set the `voice` on session creation (or on a `response.create`) to control how the model sounds. Current voice options are `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`. Once the model has emitted audio in a session, the `voice` cannot be modified for that session. For best quality, we recommend using `marin` or `cedar`.

### Handling audio with WebRTC

If you are connecting to the Realtime API using WebRTC, the Realtime API is acting as a [peer connection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection) to your client. Audio output from the model is delivered to your client as a [remote media stream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream). Audio input to the model is collected using audio devices ([`getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)), and media streams are added as tracks to to the peer connection.

The example code from the [WebRTC connection guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) shows a basic example of configuring both local and remote audio using browser APIs:

```javascript
// Create a peer connection
const pc = new RTCPeerConnection();

// Set up to play remote audio from the model
const audioEl = document.createElement("audio");
audioEl.autoplay = true;
pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

// Add local audio track for microphone input in the browser
const ms = await navigator.mediaDevices.getUserMedia({
  audio: true,
});
pc.addTrack(ms.getTracks()[0]);
```

The snippet above enables simple interaction with the Realtime API, but there's much more that can be done. For more examples of different kinds of user interfaces, check out the [WebRTC samples](https://github.com/webrtc/samples) repository. Live demos of these samples can also be [found here](https://webrtc.github.io/samples/).

Using [media captures and streams](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API) in the browser enables you to do things like mute and unmute microphones, select which device to collect input from, and more.

### Client and server events for audio in WebRTC

By default, WebRTC clients don't need to send any client events to the Realtime API before sending audio inputs. Once a local audio track is added to the peer connection, your users can just start talking!

However, WebRTC clients still receive a number of server-sent lifecycle events as audio is moving back and forth between client and server over the peer connection. Examples include:

- When input is sent over the local media track, you will receive [`input_audio_buffer.speech_started`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/input_audio_buffer/speech_started) events from the server.
- When local audio input stops, you'll receive the [`input_audio_buffer.speech_stopped`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/input_audio_buffer/speech_started) event.
- You'll receive [delta events for the in-progress audio transcript](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio_transcript/delta).
- You'll receive a [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done) event when the model has transcribed and completed sending a response.

Manipulating WebRTC APIs for media streams may give you all the control you need. However, it may occasionally be necessary to use lower-level interfaces for audio input and output. Refer to the WebSockets section below for more information and a listing of events required for granular audio input handling.

### Handling audio with WebSockets

When sending and receiving audio over a WebSocket, you will have a bit more work to do in order to send media from the client, and receive media from the server. Below, you'll find a table describing the flow of events during a WebSocket session that are necessary to send and receive audio over the WebSocket.

The events below are given in lifecycle order, though some events (like the `delta` events) may happen concurrently.

<table>
  <tr>
    <th>Lifecycle stage</th>
    <th>Client events</th>
    <th>Server events</th>
  </tr>
  <tr>
    <td>Session initialization</td>
    <td>
      [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)
    </td>
    <td>
      [`session.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/created)
      <div />
      [`session.updated`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/session/updated)
    </td>
  </tr>
  <tr>
    <td>User audio input</td>
    <td>
      [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create)
      <br />
      &nbsp;&nbsp;(send whole audio message)
      <div />
      [`input_audio_buffer.append`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/append)
      <br />
      &nbsp;&nbsp;(stream audio in chunks)
      <div />
      [`input_audio_buffer.commit`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/commit)
      <br />
      &nbsp;&nbsp;(used when VAD is disabled)
      <div />
      [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create)
      <br />
      &nbsp;&nbsp;(used when VAD is disabled)
    </td>
    <td>
      [`input_audio_buffer.speech_started`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/input_audio_buffer/speech_started)
      <div />
      [`input_audio_buffer.speech_stopped`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/input_audio_buffer/speech_stopped)
      <div />
      [`input_audio_buffer.committed`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/input_audio_buffer/committed)
    </td>
  </tr>
  <tr>
    <td>Server audio output</td>
    <td>
      [`input_audio_buffer.clear`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/clear)
      <br />
      &nbsp;&nbsp;(used when VAD is disabled)
    </td>
    <td>
      [`conversation.item.added`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/conversation/item/added)
      <div />
      [`conversation.item.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/conversation/item/done)
      <div />
      [`response.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/created)
      <div />
      [`response.output_item.created`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_item/created)
      <div />
      [`response.content_part.added`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/content_part/added)
      <div />
      [`response.output_audio.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio/delta)
      <div />
      [`response.output_audio.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio/done)
      <div />
      [`response.output_audio_transcript.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio_transcript/delta)
      <div />
      [`response.output_audio_transcript.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio_transcript/done)
      <div />
      [`response.output_text.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_text/delta)
      <div />
      [`response.output_text.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_text/done)
      <div />
      [`response.content_part.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/content_part/done)
      <div />
      [`response.output_item.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_item/done)
      <div />
      [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done)
      <div />
      [`rate_limits.updated`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/rate_limits/updated)
    </td>
  </tr>
</table>

### Streaming audio input to the server

To stream audio input to the server, you can use the [`input_audio_buffer.append`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/append) client event. This event requires you to send chunks of **Base64-encoded audio bytes** to the Realtime API over the socket. Each chunk cannot exceed 15 MB in size.

The format of the input chunks can be configured either for the entire session, or per response.

- Session: `session.input_audio_format` in [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)
- Response: `response.input_audio_format` in [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create)

Append audio input bytes to the conversation

```javascript
import fs from 'fs';
import decodeAudio from 'audio-decode';

// Converts Float32Array of audio data to PCM16 ArrayBuffer
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// Converts a Float32Array to base64-encoded PCM16 data
base64EncodeAudio(float32Array) {
  const arrayBuffer = floatTo16BitPCM(float32Array);
  let binary = '';
  let bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000; // 32KB chunk size
  for (let i = 0; i < bytes.length; i += chunkSize) {
    let chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// Fills the audio buffer with the contents of three files,
// then asks the model to generate a response.
const files = [
  './path/to/sample1.wav',
  './path/to/sample2.wav',
  './path/to/sample3.wav'
];

for (const filename of files) {
  const audioFile = fs.readFileSync(filename);
  const audioBuffer = await decodeAudio(audioFile);
  const channelData = audioBuffer.getChannelData(0);
  const base64Chunk = base64EncodeAudio(channelData);
  ws.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: base64Chunk
  }));
});

ws.send(JSON.stringify({type: 'input_audio_buffer.commit'}));
ws.send(JSON.stringify({type: 'response.create'}));
```

```python
import base64
import json
import struct
import soundfile as sf
from websocket import create_connection

# ... create websocket-client named ws ...

def float_to_16bit_pcm(float32_array):
    clipped = [max(-1.0, min(1.0, x)) for x in float32_array]
    pcm16 = b''.join(struct.pack('<h', int(x * 32767)) for x in clipped)
    return pcm16

def base64_encode_audio(float32_array):
    pcm_bytes = float_to_16bit_pcm(float32_array)
    encoded = base64.b64encode(pcm_bytes).decode('ascii')
    return encoded

files = [
    './path/to/sample1.wav',
    './path/to/sample2.wav',
    './path/to/sample3.wav'
]

for filename in files:
    data, samplerate = sf.read(filename, dtype='float32')
    channel_data = data[:, 0] if data.ndim > 1 else data
    base64_chunk = base64_encode_audio(channel_data)

    # Send the client event
    event = {
        "type": "input_audio_buffer.append",
        "audio": base64_chunk
    }
    ws.send(json.dumps(event))
```


### Send full audio messages

It is also possible to create conversation messages that are full audio recordings. Use the [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create) client event to create messages with `input_audio` content.

Create full audio input conversation items

```javascript
const fullAudio = "<a base64-encoded string of audio bytes>";

const event = {
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_audio",
        audio: fullAudio,
      },
    ],
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
fullAudio = "<a base64-encoded string of audio bytes>"

event = {
    "type": "conversation.item.create",
    "item": {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_audio",
                "audio": fullAudio,
            }
        ],
    },
}

ws.send(json.dumps(event))
```


### Working with audio output from a WebSocket

**To play output audio back on a client device like a web browser, we recommend using WebRTC rather than WebSockets**. WebRTC will be more robust sending media to client devices over uncertain network conditions.

But to work with audio output in server-to-server applications using a WebSocket, you will need to listen for [`response.output_audio.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio/delta) events containing the Base64-encoded chunks of audio data from the model. You will either need to buffer these chunks and write them out to a file, or maybe immediately stream them to another source like [a phone call with Twilio](https://www.twilio.com/en-us/blog/twilio-openai-realtime-api-launch-integration).

Note that the [`response.output_audio.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio/done) and [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done) events won't actually contain audio data in them - just audio content transcriptions. To get the actual bytes, you'll need to listen for the [`response.output_audio.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/output_audio/delta) events.

The format of the output chunks can be configured either for the entire session, or per response.

- Session: `session.audio.output.format` in [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)
- Response: `response.audio.output.format` in [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create)

Listen for response.output_audio.delta events

```javascript
function handleEvent(e) {
  const serverEvent = JSON.parse(e.data);
  if (serverEvent.type === "response.audio.delta") {
    // Access Base64-encoded audio chunks
    // console.log(serverEvent.delta);
  }
}

// Listen for server messages (WebSocket)
ws.on("message", handleEvent);
```

```python
def on_message(ws, message):
    server_event = json.loads(message)
    if server_event.type == "response.audio.delta":
        # Access Base64-encoded audio chunks:
        # print(server_event.delta)
```


## Image inputs

`gpt-realtime` and `gpt-realtime-mini` also support image input. You can attach an image as a content part in a user message, and the model can incorporate what’s in the image when it responds.

Add an image to the conversation

```javascript
const base64Image = "<a base64-encoded string of image bytes>";

const event = {
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_image",
        image_url: \`data:image/{format};base64,\${base64Image}\`,
      },
    ],
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```


## Voice activity detection

By default, Realtime sessions have **voice activity detection (VAD)** enabled, which means the API will determine when the user has started or stopped speaking and respond automatically.

Read more about how to configure VAD in our [voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad) guide.

### Disable VAD

VAD can be disabled by setting `turn_detection` to `null` with the [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) client event. This can be useful for interfaces where you would like to take granular control over audio input, like [push to talk](https://en.wikipedia.org/wiki/Push-to-talk) interfaces.

When VAD is disabled, the client will have to manually emit some additional client events to trigger audio responses:

- Manually send [`input_audio_buffer.commit`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/commit), which will create a new user input item for the conversation.
- Manually send [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) to trigger an audio response from the model.
- Send [`input_audio_buffer.clear`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/clear) before beginning a new user input.

### Keep VAD, but disable automatic responses

If you would like to keep VAD mode enabled, but would just like to retain the ability to manually decide when a response is generated, you can set `turn_detection.interrupt_response` and `turn_detection.create_response` to `false` with the [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) client event. This will retain all the behavior of VAD but not automatically create new Responses. Clients can trigger these manually with a [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) event.

This can be useful for moderation or input validation or RAG patterns, where you're comfortable trading a bit more latency in the interaction for control over inputs.

## Create responses outside the default conversation

By default, all responses generated during a session are added to the session's conversation state (the "default conversation"). However, you may want to generate model responses outside the context of the session's default conversation, or have multiple responses generated concurrently. You might also want to have more granular control over which conversation items are considered while the model generates a response (e.g. only the last N number of turns).

Generating "out-of-band" responses which are not added to the default conversation state is possible by setting the `response.conversation` field to the string `none` when creating a response with the [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) client event.

When creating an out-of-band response, you will probably also want some way to identify which server-sent events pertain to this response. You can provide `metadata` for your model response that will help you identify which response is being generated for this client-sent event.

Create an out-of-band model response

```javascript
const prompt = \`
Analyze the conversation so far. If it is related to support, output
"support". If it is related to sales, output "sales".
\`;

const event = {
  type: "response.create",
  response: {
    // Setting to "none" indicates the response is out of band
    // and will not be added to the default conversation
    conversation: "none",

    // Set metadata to help identify responses sent back from the model
    metadata: { topic: "classification" },

    // Set any other available response fields
    output_modalities: [ "text" ],
    instructions: prompt,
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
prompt = """
Analyze the conversation so far. If it is related to support, output
"support". If it is related to sales, output "sales".
"""

event = {
    "type": "response.create",
    "response": {
        # Setting to "none" indicates the response is out of band,
        # and will not be added to the default conversation
        "conversation": "none",

        # Set metadata to help identify responses sent back from the model
        "metadata": { "topic": "classification" },

        # Set any other available response fields
        "output_modalities": [ "text" ],
        "instructions": prompt,
    },
}

ws.send(json.dumps(event))
```


Now, when you listen for the [`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done) server event, you can identify the result of your out-of-band response.

Create an out-of-band model response

```javascript
function handleEvent(e) {
  const serverEvent = JSON.parse(e.data);
  if (
    serverEvent.type === "response.done" &&
    serverEvent.response.metadata?.topic === "classification"
  ) {
    // this server event pertained to our OOB model response
    console.log(serverEvent.response.output[0]);
  }
}

// Listen for server messages (WebRTC)
dataChannel.addEventListener("message", handleEvent);

// Listen for server messages (WebSocket)
// ws.on("message", handleEvent);
```

```python
def on_message(ws, message):
    server_event = json.loads(message)
    topic = ""

    # See if metadata is present
    try:
        topic = server_event.response.metadata.topic
    except AttributeError:
        print("topic not set")

    if server_event.type == "response.done" and topic == "classification":
        # this server event pertained to our OOB model response
        print(server_event.response.output[0])
```


### Create a custom context for responses

You can also construct a custom context that the model will use to generate a response, outside the default/current conversation. This can be done using the `input` array on a [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) client event. You can use new inputs, or reference existing input items in the conversation by ID.

Listen for out-of-band model response with custom context

```javascript
const event = {
  type: "response.create",
  response: {
    conversation: "none",
    metadata: { topic: "pizza" },
    output_modalities: [ "text" ],

    // Create a custom input array for this request with whatever context
    // is appropriate
    input: [
      // potentially include existing conversation items:
      {
        type: "item_reference",
        id: "some_conversation_item_id"
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Is it okay to put pineapple on pizza?",
          },
        ],
      },
    ],
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
event = {
    "type": "response.create",
    "response": {
        "conversation": "none",
        "metadata": { "topic": "pizza" },
        "output_modalities": [ "text" ],

        # Create a custom input array for this request with whatever
        # context is appropriate
        "input": [
            # potentially include existing conversation items:
            {
                "type": "item_reference",
                "id": "some_conversation_item_id"
            },

            # include new content as well
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "Is it okay to put pineapple on pizza?",
                    }
                ],
            }
        ],
    },
}

ws.send(json.dumps(event))
```


### Create responses with no context

You can also insert responses into the default conversation, ignoring all other instructions and context. Do this by setting `input` to an empty array.

Insert no-context model responses into the default conversation

```javascript
const prompt = \`
Say exactly the following:
I'm a little teapot, short and stout!
This is my handle, this is my spout!
\`;

const event = {
  type: "response.create",
  response: {
    // An empty input array removes existing context
    input: [],
    instructions: prompt,
  },
};

// WebRTC data channel and WebSocket both have .send()
dataChannel.send(JSON.stringify(event));
```

```python
prompt = """
Say exactly the following:
I'm a little teapot, short and stout!
This is my handle, this is my spout!
"""

event = {
    "type": "response.create",
    "response": {
        # An empty input array removes all prior context
        "input": [],
        "instructions": prompt,
    },
}

ws.send(json.dumps(event))
```


## Function calling

The Realtime models also support **function calling**, which enables you to execute custom code to extend the capabilities of the model. Here's how it works at a high level:

1. When [updating the session](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) or [creating a response](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create), you can specify a list of available functions for the model to call.
1. If when processing input, the model determines it should make a function call, it will add items to the conversation representing arguments to a function call.
1. When the client detects conversation items that contain function call arguments, it will execute custom code using those arguments
1. When the custom code has been executed, the client will create new conversation items that contain the output of the function call, and ask the model to respond.

Let's see how this would work in practice by adding a callable function that will provide today's horoscope to users of the model. We'll show the shape of the client event objects that need to be sent, and what the server will emit in turn.

### Configure callable functions

First, we must give the model a selection of functions it can call based on user input. Available functions can be configured either at the session level, or the individual response level.

- Session: `session.tools` property in [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)
- Response: `response.tools` property in [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create)

Here's an example client event payload for a `session.update` that configures a horoscope generation function, that takes a single argument (the astrological sign for which the horoscope should be generated):

[`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update)

```json
{
  "type": "session.update",
  "session": {
    "tools": [
      {
        "type": "function",
        "name": "generate_horoscope",
        "description": "Give today's horoscope for an astrological sign.",
        "parameters": {
          "type": "object",
          "properties": {
            "sign": {
              "type": "string",
              "description": "The sign for the horoscope.",
              "enum": [
                "Aries",
                "Taurus",
                "Gemini",
                "Cancer",
                "Leo",
                "Virgo",
                "Libra",
                "Scorpio",
                "Sagittarius",
                "Capricorn",
                "Aquarius",
                "Pisces"
              ]
            }
          },
          "required": ["sign"]
        }
      }
    ],
    "tool_choice": "auto"
  }
}
```

The `description` fields for the function and the parameters help the model choose whether or not to call the function, and what data to include in each parameter. If the model receives input that indicates the user wants their horoscope, it will call this function with a `sign` parameter.

### Detect when the model wants to call a function

Based on inputs to the model, the model may decide to call a function in order to generate the best response. Let's say our application adds the following conversation item with a [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create) event and then creates a response:

```json
{
  "type": "conversation.item.create",
  "item": {
    "type": "message",
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "What is my horoscope? I am an aquarius."
      }
    ]
  }
}
```

Followed by a [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) client event to generate a response:

```json
{
  "type": "response.create"
}
```

Instead of immediately returning a text or audio response, the model will instead generate a response that contains the arguments that should be passed to a function in the developer's application. You can listen for realtime updates to function call arguments using the [`response.function_call_arguments.delta`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/function_call_arguments/delta) server event, but `response.done` will also have the complete data we need to call our function.

[`response.done`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/response/done)

```json
{
    "type": "response.done",
    "event_id": "event_AeqLA8iR6FK20L4XZs2P6",
    "response": {
        "object": "realtime.response",
        "id": "resp_AeqL8XwMUOri9OhcQJIu9",
        "status": "completed",
        "status_details": null,
        "output": [
            {
                "object": "realtime.item",
                "id": "item_AeqL8gmRWDn9bIsUM2T35",
                "type": "function_call",
                "status": "completed",
                "name": "generate_horoscope",
                "call_id": "call_sHlR7iaFwQ2YQOqm",
                "arguments": "{\"sign\":\"Aquarius\"}"
            }
        ],
        ...
    }
}
```

In the JSON emitted by the server, we can detect that the model wants to call a custom function:

| Property                       | Function calling purpose                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `response.output[0].type`      | When set to `function_call`, indicates this response contains arguments for a named function call.                         |
| `response.output[0].name`      | The name of the configured function to call, in this case `generate_horoscope`                                             |
| `response.output[0].arguments` | A JSON string containing arguments to the function. In our case, `"{\"sign\":\"Aquarius\"}"`.                              |
| `response.output[0].call_id`   | A system-generated ID for this function call - **you will need this ID to pass a function call result back to the model**. |

Given this information, we can execute code in our application to generate the horoscope, and then provide that information back to the model so it can generate a response.

### Provide the results of a function call to the model

Upon receiving a response from the model with arguments to a function call, your application can execute code that satisfies the function call. This could be anything you want, like talking to external APIs or accessing databases.

Once you are ready to give the model the results of your custom code, you can create a new conversation item containing the result via the [`conversation.item.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/create) client event.

```json
{
  "type": "conversation.item.create",
  "item": {
    "type": "function_call_output",
    "call_id": "call_sHlR7iaFwQ2YQOqm",
    "output": "{\"horoscope\": \"You will soon meet a new friend.\"}"
  }
}
```

- The conversation item type is `function_call_output`
- `item.call_id` is the same ID we got back in the `response.done` event above
- `item.output` is a JSON string containing the results of our function call

Once we have added the conversation item containing our function call results, we again emit the [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) event from the client. This will trigger a model response using the data from the function call.

```json
{
  "type": "response.create"
}
```

## Error handling

The [`error`](https://developers.openai.com/api/docs/api-reference/realtime-server-events/error) event is emitted by the server whenever an error condition is encountered on the server during the session. Occasionally, these errors can be traced to a client event that was emitted by your application.

Unlike HTTP requests and responses, where a response is implicitly tied to a request from the client, we need to use an `event_id` property on client events to know when one of them has triggered an error condition on the server. This technique is shown in the code below, where the client attempts to emit an unsupported event type.

```javascript
const event = {
  event_id: "my_awesome_event",
  type: "scooby.dooby.doo",
};

dataChannel.send(JSON.stringify(event));
```

This unsuccessful event sent from the client will emit an error event like the following:

```json
{
  "type": "invalid_request_error",
  "code": "invalid_value",
  "message": "Invalid value: 'scooby.dooby.doo' ...",
  "param": "type",
  "event_id": "my_awesome_event"
}
```

## Interruption and Truncation

In many voice applications the user can interrupt the model while it's speaking. Realtime API handles interruptions when VAD is enabled, in that it detects user speech, cancels the ongoing response, and starts a new one. However in this scenario you will want the model to know where it was interrupted, so it can continue the conversation naturally (for example if the user says "what was that last thing?"). We call this **truncating** the model's last response, i.e. removing the unplayed portion of the model's last response from the conversation.

In WebRTC and SIP connections the server manages a buffer of output audio, and thus knows how much audio has been played at a given moment. The server will automatically truncate unplayed audio when there's a user interruption.

With a WebSocket connection the client manages audio playback, and thus must stop playback and handle truncation. Here's how this procedure works:

1. The client monitors for new `input_audio_buffer.speech_started` events from the server, which indicate the user has started speaking. The server will automatically cancel any in-progress model response and a `response.cancelled` event will be emitted.
1. When the client detects this event, it should immediately stop playback of any audio currently being played from the model. It should note how much of the last audio response was played before the interruption.
1. The client should send a [`conversation.item.truncate`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/truncate) event to remove the unplayed portion of the model's last response from the conversation.

Here's an example:

```json
{
    "type": "conversation.item.truncate",
    "item_id": "item_1234", # this is the item ID of the model's last response
    "content_index": 0,
    "audio_end_ms": 1500 # truncate audio after 1.5 seconds
}
```

What about truncating the transcript as well? The realtime model doesn't have enough information to precisely align transcript and audio, and thus `conversation.item.truncate` will cut the audio at a given place and remove the text transcript for the unplayed portion. This solves the problem of removing unplayed audio but doesn't provide a truncated transcript.

## Push-to-talk

Realtime API defaults to using voice activity detection (VAD), which means model responses will be triggered with audio input. You can also do a push-to-talk interaction by disabling VAD and using an application-level gate to control when audio input is sent to the model, for example holding the space-bar down to capture audio, then triggering a response when it's released. For some apps this works surprisingly well -- it gives the users control over interactions, avoids VAD failures, and it feels snappy because we're not waiting for a VAD timeout.

Implementing push-to-talk looks a bit different on WebSockets and WebRTC. In a Realtime API WebSocket connection all events are sent in the same channel and with the same ordering, while a WebRTC connection has separate channels for audio and control events.

### WebSockets

To implement push-to-talk with a WebSocket connection, you'll want the client to stop audio playback, handle interruptions, and kick off a new response. Here's a more detailed procedure:

1. Turn VAD off by setting `"turn_detection": null` in a [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) event.
1. On push down, start recording audio on the client.
   1. If there is an in-progress response from the model, cancel it by sending a [`response.cancel`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/cancel) event.
   1. If there is is ongoing output playback from the model, stop playback immediately and send an `conversation.item.truncate` event to remove any unplayed audio from the conversation.
1. On up, send an [`input_audio_buffer.append`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/append) message with the audio to place new audio into the input buffer.
1. Send an [`input_audio_buffer.commit`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/commit) event, this will commit the audio written to the input buffer and kick off input transcription (if enabled).
1. Then trigger a response with a [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) event.

### WebRTC and SIP

Implementing push-to-talk with WebRTC is similar but the input audio buffer must be explicitly cleared. Here's a procedure:

1. Turn VAD off by setting `"turn_detection": null` in a [`session.update`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update) event.
1. On push down, send an [`input_audio_buffer.clear`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/clear) event to clear any previous audio input.
   1. If there is an in-progress response from the model, cancel it by sending a [`response.cancel`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/cancel) event.
   1. If there is is ongoing output playback from the model, send an [`output_audio_buffer.clear`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/output_audio_buffer/clear) event to clear out the unplayed audio, this truncates the conversation as well.
1. On up, send an [`input_audio_buffer.commit`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/input_audio_buffer/commit) event, this will commit the audio written to the input buffer and kick off input transcription (if enabled).
1. Then trigger a response with a [`response.create`](https://developers.openai.com/api/docs/api-reference/realtime-client-events/response/create) event.

# Text to speech

The Audio API provides a [`speech`](https://developers.openai.com/api/docs/api-reference/audio/createSpeech) endpoint based on our [GPT-4o mini TTS (text-to-speech) model](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts). It comes with 11 built-in voices and can be used to:

- Narrate a written blog post
- Produce spoken audio in multiple languages
- Give realtime audio output using streaming

Here's an example of the `alloy` voice:

Our [usage policies](https://openai.com/policies/usage-policies) require you
  to provide a clear disclosure to end users that the TTS voice they are hearing
  is AI-generated and not a human voice.

## Quickstart

The `speech` endpoint takes three key inputs:

1. The [model](https://developers.openai.com/api/docs/api-reference/audio/createSpeech#audio-createspeech-model) you're using
1. The [text](https://developers.openai.com/api/docs/api-reference/audio/createSpeech#audio-createspeech-input) to be turned into audio
1. The [voice](https://developers.openai.com/api/docs/api-reference/audio/createSpeech#audio-createspeech-voice) that will speak the output

Here's a simple request example:

Generate spoken audio from input text

```javascript
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI();
const speechFile = path.resolve("./speech.mp3");

const mp3 = await openai.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "coral",
  input: "Today is a wonderful day to build something people love!",
  instructions: "Speak in a cheerful and positive tone.",
});

const buffer = Buffer.from(await mp3.arrayBuffer());
await fs.promises.writeFile(speechFile, buffer);
```

```python
from pathlib import Path
from openai import OpenAI

client = OpenAI()
speech_file_path = Path(__file__).parent / "speech.mp3"

with client.audio.speech.with_streaming_response.create(
    model="gpt-4o-mini-tts",
    voice="coral",
    input="Today is a wonderful day to build something people love!",
    instructions="Speak in a cheerful and positive tone.",
) as response:
    response.stream_to_file(speech_file_path)
```

```bash
curl https://api.openai.com/v1/audio/speech \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini-tts",
    "input": "Today is a wonderful day to build something people love!",
    "voice": "coral",
    "instructions": "Speak in a cheerful and positive tone."
  }' \\
  --output speech.mp3
```


By default, the endpoint outputs an MP3 of the spoken audio, but you can configure it to output any [supported format](#supported-output-formats).

### Text-to-speech models

For intelligent realtime applications, use the `gpt-4o-mini-tts` model, our newest and most reliable text-to-speech model. You can prompt the model to control aspects of speech, including:

- Accent
- Emotional range
- Intonation
- Impressions
- Speed of speech
- Tone
- Whispering

Our other text-to-speech models are `tts-1` and `tts-1-hd`. The `tts-1` model provides lower latency, but at a lower quality than the `tts-1-hd` model.

### Voice options

The TTS endpoint provides 13 built‑in voices to control how speech is rendered from text. **Hear and play with these voices in [OpenAI.fm](https://openai.fm), our interactive demo for trying the latest text-to-speech model in the OpenAI API**. Voices are currently optimized for English.

- `alloy`
- `ash`
- `ballad`
- `coral`
- `echo`
- `fable`
- `nova`
- `onyx`
- `sage`
- `shimmer`
- `verse`
- `marin`
- `cedar`

For best quality, we recommend using `marin` or `cedar`.

Voice availability depends on the model. The `tts-1` and `tts-1-hd` models support a smaller set: `alloy`, `ash`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, and `shimmer`.

If you're using the [Realtime API](https://developers.openai.com/api/docs/guides/realtime), note that the set of available voices is slightly different—see the [realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options) for current realtime voices.

### Streaming realtime audio

The Speech API provides support for realtime audio streaming using [chunk transfer encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Transfer-Encoding). This means the audio can be played before the full file is generated and made accessible.

Stream spoken audio from input text directly to your speakers

```javascript
import OpenAI from "openai";
import { playAudio } from "openai/helpers/audio";

const openai = new OpenAI();

const response = await openai.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "coral",
  input: "Today is a wonderful day to build something people love!",
  instructions: "Speak in a cheerful and positive tone.",
  response_format: "wav",
});

await playAudio(response);
```

```python
import asyncio

from openai import AsyncOpenAI
from openai.helpers import LocalAudioPlayer

openai = AsyncOpenAI()

async def main() -> None:
    async with openai.audio.speech.with_streaming_response.create(
        model="gpt-4o-mini-tts",
        voice="coral",
        input="Today is a wonderful day to build something people love!",
        instructions="Speak in a cheerful and positive tone.",
        response_format="pcm",
    ) as response:
        await LocalAudioPlayer().play(response)

if __name__ == "__main__":
    asyncio.run(main())
```

```bash
curl https://api.openai.com/v1/audio/speech \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini-tts",
    "input": "Today is a wonderful day to build something people love!",
    "voice": "coral",
    "instructions": "Speak in a cheerful and positive tone.",
    "response_format": "wav"
  }' | ffplay -i -
```


For the fastest response times, we recommend using `wav` or `pcm` as the response format.

## Supported output formats

The default response format is `mp3`, but other formats like `opus` and `wav` are available.

- **MP3**: The default response format for general use cases.
- **Opus**: For internet streaming and communication, low latency.
- **AAC**: For digital audio compression, preferred by YouTube, Android, iOS.
- **FLAC**: For lossless audio compression, favored by audio enthusiasts for archiving.
- **WAV**: Uncompressed WAV audio, suitable for low-latency applications to avoid decoding overhead.
- **PCM**: Similar to WAV but contains the raw samples in 24kHz (16-bit signed, low-endian), without the header.

## Supported languages

The TTS model generally follows the Whisper model in terms of language support. Whisper [supports the following languages](https://github.com/openai/whisper#available-models-and-languages) and performs well, despite voices being optimized for English:

Afrikaans, Arabic, Armenian, Azerbaijani, Belarusian, Bosnian, Bulgarian, Catalan, Chinese, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, Galician, German, Greek, Hebrew, Hindi, Hungarian, Icelandic, Indonesian, Italian, Japanese, Kannada, Kazakh, Korean, Latvian, Lithuanian, Macedonian, Malay, Marathi, Maori, Nepali, Norwegian, Persian, Polish, Portuguese, Romanian, Russian, Serbian, Slovak, Slovenian, Spanish, Swahili, Swedish, Tagalog, Tamil, Thai, Turkish, Ukrainian, Urdu, Vietnamese, and Welsh.

You can generate spoken audio in these languages by providing input text in the language of your choice.

## Custom voices

Custom voices enable you to create a unique voice for your agent or application. These voices can be used for audio output with the [Text to Speech API](https://developers.openai.com/api/docs/api-reference/audio/createSpeech), the [Realtime API](https://developers.openai.com/api/docs/api-reference/realtime), or the [Chat Completions API with audio output](https://developers.openai.com/api/docs/guides/audio).

To create a custom voice, you’ll provide a short sample audio reference that the model will seek to replicate.

Custom voices are limited to eligible customers. Contact sales at
  [sales@openai.com](mailto:sales@openai.com) to learn more. Once enabled for
  your organization, you’ll have access to the
  [Voices](https://platform.openai.com/audio/voices) tab under Audio.

#### Creating a voice

Currently, voices must be created through an API request. See the API reference for the full set of API operations.

Creating a voice requires two separate audio recordings:

1. **Consent recording** — this recording captures the voice actor providing consent to create a likeness of their voice. The actor must read one of the consent phrases provided below.
2. **Sample recording** — the actual audio sample that the model will try to adhere to. The voice must match the consent recording.

**Tips for creating a high-quality voice**

The quality of your custom voice is highly dependent on the quality of the sample you provide. Optimizing the recording quality can make a big difference.

- Record in a quiet space with minimal echo.
- Use a professional XLR microphone.
- Stay about 7–8 inches from the mic with a pop filter in between, and keep that distance consistent.
- The model copies exactly what you give it—tone, cadence, energy, pauses, habits—so record the exact voice you want. Be consistent in energy, style, and accent throughout.
- Small variations in the audio sample can result in quality differences with the generated voice, it's worth trying multiple examples to find the best fit.

**Requirements and limitations**

- At most 20 voices can be created per organization.
- The audio samples must be 30 seconds or less.
- The audio samples must be one of the following types: `mpeg`, `wav`, `ogg`, `aac`, `flac`, `webm`, or `mp4`.

Refer to the Text-to-Speech Supplemental Agreement for additional terms of use.

**Creating a voice consent**

The consent audio recording must only include one of the following phrases. Any divergence from the script will lead to a failure.

| Language | Phrase                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `de`     | Ich bin der Eigentümer dieser Stimme und bin damit einverstanden, dass OpenAI diese Stimme zur Erstellung eines synthetischen Stimmmodells verwendet. |
| `en`     | I am the owner of this voice and I consent to OpenAI using this voice to create a synthetic voice model.                                              |
| `es`     | Soy el propietario de esta voz y doy mi consentimiento para que OpenAI la utilice para crear un modelo de voz sintética.                              |
| `fr`     | Je suis le propriétaire de cette voix et j'autorise OpenAI à utiliser cette voix pour créer un modèle de voix synthétique.                            |
| `hi`     | मैं इस आवाज का मालिक हूं और मैं सिंथेटिक आवाज मॉडल बनाने के लिए OpenAI को इस आवाज का उपयोग करने की सहमति देता हूं                                     |
| `id`     | Saya adalah pemilik suara ini dan saya memberikan persetujuan kepada OpenAI untuk menggunakan suara ini guna membuat model suara sintetis.            |
| `it`     | Sono il proprietario di questa voce e acconsento che OpenAI la utilizzi per creare un modello di voce sintetica.                                      |
| `ja`     | 私はこの音声の所有者であり、OpenAIがこの音声を使用して音声合成 モデルを作成することを承認します。                                                     |
| `ko`     | 나는 이 음성의 소유자이며 OpenAI가 이 음성을 사용하여 음성 합성 모델을 생성할 것을 허용합니다.                                                        |
| `nl`     | Ik ben de eigenaar van deze stem en ik geef OpenAI toestemming om deze stem te gebruiken om een synthetisch stemmodel te maken.                       |
| `pl`     | Jestem właścicielem tego głosu i wyrażam zgodę na wykorzystanie go przez OpenAI w celu utworzenia syntetycznego modelu głosu.                         |
| `pt`     | Eu sou o proprietário desta voz e autorizo o OpenAI a usá-la para criar um modelo de voz sintética.                                                   |
| `ru`     | Я являюсь владельцем этого голоса и даю согласие OpenAI на использование этого голоса для создания модели синтетического голоса.                      |
| `uk`     | Я є власником цього голосу і даю згоду OpenAI використовувати цей голос для створення синтетичної голосової моделі.                                   |
| `vi`     | Tôi là chủ sở hữu giọng nói này và tôi đồng ý cho OpenAI sử dụng giọng nói này để tạo mô hình giọng nói tổng hợp.                                     |
| `zh`     | 我是此声音的拥有者并授权OpenAI使用此声音创建语音合成模型                                                                                              |

Then upload the recording via the API. A successful upload will return the consent recording ID that you’ll reference later. Note the consent can be used for multiple different voice creations if the same voice actor is making multiple attempts.

```bash
curl https://api.openai.com/v1/audio/voice_consents \
  -X POST \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "name=test_consent" \
  -F "language=en" \
  -F "recording=@$HOME/tmp/voice_consent/consent_recording.wav;type=audio/x-wav"
```

**Creating a voice**

Next, you’ll create the actual voice by referencing the consent recording ID, and providing the voice sample.

```bash
curl https://api.openai.com/v1/audio/voices \
  -X POST \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "name=test_voice" \
  -F "audio_sample=@$HOME/tmp/voice_consent/audio_sample_recording.wav;type=audio/x-wav" \
  -F "consent=cons_123abc"
```

If successful, the created voice will be listed under the [Audio tab](https://platform.openai.com/audio/voices).

#### Using a voice during speech generation

Speech generation will work as usual. Simply specify the ID of the voice in the `voice` parameter when [creating speech](https://developers.openai.com/api/docs/api-reference/audio/createSpeech), or when initiating a [realtime session](https://developers.openai.com/api/docs/api-reference/realtime/create-call#realtime_create_call-session-audio-output-voice).

**Text to speech example**

```bash
curl https://api.openai.com/v1/audio/speech \
  -X POST \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini-tts",
    "voice": {
      "id": "voice_123abc"
    },
    "input": "Maple est le meilleur golden retriever du monde entier.",
    "language": "fr",
    "format": "wav"
  }' \
  --output sample.wav
```

**Realtime API example**

```javascript
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime",
    audio: {
      output: {
        voice: { id: "voice_123abc" },
      },
    },
  },
});
```
