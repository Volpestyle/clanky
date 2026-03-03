import { SlashCommandBuilder } from "discord.js";

export const clankCommand = new SlashCommandBuilder()
  .setName("clank")
  .setDescription("Send a text message to the bot in voice (bypasses ASR)")
  .addStringOption((option) =>
    option
      .setName("message")
      .setDescription("Message to send to the bot")
      .setRequired(true)
  );
