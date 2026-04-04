import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAbortError } from "../tools/abortError.ts";
import { buildRealtimeFunctionTools } from "./voiceToolCallToolRegistry.ts";
import { refreshRealtimeTools } from "./voiceToolCallInfra.ts";
import { createVoiceTestManager, createVoiceTestSettings } from "./voiceTestHarness.ts";

test("refreshRealtimeTools registers local and MCP tool definitions", async () => {
  const manager = createVoiceTestManager();
  manager.getVoiceScreenWatchCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    publicUrl: "https://screen.example",
    reason: null
  });
  manager.startVoiceScreenWatch = async () => ({
    started: true,
    reason: "watching_started",
    transport: "native"
  });
  manager.appConfig.voiceMcpServers = [
    {
      serverName: "ops_tools",
      baseUrl: "https://mcp.local",
      toolPath: "/tools/call",
      timeoutMs: 5000,
      headers: {},
      tools: [
        {
          name: "server_status",
          description: "Fetch service health.",
          inputSchema: {
            type: "object",
            properties: {
              service: {
                type: "string"
              }
            },
            required: ["service"]
          }
        }
      ]
    }
  ];

  let updatedToolsPayload = null;
  const session = {
    id: "session-openai-tools-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      updateTools(payload) {
        updatedToolsPayload = payload;
      }
    }
  };

  await refreshRealtimeTools(manager, {
    session,
    settings: createVoiceTestSettings({
      memory: {
        enabled: true
      },
      agentStack: {
        runtimeConfig: {
          research: {
            enabled: true
          }
        }
      }
    }),
    reason: "test"
  });

  assert.ok(updatedToolsPayload);
  const toolNames = Array.isArray(updatedToolsPayload?.tools)
    ? updatedToolsPayload.tools.map((entry) => entry?.name)
    : [];
  assert.equal(toolNames.includes("memory_search"), false);
  assert.equal(toolNames.includes("memory_write"), true);
  assert.equal(toolNames.includes("music_search"), true);
  assert.equal(toolNames.includes("music_play"), true);
  assert.equal(toolNames.includes("video_search"), true);
  assert.equal(toolNames.includes("video_play"), true);
  assert.equal(toolNames.includes("start_screen_watch"), true);
  assert.equal(toolNames.includes("server_status"), true);
  const descriptorRows = Array.isArray(session.realtimeToolDefinitions) ? session.realtimeToolDefinitions : [];
  const mcpDescriptor = descriptorRows.find((entry) => entry?.name === "server_status");
  assert.equal(mcpDescriptor?.toolType, "mcp");
  const musicPlayDescriptor = descriptorRows.find((entry) => entry?.name === "music_play");
  assert.equal(musicPlayDescriptor?.parameters?.type, "object");
  assert.equal(Object.hasOwn(musicPlayDescriptor?.parameters || {}, "anyOf"), false);
  assert.equal(Object.hasOwn(musicPlayDescriptor?.parameters || {}, "oneOf"), false);
  assert.equal(Object.hasOwn(musicPlayDescriptor?.parameters || {}, "allOf"), false);
  const videoPlayDescriptor = descriptorRows.find((entry) => entry?.name === "video_play");
  assert.equal(videoPlayDescriptor?.parameters?.type, "object");
  assert.equal(Object.hasOwn(videoPlayDescriptor?.parameters || {}, "anyOf"), false);
  assert.equal(Object.hasOwn(videoPlayDescriptor?.parameters || {}, "oneOf"), false);
  assert.equal(Object.hasOwn(videoPlayDescriptor?.parameters || {}, "allOf"), false);
});

test("refreshRealtimeTools keeps start_screen_watch available for native watch sessions without a text channel", async () => {
  const manager = createVoiceTestManager();
  manager.getVoiceScreenWatchCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    reason: null,
    nativeAvailable: true,
    linkFallbackAvailable: false
  });

  let updatedToolsPayload = null;
  const session = {
    id: "session-openai-tools-native-screen-watch",
    guildId: "guild-1",
    textChannelId: null,
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      updateTools(payload) {
        updatedToolsPayload = payload;
      }
    }
  };

  await refreshRealtimeTools(manager, {
    session,
    settings: createVoiceTestSettings(),
    reason: "test"
  });

  const toolNames = Array.isArray(updatedToolsPayload?.tools)
    ? updatedToolsPayload.tools.map((entry) => entry?.name)
    : [];
  assert.equal(toolNames.includes("start_screen_watch"), true);
});

