import { EventEmitter } from "node:events";

export interface VoiceClientOptions {
  selfDeaf?: boolean;
  selfMute?: boolean;
  timeoutMs?: number;
}

export interface IVoiceClient extends EventEmitter {
  get isAlive(): boolean;

  sendAudio(pcmBase64: string, sampleRate?: number): void;
  stopPlayback(): void;

  subscribeUser(userId: string, silenceDurationMs?: number, sampleRate?: number): void;
  unsubscribeUser(userId: string): void;

  musicPlay(url: string): void;
  musicStop(): void;
  musicPause(): void;
  musicResume(): void;

  destroy(): void;
}