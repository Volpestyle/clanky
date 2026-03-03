# Voice Test Suites

Two complementary test harnesses validate voice behavior at different layers:

- **Golden Validation Suite** — tests the "brain" (LLM inference, prompt orchestration, admission decisions) with mocked Discord infrastructure
- **E2E Bot-to-Bot Suite** — tests the physical voice layer (gateway, audio transport, Opus encoding, DAVE encryption) with real Discord infrastructure

---

## Golden Validation Suite

Validates voice-chat behavior across all runtime modes with golden utterance cases, admission/response pass-fail scoring, LLM-as-judge evaluation, and performance timing metrics (p50/p95/avg).

### Modes Covered

- `stt_pipeline`
- `voice_agent` (xAI realtime)
- `openai_realtime`
- `gemini_realtime`
- `elevenlabs_realtime`

`stt_pipeline` cases allow model-directed `[[WEB_SEARCH:...]]` follow-ups when web search is enabled and a provider is configured (`BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`).

### Run Simulated (fast local loop)

```sh
bun run replay:voice-golden
# or
bun run test:voice-golden
# or (voice golden + text-mode web-search regression)
bun run test:golden
```

### Run Live APIs (real perf)

```sh
bun run replay:voice-golden:live
# or
bun run test:voice-golden:live
```

By default judge scoring is enabled in both simulated and live runs. Use `--no-judge` to disable it.

### CLI Flags

```sh
bun scripts/voiceGoldenHarness.ts \
  --mode live \
  --modes stt_pipeline,voice_agent,openai_realtime,gemini_realtime,elevenlabs_realtime \
  --iterations 1 \
  --judge-provider anthropic \
  --judge-model claude-haiku-4-5 \
  --decider-provider anthropic \
  --decider-model claude-haiku-4-5 \
  --actor-provider anthropic \
  --actor-model claude-sonnet-4-5 \
  --out-json data/voice-golden-report.json
```

Additional flags: `--judge`, `--allow-missing-credentials`, `--max-cases <n>`, `--no-judge`

### Live Test Env Vars

Used by `src/voice/voiceGoldenValidation.live.smoke.test.ts`:

- `RUN_LIVE_VOICE_GOLDEN=1`
- `LIVE_VOICE_GOLDEN_MODES`
- `LIVE_VOICE_GOLDEN_ITERATIONS`
- `LIVE_VOICE_GOLDEN_MAX_CASES`
- `LIVE_VOICE_GOLDEN_ALLOW_MISSING_CREDENTIALS`
- `LIVE_VOICE_GOLDEN_ACTOR_PROVIDER`, `LIVE_VOICE_GOLDEN_ACTOR_MODEL`
- `LIVE_VOICE_GOLDEN_DECIDER_PROVIDER`, `LIVE_VOICE_GOLDEN_DECIDER_MODEL`
- `LIVE_VOICE_GOLDEN_JUDGE_PROVIDER`, `LIVE_VOICE_GOLDEN_JUDGE_MODEL`
- `LIVE_VOICE_GOLDEN_NO_JUDGE=1`
- `LIVE_VOICE_GOLDEN_MIN_PASS_RATE`

### Credential Requirements

- Live mode requires credentials for the providers selected by `--actor-provider` and `--decider-provider`.
- Judge mode requires credentials for `--judge-provider`.
- With defaults (`anthropic` actor on `claude-sonnet-4-5`, `anthropic` decider/judge on `claude-haiku-4-5`), set `ANTHROPIC_API_KEY`.
- For web-search cases, set at least one search provider key: `BRAVE_SEARCH_API_KEY` and/or `SERPAPI_API_KEY`.

---

## E2E Bot-to-Bot Voice Validation

A **Driver Bot** acts as a test double:

1. Joins the same voice channel as the system bot
2. Injects pre-recorded audio fixtures (simulating user speech)
3. Records audio output from the system bot
4. Validates received audio and timing

This provides **full physical layer coverage** that golden tests cannot achieve.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Discord Gateway                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ┌────▼────┐        ┌────▼────┐        ┌────▼────┐
   │ Test    │        │ Voice   │        │ System  │
   │ Guild   │        │ Channel │        │ Bot     │
   └─────────┘        └─────────┘        │(clanker)│
                                         └────┬────┘
                                              │
         ┌────────────────────────────────────┼────────────────┐
         │                                    │                │
    ┌────▼────┐                          ┌────▼────┐      ┌────▼────┐
    │ Driver  │◄───── audio stream ──────│ rust_   │      │ LLM/STT │
    │ Bot     │      (Opus/encrypted)     │subprocess│    │ Pipeline │
    │ (Test)  │                          └─────────┘      └──────────┘
    └────┬────┘
         │
    ┌────▼────┐
    │ Test    │
    │ Harness │
    │ (Bun)   │
    └─────────┘
