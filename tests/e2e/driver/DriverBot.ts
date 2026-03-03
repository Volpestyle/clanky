import {
  Client,
  GatewayIntentBits,
  Events
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer
} from "@discordjs/voice";

export type DriverBotConfig = {
  token: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string;
  systemBotUserId: string;
};

export type DriverBotEvents = {
  onSystemBotSpeaking?: (userId: string) => void;
  onSystemBotSilence?: (userId: string) => void;
  onAudioChunk?: (chunk: Buffer) => void;
  onError?: (error: Error) => void;
};

function waitForEvent<K extends string>(
  emitter: { on: (event: K, listener: () => void) => unknown; off: (event: K, listener: () => void) => unknown },
  event: K,
  timeoutMs = 30_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    const listener = () => {
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve();
    };

    emitter.on(event, listener);
  });
}

export class DriverBot {
  client: Client;
  connection: VoiceConnection | null = null;
  player: AudioPlayer | null = null;

  readonly config: DriverBotConfig;

  private receivedAudioChunks: Buffer[] = [];
  private connected = false;
  private subscribedToSystemBot = false;

  constructor(config: DriverBotConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.login(this.config.token);
    await waitForEvent(this.client, Events.ClientReady, 15_000);
    this.connected = true;
  }

  async joinVoiceChannel(): Promise<void> {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) {
      throw new Error(`Guild ${this.config.guildId} not found`);
    }

    const channel = guild.channels.cache.get(this.config.voiceChannelId);
    if (!channel?.isVoiceBased()) {
      throw new Error(`Voice channel ${this.config.voiceChannelId} not found or not voice-based`);
    }

    this.connection = joinVoiceChannel({
      guildId: this.config.guildId,
      channelId: this.config.voiceChannelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    // Log connection state transitions
    this.connection.on("stateChange", (oldState, newState) => {
      console.log(`[DriverBot] connection state: ${oldState.status} → ${newState.status}`);
    });

    await waitForEvent(this.connection, "ready", 15_000);
    console.log(`[DriverBot] voice connection ready, subscribing to speaking events`);
    console.log(`[DriverBot] watching for system bot userId: ${this.config.systemBotUserId}`);

    // Log ALL speaking events, not just system bot
    this.connection.receiver.speaking.on("start", (userId) => {
      console.log(`[DriverBot] speaking START: userId=${userId} (system bot? ${userId === this.config.systemBotUserId})`);
      if (userId === this.config.systemBotUserId) {
        this.subscribeToSystemBotAudio();
      }
    });

    this.connection.receiver.speaking.on("end", (userId) => {
      console.log(`[DriverBot] speaking END: userId=${userId}`);
    });
  }

  private subscribeToSystemBotAudio(): void {
    if (!this.connection) return;
    if (this.subscribedToSystemBot) return;
    this.subscribedToSystemBot = true;
    console.log(`[DriverBot] subscribing to system bot audio stream`);

    const audioStream = this.connection.receiver.subscribe(this.config.systemBotUserId, {
      end: { behavior: EndBehaviorType.Manual }
    });

    audioStream.on("data", (chunk: Buffer) => {
      this.receivedAudioChunks.push(chunk);
      if (this.receivedAudioChunks.length % 50 === 1) {
        console.log(`[DriverBot] received audio chunk #${this.receivedAudioChunks.length}, total bytes: ${this.getReceivedAudioBytes()}`);
      }
    });
  }

  playAudio(audioPath: string): Promise<void> {
    if (!this.connection) {
      throw new Error("Not connected to voice channel");
    }
    console.log(`[DriverBot] playAudio: ${audioPath}`);

    this.player = createAudioPlayer();
    this.player.on("stateChange", (oldState, newState) => {
      console.log(`[DriverBot] player state: ${oldState.status} → ${newState.status}`);
    });
    this.player.on("error", (err) => {
      console.error(`[DriverBot] player error:`, err);
    });
    this.connection.subscribe(this.player);

    const resource = createAudioResource(audioPath);
    this.player.play(resource);

    return waitForEvent(this.player, AudioPlayerStatus.Idle, 30_000);
  }

  getReceivedAudioBytes(): number {
    return this.receivedAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  getReceivedAudioBuffer(): Buffer {
    return Buffer.concat(this.receivedAudioChunks);
  }

  clearReceivedAudio(): void {
    this.receivedAudioChunks = [];
  }

  // --- Text Channel Helpers (Future Extension) ---

  async getTextChannel() {
    if (!this.config.textChannelId) {
      throw new Error("Text channel ID not configured");
    }
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) {
      throw new Error(`Guild ${this.config.guildId} not found`);
    }
    const channel = guild.channels.cache.get(this.config.textChannelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Text channel ${this.config.textChannelId} not found or not text-based`);
    }
    return channel;
  }

  async sendTextMessage(content: string) {
    const channel = await this.getTextChannel();
    return channel.send(content);
  }

  async waitForMessage(userId: string, timeoutMs: number = 30000) {
    const channel = await this.getTextChannel();

    return new Promise((resolve, reject) => {
      const filter = (m: any) => m.author.id === userId;
      // createMessageCollector ensures we only capture new messages from this point forward
      const collector = channel.createMessageCollector({ filter, time: timeoutMs, max: 1 });

      collector.on('collect', (m) => resolve(m));
      collector.on('end', (collected) => {
        if (collected.size === 0) {
          reject(new Error(`Timeout waiting for text message from user ${userId} after ${timeoutMs}ms`));
        }
      });
    });
  }

  async waitForReaction(userId: string, timeoutMs = 30000): Promise<{ emoji: string; userId: string }> {
    const channel = await this.getTextChannel();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.off("messageReactionAdd", handler);
        reject(new Error(`Timeout waiting for reaction from user ${userId} after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (reaction: any, user: any) => {
        if (user.id === userId && reaction.message.channelId === channel.id) {
          clearTimeout(timer);
          this.client.off("messageReactionAdd", handler);
          resolve({
            emoji: reaction.emoji.name || reaction.emoji.id || "",
            userId: user.id
          });
        }
      };

      this.client.on("messageReactionAdd", handler);
    });
  }

