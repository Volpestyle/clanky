import { SlashCommandBuilder } from "discord.js";

export const codeCommand = new SlashCommandBuilder()
    .setName("code")
    .setDescription("Run a coding task via Claude Code (allowed users only)")
    .addStringOption((option) =>
        option
            .setName("task")
            .setDescription("The coding instruction for Claude Code")
            .setRequired(true)
    )
    .addStringOption((option) =>
        option
            .setName("cwd")
            .setDescription("Working directory (defaults to configured project root)")
            .setRequired(false)
    );