```

### Data Flow

1. **Setup**: Driver bot connects to Discord gateway and joins test voice channel
2. **Subscription**: Driver bot listens for system bot's audio stream
3. **Injection**: Driver bot plays pre-recorded PCM audio fixture
4. **Processing**: System bot receives audio → STT → LLM decision → LLM generation → TTS → audio out
5. **Capture**: Driver bot records audio bytes from system bot
6. **Assertion**: Test validates received audio meets expectations

## Infrastructure Requirements

### Discord Developer Portal Setup

#### 1. Driver Bot Application

Create a new bot application for testing:

1. Navigate to https://discord.com/developers/applications
2. Create New Application → name it "Clanker E2E Driver"
3. Navigate to Bot → Add Bot
4. Enable intents:
   - PRESENCE INTENT: No
   - MESSAGE CONTENT INTENT: **Yes**
   - SERVER MEMBERS INTENT: **Yes** (optional, for member state tests)
5. Reset Token → save as `E2E_DRIVER_BOT_TOKEN`

#### 2. Test Guild

Create a dedicated Discord server for testing:

1. In Discord client, create server: "Clanker E2E Test"
2. Enable Developer Mode: Settings → Advanced → Developer Mode
3. Right-click server → Copy ID → save as `E2E_TEST_GUILD_ID`

#### 3. Voice Channel

Create a voice channel in the test guild:

1. In test guild, create voice channel: "test-voice-1"
2. Right-click channel → Copy ID → save as `E2E_TEST_VOICE_CHANNEL_ID`

#### 4. Bot Invitations

Invite both bots with voice permissions:

```
https://discord.com/oauth2/authorize?client_id=<BOT_CLIENT_ID>&scope=bot&permissions=3148800
```

Required permissions:
- View Channels
- Connect
- Speak
- Use Voice Activity

### Environment Configuration

#### System Bot (Fallbacks)

The test harness reuses your existing system bot configuration:

```sh
# Already in .env
DISCORD_TOKEN=<your_main_bot_token>
CLIENT_ID=<your_main_bot_user_id>
```

#### E2E-Specific Variables

Only these need to be set explicitly:

```sh
# Required
E2E_DRIVER_BOT_TOKEN=<your_driver_bot_token>
E2E_TEST_GUILD_ID=123456789012345678
E2E_TEST_VOICE_CHANNEL_ID=123456789012345678

# Optional overrides (use if different from system bot defaults)
# E2E_SYSTEM_BOT_TOKEN=<override_token>  # defaults to DISCORD_TOKEN
# E2E_SYSTEM_BOT_USER_ID=<override_id>  # defaults to CLIENT_ID
# E2E_TEST_TEXT_CHANNEL_ID=123456789012345678  # for future text E2E tests
```

#### Complete Variable Reference

| Variable | Required | Fallback | Purpose |
|----------|----------|----------|--------|
| `E2E_SYSTEM_BOT_TOKEN` | No | `DISCORD_TOKEN` | System bot authentication |
| `E2E_SYSTEM_BOT_USER_ID` | No | `CLIENT_ID` | Identify system bot's audio stream |
| `E2E_DRIVER_BOT_TOKEN` | **Yes** | None | Driver bot authentication |
| `E2E_TEST_GUILD_ID` | **Yes** | None | Test guild/server ID |
| `E2E_TEST_VOICE_CHANNEL_ID` | **Yes** | None | Target voice channel |
| `E2E_TEST_TEXT_CHANNEL_ID` | No | `""` | Text channel for future tests |

## Test Implementation

### Directory Structure

```
tests/
├── e2e/
│   ├── driver/
│   │   ├── DriverBot.ts          # Test bot controller class
│   │   ├── audioGenerator.ts     # PCM fixture generation
│   │   ├── env.ts                # Environment configuration
│   │   └── index.ts              # Barrel exports
│   ├── scripts/
│   │   └── generate-fixtures.ts  # CLI to create audio fixtures
│   └── voicePhysicalHarness.test.ts  # Main test suite
└── fixtures/
    ├── greeting_yo.pcm          # "yo clanker" audio
    ├── direct_question.pcm      # "clanker what is two plus two"
    └── undirected_chatter.pcm   # "the build passed on main"
