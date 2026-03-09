import { SlashCommandBuilder } from "discord.js";

export const musicCommands = [
  new SlashCommandBuilder()
    .setName("music")
    .setDescription("Control VC music playback and queue")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("play")
        .setDescription("Play a song now and replace the current track")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("Song name or URL to play")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a song to the end of the queue")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("Song name or URL to add")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("next")
        .setDescription("Queue a song to play after the current track")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("Song name or URL to queue next")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("queue")
        .setDescription("Show the current queue")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("now")
        .setDescription("Show the current track and playback state")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("skip")
        .setDescription("Skip to the next track in the queue")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("pause")
        .setDescription("Pause music playback")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("resume")
        .setDescription("Resume paused music")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stop")
        .setDescription("Stop playback and clear the queue")
    )
];
