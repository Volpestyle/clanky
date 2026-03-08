import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import { buildRealtimeFunctionTools } from "./voiceToolCallToolRegistry.ts";
import { refreshRealtimeTools } from "./voiceToolCallInfra.ts";
import { createVoiceTestManager, createVoiceTestSettings } from "./voiceTestHarness.ts";

test("refreshRealtimeTools registers local and MCP tool definitions", async () => {
  const manager = createVoiceTestManager();
  manager.getVoiceScreenShareCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    publicUrl: "https://screen.example",
    reason: null
  });
  manager.offerVoiceScreenShareLink = async () => ({
    offered: true,
    reason: "offered"
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
      webSearch: {
        enabled: true
      }
    }),
    reason: "test"
  });

  assert.ok(updatedToolsPayload);
  const toolNames = Array.isArray(updatedToolsPayload?.tools)
    ? updatedToolsPayload.tools.map((entry) => entry?.name)
    : [];
  assert.equal(toolNames.includes("memory_search"), true);
  assert.equal(toolNames.includes("memory_write"), true);
  assert.equal(toolNames.includes("music_search"), true);
  assert.equal(toolNames.includes("offer_screen_share_link"), true);
  assert.equal(toolNames.includes("server_status"), true);
  const descriptorRows = Array.isArray(session.openAiToolDefinitions) ? session.openAiToolDefinitions : [];
  const mcpDescriptor = descriptorRows.find((entry) => entry?.name === "server_status");
  assert.equal(mcpDescriptor?.toolType, "mcp");
});

test("handleOpenAiRealtimeFunctionCallEvent executes music_now_playing and sends function output", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleOpenAiRealtimeToolFollowupResponse = () => {};

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
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

  session.openAiToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings({
      webSearch: {
        enabled: true
      }
    })
  });

  await manager.handleOpenAiRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_music_1",
        name: "music_now_playing",
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
  assert.equal(toolEvents[0]?.toolName, "music_now_playing");
});

test("handleOpenAiRealtimeFunctionCallEvent executes offer_screen_share_link and sends function output", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleOpenAiRealtimeToolFollowupResponse = () => {};
  const offerCalls = [];
  manager.getVoiceScreenShareCapability = () => ({
    supported: true,
    enabled: true,
    available: true,
    status: "ready",
    publicUrl: "https://screen.example",
    reason: null
  });
  manager.offerVoiceScreenShareLink = async (payload) => {
    offerCalls.push(payload);
    return {
      offered: true,
      reason: "offered",
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
    lastOpenAiToolCallerUserId: "speaker-1",
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

  session.openAiToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  await manager.handleOpenAiRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_screen_1",
        name: "offer_screen_share_link",
        arguments: "{}"
      }
    }
  });

  assert.equal(offerCalls.length, 1);
  assert.equal(offerCalls[0]?.guildId, "guild-1");
  assert.equal(offerCalls[0]?.channelId, "chan-1");
  assert.equal(offerCalls[0]?.requesterUserId, "speaker-1");
  assert.equal(offerCalls[0]?.transcript, "can i show you my screen?");
  assert.equal(offerCalls[0]?.source, "voice_realtime_tool_call");
  assert.equal(sentFunctionOutputs.length, 1);
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, true);
  assert.equal(outputPayload?.offered, true);
  assert.equal(outputPayload?.linkUrl, "https://screen.example/session/abc");
});

test("handleOpenAiRealtimeFunctionCallEvent sends cancelled tool output when a voice tool is aborted", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleOpenAiRealtimeToolFollowupResponse = () => {};

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
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.openAiToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings({
      webSearch: {
        enabled: true
      }
    })
  });

  const toolRun = manager.handleOpenAiRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings({
      webSearch: {
        enabled: true
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
  session.openAiPendingToolAbortControllers?.get("call_web_cancel_1")?.abort("user_cancelled");
  await toolRun;

  assert.equal(sentFunctionOutputs.length, 1);
  const outputPayload = JSON.parse(String(sentFunctionOutputs[0]?.output || "{}"));
  assert.equal(outputPayload?.ok, false);
  assert.equal(outputPayload?.cancelled, true);
  assert.equal(outputPayload?.error?.message, "Tool call cancelled by user.");
});

test("handleOpenAiRealtimeFunctionCallEvent ignores duplicate completed call ids", async () => {
  const manager = createVoiceTestManager();
  manager.scheduleOpenAiRealtimeToolFollowupResponse = () => {};

  const sentFunctionOutputs = [];
  const session = {
    id: "session-openai-tool-call-dup-1",
    guildId: "guild-1",
    textChannelId: "chan-1",
    voiceChannelId: "voice-1",
    mode: "openai_realtime",
    ending: false,
    realtimeClient: {
      sendFunctionCallOutput(payload) {
        sentFunctionOutputs.push(payload);
      }
    }
  };

  session.openAiToolDefinitions = buildRealtimeFunctionTools(manager, {
    session,
    settings: createVoiceTestSettings()
  });

  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_music_dup_1",
      name: "music_now_playing",
      arguments: "{}"
    }
  };

  await manager.handleOpenAiRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event
  });
  await manager.handleOpenAiRealtimeFunctionCallEvent({
    session,
    settings: createVoiceTestSettings(),
    event
  });

  assert.equal(sentFunctionOutputs.length, 1);
  const toolEvents = Array.isArray(session.toolCallEvents) ? session.toolCallEvents : [];
  assert.equal(toolEvents.length, 1);
});