```

### DriverBot API

```typescript
class DriverBot {
  constructor(config: DriverBotConfig);

  // Lifecycle
  async connect(): Promise<void>;
  async joinVoiceChannel(): Promise<void>;
  async disconnect(): Promise<void>;
  async destroy(): Promise<void>;

  // Audio injection
  playAudio(audioPath: string): Promise<void>;

  // Audio capture
  getReceivedAudioBytes(): number;
  getReceivedAudioBuffer(): Buffer;
  clearReceivedAudio(): void;

  // Text channel
  async sendTextMessage(content: string): Promise<Message>;
  async waitForMessage(userId: string, timeoutMs?: number): Promise<Message>;
  async waitForNoMessage(userId: string, timeoutMs?: number): Promise<boolean>;

  // State
  client: Client;
  connection: VoiceConnection | null;
  player: AudioPlayer | null;
  readonly config: DriverBotConfig;
}
```

### Audio Fixture Requirements

All audio fixtures must be:

- **Format**: Raw PCM (signed 16-bit little-endian)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)
- **File Extension**: `.pcm`

#### Generation via macOS TTS

Requires macOS (`say` command). Generates AIFF via `say`, then converts to raw PCM via `ffmpeg`:

```sh
say -o /tmp/yo.aiff "yo clanker" && ffmpeg -y -i /tmp/yo.aiff -ar 48000 -ac 1 -f s16le tests/fixtures/greeting_yo.pcm
```

#### Generation via Script (recommended)

```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

#### Programmatic Generation

```typescript
import { generatePcmAudioFixture } from '../tests/e2e/driver/audioGenerator.ts';

await generatePcmAudioFixture('greeting_yo', 'yo clanker');
await generatePcmAudioFixture('direct_question', 'clanker what is two plus two');
```

## Test Cases

### 1. Voice Channel Join

**Test**: `E2E: Bot joins voice channel successfully`

**Validates**:
- Driver bot connects to Discord gateway
- Driver bot joins test voice channel
- Voice connection enters `ready` state

**Assertion**:
```typescript
assert.ok(driver.connection, "Driver should have voice connection");
assert.strictEqual(driver.connection.state.status, "ready", "Connection should be ready");
```

### 2. Greeting Response

**Test**: `E2E: Bot hears greeting and replies with audio`

**Validates**:
- System bot receives audio from driver bot
- STT pipeline processes greeting ("yo clanker")
- LLM generates appropriate acknowledgment
- TTS produces audio output
- System bot transmits audio to voice channel
- Driver bot receives audio bytes

**Assertion**:
```typescript
const receivedBytes = driver.getReceivedAudioBytes();
assert.ok(receivedBytes > 0, `Expected audio response, got ${receivedBytes} bytes`);
```

### 3. Direct Question Response

**Test**: `E2E: Bot responds to direct question`

**Validates**:
- Full pipeline for directed questions
- Substantive response (not just acknowledgment)

**Fixture**: "clanker what is two plus two"

**Assertion**: Audio bytes > 0 with longer expected duration than greeting

### 4. Undirected Chatter Suppression

**Test**: `E2E: Bot ignores undirected chatter`

**Validates**:
- Admission gate correctly rejects non-addressed speech
- System bot does not respond (or minimal response)

**Fixture**: "the build passed on main"

**Assertion**:
```typescript
const maxExpectedBytes = envNumber("E2E_MAX_CHATTER_RESPONSE_BYTES", 1024);
assert.ok(receivedBytes <= maxExpectedBytes, "Bot should ignore undirected chatter");
```

### 5. Text Message Response

**Test**: `E2E: Bot responds to text messages`

**Validates**: Bot receives and replies to a text message in the configured text channel.

**Gating**: Only runs when `E2E_TEST_TEXT_CHANNEL_ID` is set and `RUN_E2E_TEXT=1`.

### 6. Response Latency SLO

**Test**: `E2E: Response latency is within SLO`

**Validates**: Time from audio injection to first received audio chunk is under 8s.

### 7. Network Interruption Recovery

**Test**: `E2E: Bot handles network interruption gracefully`

**Validates**: Driver disconnects mid-stream, reconnects, sends new audio, and system bot still responds.

### 8. Smoke Test

**Test**: `smoke: E2E harness validates physical voice layer`

**Validates**: Complete E2E flow in a single test with optional LLM-as-judge quality scoring.

