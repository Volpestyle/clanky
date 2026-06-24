/**
 * Clanky's agent-owned Discord channel (SPEC.md §5.2).
 *
 * Built on eve's Discord HTTP Interactions channel: Clanky holds the bot
 * credential and the conversation. Each invocation starts/resumes an eve
 * session; watchable or parallel work is handed to herdr panes via the
 * herdr_spawn tool from inside the turn, so it shows up on the stage.
 *
 * Env (or pass via credentials):
 *   DISCORD_PUBLIC_KEY       verifies inbound interaction signatures
 *   DISCORD_APPLICATION_ID   edits the deferred response + followups
 *   DISCORD_BOT_TOKEN        proactive messages, fallback, typing
 *
 * NOTE: this is the interactions baseline. Gateway-owned free-will presence is
 * documented in SPEC.md §5.2 and booted separately by discord-gateway.ts.
 */
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
	// Decide whether to handle an interaction and under what identity.
	// (Discord does not deliver slash-command interactions from bot users.)
	onCommand: (_ctx, interaction) => {
		return {
			auth: {
				principalId: interaction.user.id,
				principalType: "user",
				authenticator: "discord",
				attributes: {
					channel_id: interaction.channelId,
					guild_id: interaction.guildId ?? "",
				},
			},
		};
	},
	events: {
		// Post Clanky's reply back to Discord when a turn completes. Skip interim
		// turns that only emitted tool calls (e.g. spawning a herdr pane).
		"message.completed"(eventData, channel) {
			if (eventData.finishReason === "tool-calls") return;
			if (eventData.message) channel.discord.post(eventData.message);
		},
	},
});