test("refreshRealtimeTools skips registration for brain sessions", async () => {
  const manager = createVoiceTestManager();
  let updateCount = 0;
  const session = {
    id: "session-openai-tools-brain",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "transport_only",
    realtimeClient: {
      updateTools() {
        updateCount += 1;
      }
    }
  };

  await refreshRealtimeTools(manager, {
    session,
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        }
      }
    }),
    reason: "test"
  });

  assert.equal(updateCount, 0);
});

test("refreshRealtimeTools clears stale provider tools when settings disable them", async () => {
  const manager = createVoiceTestManager();
  const updates = [];
  const session = {
    id: "session-openai-tools-clear",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "transport_only",
    lastRealtimeToolHash: "previous-tool-hash",
    realtimeToolDefinitions: [{ name: "music_play" }],
    realtimeClient: {
      updateTools(payload) {
        updates.push(payload);
      }
    }
  };

  await refreshRealtimeTools(manager, {
    session,
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        }
      }
    }),
    reason: "settings_reconcile"
  });

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    tools: [],
    toolChoice: "auto"
  });
  assert.deepEqual(session.realtimeToolDefinitions, []);
  assert.equal(session.lastRealtimeToolHash, "");
});

test("refreshRealtimeTools registers provider-native tools for bridge sessions", async () => {
  const manager = createVoiceTestManager();
  let updatedToolsPayload = null;
  const session = {
    id: "session-openai-tools-bridge",
    guildId: "guild-1",
    textChannelId: "chan-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      updateTools(payload) {
        updatedToolsPayload = payload;
      }
    }
  };

  await refreshRealtimeTools(manager, {
    session,
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          replyPath: "bridge"
        },
        soundboard: {
          enabled: true
        }
      }
    }),
    reason: "test"
  });

  assert.ok(updatedToolsPayload);
  const toolNames = Array.isArray(updatedToolsPayload?.tools)
    ? updatedToolsPayload.tools.map((entry) => entry?.name)
    : [];
  assert.equal(toolNames.includes("music_search"), true);
  assert.equal(toolNames.includes("video_play"), true);
  assert.equal(toolNames.includes("play_soundboard"), true);
  assert.equal(toolNames.includes("web_search"), true);
});

test("handleRealtimeFunctionCallEvent executes media_now_playing and sends function output", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [
        {
          id: "youtube:abc",
          title: "Track A",
          artist: "Artist A",
          durationMs: 120000,
          source: "yt",
          streamUrl: null,
          platform: "youtube",
          externalUrl: "https://youtube.com/watch?v=abc"
        }
      ],
      nowPlayingIndex: 0,
      isPaused: false,
      volume: 1
    },
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings({
      agentStack: {
        runtimeConfig: {
          research: {
            enabled: true
          }
        }
      }
    })
  });

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_music_1",
        name: "media_now_playing",
        arguments: "{}"
      }
    }
  });

  assert.equal(sentFunctionOutputs.length, 1);
  assert.equal(sentFunctionOutputs[0]?.callId, "call_music_1");
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, true);
  assert.equal(outputPayload?.queue_state?.tracks?.length, 1);
  assert.equal(outputPayload?.now_playing?.title, "Track A");
  const toolEvents = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0]?.toolName, "media_now_playing");
});

test("handleRealtimeFunctionCallEvent executes play_soundboard and sends function output", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};

  const soundboardPlayCalls = [];
  const session = {
    id: "session-openai-tool-call-soundboard-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };
  manager.soundboardDirector.play = async (payload) => {
    soundboardPlayCalls.push(payload);
    session.soundboard.playCount += 1;
    return { ok: true };
  };

  const sentFunctionOutputs = [];

  const settings = createVoiceTestSettings({
    voice: {
      conversationPolicy: {
        replyPath: "bridge"
      },
      soundboard: {
        enabled: true,
        preferredSoundIds: ["airhorn@123"]
      }
    }
  });
  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings
  });

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings,
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_soundboard_1",
        name: "play_soundboard",
        arguments: "{\"refs\":[\"airhorn@123\"]}"
      }
    }
  });

  assert.equal(soundboardPlayCalls.length, 1);
  assert.equal(soundboardPlayCalls[0]?.soundId, "airhorn");
  assert.equal(soundboardPlayCalls[0]?.sourceGuildId, "123");
  assert.equal(sentFunctionOutputs.length, 1);
  assert.equal(sentFunctionOutputs[0]?.callId, "call_soundboard_1");
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, true);
  assert.deepEqual(outputPayload?.played, ["airhorn@123"]);
  const toolEvents = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0]?.toolName, "play_soundboard");
});