  async waitForNoMessage(userId: string, timeoutMs = 5000): Promise<boolean> {
    const channel = await this.getTextChannel();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client.off("messageCreate", handler);
        resolve(true); // No message received — success
      }, timeoutMs);

      const handler = (m: any) => {
        if (m.author.id === userId && m.channelId === channel.id) {
          clearTimeout(timer);
          this.client.off("messageCreate", handler);
          resolve(false); // Message received — failure
        }
      };

      this.client.on("messageCreate", handler);
    });
  }

  /**
   * Ensure the system bot is in the voice channel with an active session.
   * Sends a text message to trigger join, waits via voiceStateUpdate or
   * speaking detection.
   */
  async summonSystemBot(timeoutMs = 45_000): Promise<void> {
    const alreadyInVoice = this.isSystemBotInVoice();
    console.log(`[DriverBot] summonSystemBot: alreadyInVoice=${alreadyInVoice}`);

    if (alreadyInVoice) {
      console.log("[DriverBot] system bot in voice, running warmup ping");
      await this.warmupAudioPipeline(timeoutMs);
      return;
    }

    console.log("[DriverBot] summoning system bot via text message");

    const joinPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.off("voiceStateUpdate", handler);
        reject(new Error(`System bot did not join voice within ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (oldState: { id: string; channelId: string | null }, newState: { id: string; channelId: string | null }) => {
        console.log(`[DriverBot] voiceStateUpdate: userId=${newState.id} channel=${oldState.channelId} → ${newState.channelId}`);
        if (
          newState.id === this.config.systemBotUserId &&
          newState.channelId === this.config.voiceChannelId
        ) {
          clearTimeout(timer);
          this.client.off("voiceStateUpdate", handler);
          resolve();
        }
      };

      this.client.on("voiceStateUpdate", handler);
    });

    await this.sendTextMessage("yo clanker come join voice");
    await joinPromise;

    console.log("[DriverBot] system bot joined voice channel, running warmup");
    await this.warmupAudioPipeline(15_000);
  }

  /**
   * Play the greeting fixture and wait until we receive audio back from
   * the system bot, confirming the full audio pipeline is live. Discards
   * all captured audio afterward.
   */
  private async warmupAudioPipeline(timeoutMs = 15_000): Promise<void> {
    const { getFixturePath } = await import("./audioGenerator.ts");
    const fixture = getFixturePath("greeting_yo");

    console.log("[DriverBot] warmup: playing greeting fixture");
    await this.playAudio(fixture);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.subscribedToSystemBot && this.getReceivedAudioBytes() > 0) {
        console.log(`[DriverBot] warmup: received ${this.getReceivedAudioBytes()} bytes, pipeline confirmed`);
        this.clearReceivedAudio();
        // Wait for clanker to finish speaking before tests start
        await new Promise((r) => setTimeout(r, 5000));
        this.clearReceivedAudio();
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Warmup didn't get audio back — proceed anyway, tests will reveal issues
    console.log("[DriverBot] warmup: no audio received, proceeding anyway");
    this.clearReceivedAudio();
  }

  isSystemBotInVoice(): boolean {
    if (!this.connection) return false;
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) return false;
    const channel = guild.channels.cache.get(this.config.voiceChannelId);
    if (!channel?.isVoiceBased()) return false;
    return channel.members.has(this.config.systemBotUserId);
  }

  async waitForBotLeave(timeoutMs = 120_000, pollMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isSystemBotInVoice()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async waitForAudioResponse(timeoutMs = 10_000, pollMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.getReceivedAudioBytes() > 0) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async disconnect(): Promise<void> {
    this.connection?.destroy();
    this.connection = null;
    this.player?.stop();
    this.player = null;
    this.subscribedToSystemBot = false;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.client.destroy();
    this.connected = false;
  }
}
