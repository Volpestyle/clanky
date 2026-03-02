import { VoiceSubprocessClient } from "./voiceSubprocessClient.ts";
import type { IVoiceClient, VoiceClientOptions } from "./voiceClient.ts";

export type VoiceClientType = "node-subprocess" | "in-process";

export async function createVoiceClient(
  type: VoiceClientType,
  guildId: string,
  channelId: string,
  guild: any,
  opts: VoiceClientOptions = {}
): Promise<IVoiceClient> {
  if (type === "node-subprocess") {
    return await VoiceSubprocessClient.spawn(guildId, channelId, guild, opts);
  }
  
  if (type === "in-process") {
    throw new Error("in-process voice client not yet implemented");
  }
  
  throw new Error(`Unknown voice client type: ${type}`);
}