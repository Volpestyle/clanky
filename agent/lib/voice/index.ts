/**
 * Voice control plane (ported from agents/clanky/src/voice/*). Barrel export so
 * the whole stack is part of the compile graph and the eve voice channel can
 * pull in exactly what it needs.
 */
export * from "./clankvoxIpcClient.ts";
export * from "./clankvoxRealtimeBridge.ts";
export * from "./discordStreamDiscovery.ts";
export * from "./discordVoiceSpeakerTranscription.ts";
export * from "./discordVoiceTurnBuffer.ts";
export * from "./elevenLabsTtsClient.ts";
export * from "./eve-session.ts";
export * from "./liveValidation.ts";
export * from "./liveValidationResult.ts";
export * from "./memory.ts";
export * from "./openAiRealtimeClient.ts";
export * from "./supervisor.ts";
export * from "./xAiRealtimeClient.ts";
