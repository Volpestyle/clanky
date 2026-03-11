import { SlashCommandBuilder } from "discord.js";
import { addBrowseSubcommand } from "./browseCommand.ts";
import { addCodeSubcommand } from "./codeCommand.ts";
import { addMusicSubcommandGroup } from "../voice/musicCommands.ts";

export const clankCommand = addCodeSubcommand(
  addBrowseSubcommand(
    new SlashCommandBuilder()
      .setName("clank")
      .setDescription("Text, browsing, coding, and music commands")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("say")
          .setDescription("Send a text message to the bot in voice (bypasses ASR)")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Message to send to the bot")
              .setRequired(true)
          )
      )
      .addSubcommandGroup((group) => addMusicSubcommandGroup(group))
  )
);
