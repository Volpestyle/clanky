# Audio Fixtures

This directory contains pre-recorded or generated PCM audio files for E2E testing.

## Format Requirements

All fixtures must be:
- **Format**: Raw PCM (s16le)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)

## Generating Fixtures

Use TTS to generate fixtures:

```sh
ffmpeg -f tts -i "yo clanker" -ar 48000 -ac 1 -f s16le tests/fixtures/greeting_yo.pcm
```

Or use the built-in generator:

```ts
import { generatePcmAudioFixture } from "../tests/e2e/driver/audioGenerator.ts";

await generatePcmAudioFixture("greeting_yo", "yo clanker");
await generatePcmAudioFixture("direct_question", "clanker what is two plus two");
await generatePcmAudioFixture("undirected_chatter", "the build passed");
```

## Required Fixtures

| Name | Text | Purpose |
|------|------|---------|
| `greeting_yo.pcm` | "yo clanker" | Basic wake word test |
| `direct_question.pcm` | "clanker what is two plus two" | Direct question response |
| `undirected_chatter.pcm` | "the build passed" | Unaddressed speech ignore test |

## Git LFS

If fixtures become large, consider using Git LFS:

```sh
git lfs track "tests/fixtures/*.pcm"
```
