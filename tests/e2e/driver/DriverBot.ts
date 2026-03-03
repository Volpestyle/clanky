import {
  Client,
  GatewayIntentBits,
  Events,
  VoiceState,
  type Guild,
  type VoiceBasedChannel
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
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

    await waitForEvent(this.connection, "ready", 15_000);

    this.connection.receiver.speaking.on("start", (userId) => {
      if (userId === this.config.systemBotUserId) {
        this.subscribeToSystemBotAudio();
      }
    });
  }

  private subscribeToSystemBotAudio(): void {
    if (!this.connection) return;

    const audioStream = this.connection.receiver.subscribe(this.config.systemBotUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 3000 }
    });

    audioStream.on("data", (chunk: Buffer) => {
      this.receivedAudioChunks.push(chunk);
    });
  }

  playAudio(audioPath: string, spoofUserId?: string): Promise<void> {
    if (!this.connection) {
      throw new Error("Not connected to voice channel");
    }

    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    const resource = createAudioResource(audioPath, {
      inputType: StreamType.Raw
    });

    // Experimental: Trying to tell the @discordjs/voice connection that this
    // outgoing audio stream corresponds to a specific userId. The connection
    // must already be established.
    // Note: True SSRC spoofing at the UDP level might require patching discordjs/voice
    // but we can pass the logical user identity down contextually if supported.
    if (spoofUserId) {
      (this.player as any).spoofUserId = spoofUserId;
    }

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

  async disconnect(): Promise<void> {
    this.connection?.destroy();
    this.connection = null;
    this.player?.stop();
    this.player = null;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.client.destroy();
    this.connected = false;
  }
}
