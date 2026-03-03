import { generatePcmAudioFixture, getFixturePath } from "../driver/audioGenerator.ts";
import { existsSync } from "node:fs";

const REQUIRED_FIXTURES = [
  {
    name: "greeting_yo",
    text: "yo clanker",
    description: "Basic wake word greeting"
  },
  {
    name: "direct_question",
    text: "clanker what is two plus two",
    description: "Direct question requiring response"
  },
  {
    name: "undirected_chatter",
    text: "the build passed on main",
    description: "Undirected speech that should be ignored"
  }
];

async function main() {
  console.log("Generating E2E audio fixtures...\n");

  for (const fixture of REQUIRED_FIXTURES) {
    const fixturePath = getFixturePath(fixture.name);
    
    if (existsSync(fixturePath)) {
      console.log(`✓ ${fixture.name}.wav already exists, skipping`);
      continue;
    }

    console.log(`Generating ${fixture.name}.wav: "${fixture.text}"`);
    try {
      const result = await generatePcmAudioFixture(fixture.name, fixture.text);
      console.log(`  ✓ Created: ${result.path} (${result.durationMs}ms)\n`);
    } catch (error) {
      console.error(`  ✗ Failed: ${(error as Error).message}`);
      console.log("  Hint: Ensure ffmpeg is installed and TTS engine is available\n");
    }
  }

  console.log("Fixture generation complete.");
}

main().catch((error) => {
  console.error("Failed to generate fixtures:", error);
  process.exit(1);
});