test("handleRealtimeFunctionCallEvent ignores provider function calls in brain sessions", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-brain-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "transport_only",
    musicQueueState: {
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      tracks: [],
      nowPlayingIndex: null,
      isPaused: false,
      volume: 1
    },
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings({
      voice: {
        conversationPolicy: {
          replyPath: "brain"
        }
      }
    }),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_music_ignore_1",
        name: "media_now_playing",
        arguments: "{}"
      }
    }
  });

  assert.equal(sentFunctionOutputs.length, 0);
  assert.equal(Array.isArray(session.toolCallEvents) ? session.toolCallEvents.length : 0, 0);
});

test("handleRealtimeFunctionCallEvent executes start_screen_watch and sends function output", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};
  const offerCalls = [];
  manager.getVoiceScreenWatchCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    publicUrl: "https://screen.example",
    reason: null
  });
  manager.startVoiceScreenWatch = async (payload) => {
    offerCalls.push(payload);
    return {
      started: true,
      reason: "started",
      transport: "link",
      targetUserId: "speaker-2",
      linkUrl: "https://screen.example/session/abc",
      expiresInMinutes: 12
    };
  };

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-screen-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    lastRealtimeToolCallerUserId: "speaker-1",
    recentVoiceTurns: [
      {
        role: "user",
        userId: "speaker-1",
        text: "can i show you my screen?"
      }
    ],
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_screen_1",
        name: "start_screen_watch",
        arguments: "{\"target\":\"casey\"}"
      }
    }
  });

  assert.equal(offerCalls.length, 1);
  assert.equal(offerCalls[0]?.guildId, "guild-1");
  assert.equal(offerCalls[0]?.channelId, "chan-1");
  assert.equal(offerCalls[0]?.requesterUserId, "speaker-1");
  assert.equal(offerCalls[0]?.target, "casey");
  assert.equal(offerCalls[0]?.transcript, "can i show you my screen?");
  assert.equal(offerCalls[0]?.source, "voice_realtime_tool_call");
  assert.equal(sentFunctionOutputs.length, 1);
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, true);
  assert.equal(outputPayload?.started, true);
  assert.equal(outputPayload?.transport, "link");
  assert.equal(outputPayload?.targetUserId, "speaker-2");
  assert.equal(outputPayload?.linkUrl, "https://screen.example/session/abc");
});

test("handleRealtimeFunctionCallEvent sends cancelled tool output when a voice tool is aborted", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};

  let resolveSearchStarted = () => undefined;
  const searchStarted = new Promise<void>((resolve) => {
    resolveSearchStarted = resolve;
  });
  manager.search = {
    async searchAndRead({ signal }) {
      resolveSearchStarted();
      return await new Promise((_, reject) => {
        const rejectAbort = () => reject(createAbortError(signal?.reason || "cancelled_by_user"));
        if (signal?.aborted) {
          rejectAbort();
          return;
        }
        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }
  };

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-cancel-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings({
      agentStack: {
        runtimeConfig: {
          research: {
            enabled: true
          }
        }
      }
    })
  });

  const toolRun = manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings({
      agentStack: {
        runtimeConfig: {
          research: {
            enabled: true
          }
        }
      }
    }),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_web_cancel_1",
        name: "web_search",
        arguments: JSON.stringify({
          query: "latest rust news"
        })
      }
    }
  });

  await searchStarted;
  session.realtimePendingToolAbortControllers?.get("call_web_cancel_1")?.abort("user_cancelled");
  await toolRun;

  assert.equal(sentFunctionOutputs.length, 1);
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, false);
  assert.equal(outputPayload?.is_error, true);
  assert.equal(outputPayload?.cancelled, true);
  assert.equal(outputPayload?.error?.message, "Tool call cancelled by user.");
});

test("handleRealtimeFunctionCallEvent marks semantic tool failures with is_error", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};
  manager.musicSearch = {
    isConfigured() {
      return true;
    },
    async search() {
      return { results: [] };
    }
  };

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-semantic-error-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_music_not_found_1",
        name: "music_play",
        arguments: JSON.stringify({
          query: "a totally missing song"
        })
      }
    }
  });

  assert.equal(sentFunctionOutputs.length, 1);
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, false);
  assert.equal(outputPayload?.is_error, true);
  assert.equal(outputPayload?.status, "not_found");
  assert.equal(outputPayload?.error, "no_results");
});

test("handleRealtimeFunctionCallEvent ignores duplicate completed call ids", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleRealtimeToolFollowupResponse = () => {};

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-dup-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeToolOwnership: "provider_native",
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.realtimeToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_music_dup_1",
      name: "media_now_playing",
      arguments: "{}"
    }
  };

  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event
  });
  await manager.handleRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event
  });

  assert.equal(sentFunctionOutputs.length, 1);
  const toolEvents = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  assert.equal(toolEvents.length, 1);
});
