import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { normalizeVoiceText } from "./voiceSessionHelpers.ts";

function createManager({ memory = null }: { memory?: unknown } = {}) {
  const logs: unknown[] = [];
  const recordedMessages: Array<Record<string, unknown>> = [];

  const client = {
    on() {},
    off() {},
    guilds: { cache: new Map() },
    users: { cache: new Map() },
    user: { id: "bot-user", username: "clanker conk" }
  };

  const manager = new VoiceSessionManager({
    client,
    store: {
      logAction(entry: unknown) {
        logs.push(entry);
      },
      recordMessage(entry: Record<string, unknown>) {
        recordedMessages.push(entry);
      },
      getSettings() {
        return { botName: "clanker conk" };
      }
    },
    appConfig: {},
    llm: {
      async generate() {
        return { text: "NO" };
      }
    },
    memory
  });

  return { manager, logs, recordedMessages };
}

// --- Fix 1: Memory tools gated by settings.memory.enabled ---

test("memory tools excluded when settings.memory.enabled is false", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: { memory: { enabled: false }, webSearch: { enabled: true } }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(!names.includes("memory_search"), "memory_search should be excluded");
  assert.ok(!names.includes("memory_write"), "memory_write should be excluded");
});

test("memory tools included when settings.memory.enabled is true", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: {
      memory: { enabled: true },
      adaptiveDirectives: { enabled: true },
      webSearch: { enabled: true }
    }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("memory_search"), "memory_search should be included");
  assert.ok(names.includes("memory_write"), "memory_write should be included");
  assert.ok(names.includes("adaptive_directive_add"), "adaptive_directive_add should be included");
  assert.ok(names.includes("adaptive_directive_remove"), "adaptive_directive_remove should be included");
});

test("adaptive directive tools can stay enabled when durable memory is disabled", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: {
      memory: { enabled: false },
      adaptiveDirectives: { enabled: true },
      webSearch: { enabled: true }
    }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(!names.includes("memory_search"), "memory_search should be excluded");
  assert.ok(!names.includes("memory_write"), "memory_write should be excluded");
  assert.ok(names.includes("adaptive_directive_add"), "adaptive_directive_add should be included");
  assert.ok(names.includes("adaptive_directive_remove"), "adaptive_directive_remove should be included");
});

test("adaptive directive tools can be disabled independently of durable memory", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: {
      memory: { enabled: true },
      adaptiveDirectives: { enabled: false },
      webSearch: { enabled: true }
    }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("memory_search"), "memory_search should be included");
  assert.ok(names.includes("memory_write"), "memory_write should be included");
  assert.ok(!names.includes("adaptive_directive_add"), "adaptive_directive_add should be excluded");
  assert.ok(!names.includes("adaptive_directive_remove"), "adaptive_directive_remove should be excluded");
});

test("memory tools excluded when settings is null", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: null
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(!names.includes("memory_search"), "memory_search should be excluded");
  assert.ok(!names.includes("memory_write"), "memory_write should be excluded");
  assert.ok(!names.includes("adaptive_directive_add"), "adaptive_directive_add should be excluded");
  assert.ok(!names.includes("adaptive_directive_remove"), "adaptive_directive_remove should be excluded");
});

// --- Fix 1 regression: web_search still gated ---

test("web_search excluded when settings.webSearch.enabled is false", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: { memory: { enabled: true }, webSearch: { enabled: false } }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(!names.includes("web_search"), "web_search should be excluded");
  assert.ok(names.includes("memory_search"), "memory_search should still be included");
});

test("web_search included when settings.webSearch.enabled is true", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: { memory: { enabled: false }, webSearch: { enabled: true } }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("web_search"), "web_search should be included");
});

test("code_task excluded when code agent is enabled but runtime hooks are unavailable", () => {
  const { manager } = createManager();
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: {
      codeAgent: { enabled: true }
    }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(!names.includes("code_task"), "code_task should be excluded without executable hooks");
});

test("code_task included when code agent is enabled and one-shot runtime hook is available", () => {
  const { manager } = createManager();
  manager.runModelRequestedCodeTask = async () => ({ text: "ok" });
  const tools = manager.resolveVoiceRealtimeToolDescriptors({
    session: null,
    settings: {
      codeAgent: { enabled: true }
    }
  });

  const names = tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("code_task"), "code_task should be included when runtime hook is available");
});

// --- Fix 2: Short transcript passes through normalizeVoiceText ---

test("normalizeVoiceText passes through short text", () => {
  assert.equal(normalizeVoiceText("hi", 1200), "hi");
});

test("normalizeVoiceText passes through single word", () => {
  assert.equal(normalizeVoiceText("yes", 1200), "yes");
});

test("normalizeVoiceText truncates text exceeding maxChars", () => {
  const long = "a".repeat(2000);
  const result = normalizeVoiceText(long, 100);
  assert.equal(result.length, 100);
});

test("assistant voice turns are persisted into searchable message history", () => {
  const { manager, recordedMessages } = createManager();
  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    ending: false,
    settingsSnapshot: { botName: "clanker conk" },
    recentVoiceTurns: [],
    transcriptTurns: []
  };

  manager.recordVoiceTurn(session, {
    role: "assistant",
    text: "nvda was around 181 earlier"
  });

  assert.equal(recordedMessages.length, 1);
  assert.equal(recordedMessages[0]?.isBot, true);
  assert.equal(recordedMessages[0]?.channelId, "text-1");
  assert.equal(recordedMessages[0]?.content, "nvda was around 181 earlier");
});

// --- Fix 3: Pending ingestion awaited before memory slice ---

test("pending ingestion is awaited before memory slice lookup", async () => {
  const events: string[] = [];

  let resolveIngest: () => void;
  const ingestPromise = new Promise<void>((resolve) => {
    resolveIngest = resolve;
  });

  const mockMemory = {
    async ingestMessage() {
      await ingestPromise;
      events.push("ingest_done");
    },
    async loadPromptMemorySlice() {
      events.push("lookup_done");
      return { userFacts: [], relevantFacts: [] };
    }
  };

  const { manager } = createManager({ memory: mockMemory });

  const session = {
    id: "session-1",
    guildId: "guild-1",
    textChannelId: "text-1",
    pendingMemoryIngest: null as Promise<unknown> | null
  };

  // Queue ingestion — stores promise on session
  manager.queueVoiceMemoryIngest({
    session,
    settings: { memory: { enabled: true } },
    userId: "user-1",
    transcript: "remember this fact about me"
  });

  assert.ok(session.pendingMemoryIngest, "pendingMemoryIngest should be set on session");

  // Now resolve the ingest (simulating async completion)
  resolveIngest!();

  // buildRealtimeMemorySlice should drain the pending ingestion first
  await manager.buildRealtimeMemorySlice({
    session,
    settings: { memory: { enabled: true } },
    userId: "user-1",
    transcript: "what do you know about me"
  });

  assert.equal(session.pendingMemoryIngest, null, "pendingMemoryIngest should be cleared after drain");
});
