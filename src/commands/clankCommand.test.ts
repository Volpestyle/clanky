import { test } from "bun:test";
import assert from "node:assert/strict";
import { ApplicationCommandOptionType } from "discord.js";
import { clankCommand } from "./clankCommand.ts";

test("clank command exposes say, browse, code, and music actions under one root", () => {
  const json = clankCommand.toJSON();
  const options = Array.isArray(json.options) ? json.options : [];
  const say = options.find((option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "say");
  const browse = options.find((option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "browse");
  const code = options.find((option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "code");
  const music = options.find((option) => option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === "music");

  assert.ok(say);
  assert.ok(browse);
  assert.ok(code);
  assert.ok(music);
  assert.equal(say?.description, "Send a text message to the bot in voice (bypasses ASR)");
  assert.equal(browse?.description, "Command the browser agent to navigate the web and extract info");
  assert.equal(code?.description, "Run a coding task via the configured code worker (allowed users only)");
  assert.equal(music?.description, "Control VC music playback and queue");

  const browseOptions = Array.isArray(browse?.options) ? browse.options : [];
  const codeOptions = Array.isArray(code?.options) ? code.options : [];
  const musicOptions = Array.isArray(music?.options) ? music.options : [];
  assert.equal(browseOptions.some((option) => option.name === "task"), true);
  assert.equal(codeOptions.some((option) => option.name === "task"), true);
  assert.equal(codeOptions.some((option) => option.name === "role"), true);
  assert.equal(codeOptions.some((option) => option.name === "cwd"), true);
  assert.equal(musicOptions.some((option) => option.name === "play"), true);
  assert.equal(musicOptions.some((option) => option.name === "stop"), true);
});
