import { SlashCommandBuilder } from "discord.js";

export function addCodeSubcommand(command: SlashCommandBuilder) {
  return command.addSubcommand((subcommand) =>
    subcommand
      .setName("code")
      .setDescription("Run a coding task via the configured code worker (allowed users only)")
      .addStringOption((option) =>
        option
          .setName("task")
          .setDescription("The coding instruction for the configured code worker")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("role")
          .setDescription("Optional worker role to target")
          .setRequired(false)
          .addChoices(
            { name: "Implementation", value: "implementation" },
            { name: "Design", value: "design" },
            { name: "Review", value: "review" },
            { name: "Research", value: "research" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("cwd")
          .setDescription("Working directory (defaults to configured project root)")
          .setRequired(false)
      )
  );
}
