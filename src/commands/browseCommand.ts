import { SlashCommandBuilder } from "discord.js";

export const browseCommand = new SlashCommandBuilder()
    .setName("browse")
    .setDescription("Command the browser agent to navigate the web and extract info")
    .addStringOption((option) =>
        option
            .setName("task")
            .setDescription("The instruction for the agent")
            .setRequired(true)
    );
