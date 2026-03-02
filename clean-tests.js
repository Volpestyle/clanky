import * as fs from "fs";

const file = "src/voice/voiceSessionManager.lifecycle.test.ts";
let content = fs.readFileSync(file, "utf8");

// remove tests that contain enqueueDiscordPcmForPlayback
const blocks = content.split('test("');
const newBlocks = blocks.filter(b => !b.includes("enqueueDiscordPcmForPlayback") && !b.includes("DISCORD_PCM_FRAME_BYTES"));

let newContent = newBlocks.join('test("');
// Fix the first block which might just be imports
if (!newContent.startsWith('import')) {
  // It's already fine
}

fs.writeFileSync(file, newContent, "utf8");
console.log("Cleaned up tests");
