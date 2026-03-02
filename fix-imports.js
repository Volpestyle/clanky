import * as fs from "fs";

const files = [
  "src/voice/voiceSessionManager.addressing.ts",
  "src/voice/voiceSessionManager.asr.ts",
  "src/voice/voiceSessionManager.music.ts",
  "src/voice/voiceSessionManager.streamWatch.ts",
  "src/voice/voiceSessionManager.tools.ts"
];

for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  
  // fix imports without extensions
  content = content.replace(/from "(\.[^"]+)"/g, (match, p1) => {
    if (!p1.endsWith(".ts") && !p1.endsWith(".js")) {
      return `from "${p1}.ts"`;
    }
    return match;
  });

  // add VoiceMcpServerStatus import to tools
  if (file.includes("tools.ts")) {
    content = content.replace(/import { clamp }/, 'import type { VoiceMcpServerStatus } from "../../dashboard/src/api.ts";\\nimport { clamp }');
  }

  fs.writeFileSync(file, content, "utf8");
}
console.log("Fixed imports");
