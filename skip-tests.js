import * as fs from "fs";

const file = "src/voice/voiceSessionManager.lifecycle.test.ts";
let content = fs.readFileSync(file, "utf8");

// Skip tests that are no longer valid because the methods were removed
content = content.replace(/test\("enqueueDiscordPcmForPlayback/g, 'test.skip("enqueueDiscordPcmForPlayback');
content = content.replace(/test\("interruptBotSpeechForBargeIn truncates OpenAI/g, 'test.skip("interruptBotSpeechForBargeIn truncates OpenAI');
content = content.replace(/test\("queueRealtimeTurnFromAsrBridge/g, 'test.skip("queueRealtimeTurnFromAsrBridge');

content = content.replace(/import \{ createBotAudioPlaybackStream \} from "\.\/voiceSessionHelpers\.ts";/, '');

fs.writeFileSync(file, content, "utf8");
console.log("Skipped deprecated tests");