**Gating**: Only runs when `RUN_E2E_VOICE_PHYSICAL=1`

## Running Tests

### Generate Fixtures (First Time)

```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

### Run All E2E Tests

```sh
bun run test:e2e
```

### Run Single Test

```sh
RUN_E2E_VOICE_PHYSICAL=1 bun test tests/e2e/voicePhysicalHarness.test.ts
```

### Run via NPM Script

```sh
bun run test:e2e:voice
```

### Test Output

```
bun test v1.3.10

tests/e2e/voicePhysicalHarness.test.ts:
Skipping E2E tests: missing E2E environment variables

 8 pass
 0 fail
Ran 8 tests across 1 file. [229.00ms]
```

If E2E variables are configured:

```
tests/e2e/voicePhysicalHarness.test.ts:
✓ E2E: Bot joins voice channel successfully [1234ms]
✓ E2E: Bot hears greeting and replies with audio [8234ms]
✓ E2E: Bot responds to direct question [7123ms]
✓ E2E: Bot ignores undirected chatter [3012ms]
✓ E2E: Bot responds to text messages [5123ms]
✓ E2E: Response latency is within SLO [4521ms]
✓ E2E: Bot handles network interruption gracefully [15234ms]
✓ smoke: E2E harness validates physical voice layer [12345ms]

 8 pass
 0 fail
```

## Extending the Suite

### Adding New Test Cases

1. **Generate audio fixture** (macOS):

```sh
say -o /tmp/explain.aiff "clanker explain recursion" && ffmpeg -y -i /tmp/explain.aiff -ar 48000 -ac 1 -f s16le tests/fixtures/explain_recursion.pcm
```

Or programmatically: `await generatePcmAudioFixture("explain_recursion", "clanker explain recursion");`

2. **Add test case to suite**:

```typescript
test("E2E: Bot explains complex concept", async () => {
  if (!hasE2EConfig()) return;

  await driver.playAudio(getFixturePath("explain_recursion"));
  await new Promise(r => setTimeout(r, responseWaitMs));

  const bytes = driver.getReceivedAudioBytes();
  assert.ok(bytes > 2048, "Expected substantive response for complex question");
});
```

### Custom Assertions

For deeper validation beyond byte counting:

```typescript
// Capture raw audio
const audioBuffer = driver.getReceivedAudioBuffer();

// Transcribe it (reuse existing STT pipeline)
const transcript = await transcribeWithStt(audioBuffer);

// Judge quality (reuse existing judge infrastructure)
const pass = await runJsonJudge({
  llm,
  settings: judgeSettings,
  systemPrompt: "Score response quality...",
  userPrompt: `Transcript: ${transcript}\nExpected: ...`
});
```

### Testing Error Scenarios

```typescript
test("E2E: Bot handles network interruption gracefully", async () => {
  // Force disconnect mid-stream
  await driver.playAudio(getFixturePath("long_question"));
  await new Promise(r => setTimeout(r, 500));
  await driver.disconnect();
  
  // Reconnect and verify system bot state
  await driver.joinVoiceChannel();
  // ... assertions
});
```

## Troubleshooting

### "Skipping E2E tests: missing E2E environment variables"

**Cause**: Required E2E env vars not set

**Fix**: Ensure `.env` contains:
```sh
E2E_DRIVER_BOT_TOKEN=...
E2E_TEST_GUILD_ID=...
E2E_TEST_VOICE_CHANNEL_ID=...
```

### "Timeout waiting for event: ready"

**Causes**:
- Bot tokens invalid or expired
- Bot lacks permissions for voice channel
- Network connectivity to Discord gateway blocked

**Fix**:
1. Verify tokens: `curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v9/users/@me`
2. Check bot has View Channels, Connect, Speak permissions
3. Verify network allows HTTPS/WSS to Discord

### "Fixture not found at tests/fixtures/greeting_yo.pcm"

**Cause**: Audio fixtures not generated

**Fix**:
```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

Or manually (macOS):
```sh
say -o /tmp/yo.aiff "yo clanker" && ffmpeg -y -i /tmp/yo.aiff -ar 48000 -ac 1 -f s16le tests/fixtures/greeting_yo.pcm
```

### "Expected system bot to send audio back, got 0 bytes"

**Causes**:
- System bot not running
- System bot voice mode disabled in settings
- System bot not configured for test guild
- Response wait too short

**Fix**:
1. Start system bot: `bun run start`
2. Ensure voice mode enabled in dashboard settings
3. Verify system bot is in test guild
4. Increase wait: `E2E_RESPONSE_WAIT_MS=20000 bun run test:e2e:voice`

