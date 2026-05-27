// IMPORTANT: import discord.js primitives via @agentroom/chat-discord so we
// share the SAME discord.js module instance the user-token patches in
// chat-discord/discordUserTokenPatches.ts resolve. Importing
// `discord.js` directly here pulled in clanky-pi's own copy of the package,
// leaving the agent-room copy unpatched and crashing on user-token READY.
import {
	applyDiscordUserTokenPatches,
	DiscordClient,
	type DiscordClientOptions,
	type DiscordGatewayClient,
	DiscordGatewayIntentBits,
	DiscordPartials,
} from "@agentroom/chat-discord";
import type { ClankyAgentDiscordCredentialConfig } from "./agentDiscordGateway.ts";

export interface CreateAgentDiscordClientOptions {
	voice?: boolean;
	chat?: boolean;
	clientOptions?: DiscordClientOptions;
}

export function createAgentDiscordClient(options: CreateAgentDiscordClientOptions = {}): DiscordGatewayClient {
	if (options.clientOptions !== undefined) return new DiscordClient(options.clientOptions) as DiscordGatewayClient;

	const includeChatIntents = options.chat !== false;
	const intents = [DiscordGatewayIntentBits.Guilds];
	if (includeChatIntents) {
		intents.push(
			DiscordGatewayIntentBits.GuildMembers,
			DiscordGatewayIntentBits.GuildMessages,
			DiscordGatewayIntentBits.DirectMessages,
			DiscordGatewayIntentBits.MessageContent,
		);
	}
	if (options.voice === true) intents.push(DiscordGatewayIntentBits.GuildVoiceStates);

	return new DiscordClient({
		intents,
		partials: [DiscordPartials.Channel, DiscordPartials.Message],
	}) as DiscordGatewayClient;
}

export async function loginAgentDiscordClient(
	client: DiscordGatewayClient,
	config: Pick<ClankyAgentDiscordCredentialConfig, "token" | "credentialKind">,
): Promise<void> {
	if (config.credentialKind === "user-token") {
		applyDiscordUserTokenPatches(client);
	}
	await client.login(config.token);
}