### "say not available" or fixture generation fails

**Cause**: Fixture generation uses macOS `say` for TTS synthesis. Not available on Linux/Windows.

**Fix**:
- On macOS: `say` is built-in, ensure `ffmpeg` is installed (`brew install ffmpeg`)
- On Linux/CI: Pre-generate fixtures on macOS and commit them, or provide pre-recorded PCM files

## CI Integration

### GitHub Actions

```yaml
name: E2E Tests

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  e2e:
    runs-on: macos-latest  # Required: fixture generation uses macOS `say` for TTS
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1

      - run: bun install

      - run: bun tests/e2e/scripts/generate-fixtures.ts

      - name: Run E2E Tests
        env:
          DISCORD_TOKEN: ${{ secrets.DISCORD_TOKEN }}
          CLIENT_ID: ${{ secrets.CLIENT_ID }}
          E2E_DRIVER_BOT_TOKEN: ${{ secrets.E2E_DRIVER_BOT_TOKEN }}
          E2E_TEST_GUILD_ID: ${{ secrets.E2E_TEST_GUILD_ID }}
          E2E_TEST_VOICE_CHANNEL_ID: ${{ secrets.E2E_TEST_VOICE_CHANNEL_ID }}
        run: bun run test:e2e
```

Alternatively, pre-generate and commit fixtures to `tests/fixtures/` to allow `ubuntu-latest` runners.

### Timing and Cost Considerations

**Cost Factors**:
- Discord API (rate limits: gateway connect, voice state updates)
- LLM inference (if system bot calls LLM)
- STT/TTS costs (realtime or pipeline mode)

**Recommendations**:
- Run on `main` branch merges, not every PR
- Use `stt_pipeline` mode for cheaper tests (no realtime API)
- Limit iterations via test case design
- Parallelize across separate voice channels if needed

**Expected Duration**:
- Channel join: ~2s
- Audio injection: ~2s
- Processing pipeline: ~5-10s
- Total per test: ~10-15s

## Comparison: Golden vs E2E

| Aspect | Golden Harness | E2E Harness |
|--------|----------------|-------------|
| **Scope** | LLM brain logic | Physical voice layer |
| **Coverage** | Decision, prompts, instruction following | Connection, audio transport, encoding |
| **Infrastructure** | Mocked Discord client | Real Discord gateway |
| **Cost** | LLM inference only | LLM + STT + TTS + API calls |
| **Speed** | Fast (0.5-2s per case) | Slow (10-15s per test) |
| **CI Strategy** | Every PR | Main branch merges |
| **Mock Depth** | Voice manager, client, connection | None (real infrastructure) |
| **Debugging** | Log inspection, prompt diff | Network traces, Discord dev tools |

Both are **complementary**:
- Golden tests catch logic bugs early
- E2E tests catch integration/transport bugs before production

## Future Extensions

### Voice State Validation

Test that the system bot persists in the channel when users leave:

```typescript
test("E2E: Bot correctly handles user join/leave", async () => {
  await driver.joinVoiceChannel();
  await driver.disconnect();
  await new Promise(r => setTimeout(r, 2000));

  const botState = await getBotVoiceState(guild, systemBotUserId);
  assert.ok(botState?.channelId === voiceChannelId);
});
```

### Multi-User Scenarios

Requires a second driver bot token to test speaker discrimination (Discord assigns SSRCs server-side, so a single bot cannot impersonate multiple users):

```typescript
test("E2E: Bot distinguishes between multiple speakers", async () => {
  const driver2 = new DriverBot({ ...config, token: secondDriverToken });
  await driver2.connect();
  await driver2.joinVoiceChannel();

  await driver.playAudio(getFixturePath("question_from_alice"));
  await driver2.playAudio(getFixturePath("question_from_bob"));
  // Assert bot correctly attributes speech to each user
});
```

## References

- **Implementation**: `tests/e2e/driver/DriverBot.ts`
- **Voice Test Suite**: `tests/e2e/voicePhysicalHarness.test.ts`
- **Text Test Suite**: `tests/e2e/textHarness.test.ts`
- **Audio Generation**: `tests/e2e/driver/audioGenerator.ts`
- **Environment Config**: `tests/e2e/driver/env.ts`
- **Discord.js Voice Guide**: https://discordjs.guide/voice/
- **@discordjs/voice Docs**: https://discord.js.org/#/docs/voice/main/general/welcome
