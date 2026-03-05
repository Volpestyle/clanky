# Voice Test Suites

Two complementary test harnesses validate voice behavior at different layers:

- **Golden Validation Suite** — tests the "brain" (LLM inference, prompt orchestration, admission decisions) with mocked Discord infrastructure
- **E2E Bot-to-Bot Suite** — tests the physical voice layer (gateway, audio transport, Opus encoding, DAVE encryption) with real Discord infrastructure

---

## Golden Validation Suite

Validates voice-chat behavior across all runtime modes with golden utterance cases, admission/response pass-fail scoring, LLM-as-judge evaluation, and performance timing metrics (p50/p95/avg).

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
    │ Bot A/B │      (Opus/encrypted)     │subprocess│    │ Pipeline │
    │ (Test)  │                          └─────────┘      └──────────┘
    └────┬────┘
         │
    ┌────▼────┐
    │ Test    │──── polls ────▶ Dashboard API
    │ Harness │                /api/voice/recent-transcripts
    │ (Bun)   │
    └─────────┘
```

### Data Flow

1. **Setup**: Driver bot(s) connect to Discord gateway and join test voice channel
2. **Subscription**: Driver bots listen for system bot's audio stream
3. **Injection**: Driver bot plays pre-recorded PCM audio fixture
4. **Processing**: System bot receives audio → STT → LLM decision → LLM generation → TTS → audio out
5. **Capture**: Driver bot records audio bytes from system bot
6. **Assertion**: Test validates received audio meets expectations
7. **Transcript verification** (optional): Test polls dashboard API for TTS transcript events to disambiguate from music audio

## Infrastructure Requirements

### Discord Developer Portal Setup

#### 1. Driver Bot Application (Primary)

Create a new bot application for testing:

1. Navigate to https://discord.com/developers/applications
2. Create New Application → name it "Clanker E2E Driver"
3. Navigate to Bot → Add Bot
4. Enable intents:
   - PRESENCE INTENT: No
   - MESSAGE CONTENT INTENT: **Yes**
   - SERVER MEMBERS INTENT: No
   - GUILD VOICE STATES INTENT: **Yes**
5. Reset Token → save as `E2E_DRIVER_BOT_TOKEN`

#### 2. Driver Bot 2 Application (Multi-User Tests)

Required for chatter resilience and disambiguation tests that need two simultaneous users:

1. Create another Application → name it "Clanker E2E Driver 2"
2. Enable the same intents as Driver Bot 1
3. Reset Token → save as `E2E_DRIVER_BOT_2_TOKEN`

**Note**: Both driver bots run in the same Bun process. Each `DriverBot` instance uses a unique `group` ID when calling `joinVoiceChannel()` to avoid `@discordjs/voice` connection map collisions (the library keys connections by guild ID globally).

#### 3. Test Guild

Create a dedicated Discord server for testing:

1. In Discord client, create server: "Clanker E2E Test"
2. Enable Developer Mode: Settings → Advanced → Developer Mode
3. Right-click server → Copy ID → save as `E2E_TEST_GUILD_ID`

#### 4. Voice Channel

Create a voice channel in the test guild:

1. In test guild, create voice channel: "test-voice-1"
2. Right-click channel → Copy ID → save as `E2E_TEST_VOICE_CHANNEL_ID`

#### 5. Text Channel (Optional)

Create a text channel for text-based interactions (stop music, summon bot):

1. In test guild, create text channel: "test-text-1"
2. Right-click channel → Copy ID → save as `E2E_TEST_TEXT_CHANNEL_ID`

#### 6. Bot Invitations

Invite all bots with voice + text permissions:

```
https://discord.com/oauth2/authorize?client_id=<BOT_CLIENT_ID>&scope=bot&permissions=3148800
```

Required permissions:
- View Channels
- Connect
- Speak
- Use Voice Activity
- Send Messages (for text channel interactions)

### Environment Configuration

#### System Bot (Fallbacks)

The test harness reuses your existing system bot configuration:

```sh
# Already in .env
DISCORD_TOKEN=<your_main_bot_token>
CLIENT_ID=<your_main_bot_user_id>
```

#### E2E-Specific Variables

```sh
# Required
E2E_DRIVER_BOT_TOKEN=<your_driver_bot_token>
E2E_TEST_GUILD_ID=123456789012345678
E2E_TEST_VOICE_CHANNEL_ID=123456789012345678

# Required for multi-user tests (chatter resilience, disambiguation)
E2E_DRIVER_BOT_2_TOKEN=<your_second_driver_bot_token>

# Optional
E2E_TEST_TEXT_CHANNEL_ID=123456789012345678

# Dashboard connection (for eagerness control)
DASHBOARD_HOST=127.0.0.1       # defaults to 127.0.0.1
DASHBOARD_PORT=8787             # defaults to 8787
DASHBOARD_TOKEN=<if_auth_enabled>
```

#### Complete Variable Reference

| Variable | Required | Fallback | Purpose |
|----------|----------|----------|---------|
| `E2E_SYSTEM_BOT_TOKEN` | No | `DISCORD_TOKEN` | System bot authentication |
| `E2E_SYSTEM_BOT_USER_ID` | No | `CLIENT_ID` | Identify system bot's audio stream |
| `E2E_DRIVER_BOT_TOKEN` | **Yes** | None | Primary driver bot authentication |
| `E2E_DRIVER_BOT_2_TOKEN` | No | None | Second driver bot for multi-user tests |
| `E2E_TEST_GUILD_ID` | **Yes** | None | Test guild/server ID |
| `E2E_TEST_VOICE_CHANNEL_ID` | **Yes** | None | Target voice channel |
| `E2E_TEST_TEXT_CHANNEL_ID` | No | `""` | Text channel for stop commands, summon |
| `DASHBOARD_HOST` | No | `127.0.0.1` | Dashboard API host |
| `DASHBOARD_PORT` | No | `8787` | Dashboard API port |
| `DASHBOARD_TOKEN` | No | `""` | Dashboard auth token |

#### Test-Specific Env Vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN_E2E_VOICE_PHYSICAL` | `0` | Gate for physical voice harness tests |
| `RUN_E2E_TEXT` | `0` | Gate for text harness tests |
| `RUN_E2E_MUSIC` | `0` | Gate for music play-now tests |
| `RUN_E2E_CROWDED` | `0` | Gate for crowded channel multi-participant tests |
| `E2E_MUSIC_ACK_MAX_MS` | `8000` | Max allowed ack latency for music requests |
| `E2E_MUSIC_DOWNLOAD_WAIT_MS` | `30000` | How long to wait for yt-dlp download |
| `E2E_RESPONSE_WAIT_MS` | `12000` | General response wait timeout |

## Test Implementation

### Directory Structure

```
tests/
├── e2e/
│   ├── driver/
│   │   ├── DriverBot.ts          # Test bot controller class
│   │   ├── audioGenerator.ts     # PCM fixture generation (macOS say + ffmpeg)
│   │   ├── dashboard.ts          # Dashboard API helpers (eagerness control, health check)
│   │   ├── env.ts                # Environment configuration + guards
│   │   └── index.ts              # Barrel exports
│   ├── scripts/
│   │   └── generate-fixtures.ts  # CLI to create audio fixtures
│   ├── voicePhysicalHarness.test.ts  # Physical voice layer tests
│   ├── voiceDialogue.test.ts         # Multi-turn dialogue tests
│   ├── voiceMusicPlayNow.test.ts     # Non-blocking music play tests
│   ├── voiceCrowdedChannel.test.ts   # Multi-participant crowded channel tests
│   └── textHarness.test.ts           # Text channel tests
└── fixtures/
    ├── greeting_yo.wav               # "yo clanker"
    ├── direct_question.wav           # "clanker what is two plus two"
    ├── music_play_request.wav        # "Hey clanker, play Bad and Boujee by Migos"
    ├── music_disambig_vague.wav      # "Hey clanker, play Roses"
    └── ...                           # Auto-generated on first test run
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
  waitForAudioResponse(timeoutMs?: number, pollMs?: number): Promise<boolean>;

  // System bot interaction
  summonSystemBot(timeoutMs?: number): Promise<void>;
  isSystemBotInVoice(): boolean;
  waitForBotLeave(timeoutMs?: number, pollMs?: number): Promise<boolean>;

  // Text channel
  async sendTextMessage(content: string): Promise<Message>;
  async waitForMessage(userId: string, timeoutMs?: number): Promise<Message>;
  async waitForNoMessage(userId: string, timeoutMs?: number): Promise<boolean>;
  async waitForReaction(userId: string, timeoutMs?: number): Promise<{ emoji: string; userId: string }>;

  // State
  client: Client;
  connection: VoiceConnection | null;
  player: AudioPlayer | null;
  readonly config: DriverBotConfig;
}
```

### Dashboard Helpers

```typescript
// Set voice eagerness for test duration, snapshot current settings for restore
async function beginTemporaryE2EEagerness(voiceEagerness: number, textEagerness?: number): Promise<void>;
async function beginTemporaryE2EEagerness50(): Promise<void>;  // convenience wrapper
async function restoreTemporaryE2ESettings(): Promise<void>;   // restores snapshot
async function waitForDashboardReady(timeoutMs?: number): Promise<void>;
```

### Audio Fixture Requirements

All audio fixtures must be:

- **Format**: WAV (signed 16-bit little-endian PCM)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)
- **File Extension**: `.wav`

#### Generation via macOS TTS

Requires macOS (`say` command). Generates AIFF via `say`, then converts to WAV via `ffmpeg`:

```sh
say -o /tmp/yo.aiff "yo clanker" && ffmpeg -y -i /tmp/yo.aiff -ar 48000 -ac 1 tests/fixtures/greeting_yo.wav
```

#### Generation via Script (recommended)

```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

#### Programmatic Generation (auto on first run)

```typescript
import { generatePcmAudioFixture } from '../tests/e2e/driver/audioGenerator.ts';

await generatePcmAudioFixture('greeting_yo', 'yo clanker');
await generatePcmAudioFixture('music_play_request', 'Hey clanker, play Bad and Boujee by Migos');
```

Tests use `ensureFixture()` to auto-generate missing fixtures on first run.

## Test Suites

### Physical Voice Harness (`voicePhysicalHarness.test.ts`)

Gate: `RUN_E2E_VOICE_PHYSICAL=1`

| Test | Validates |
|------|-----------|
| Bot joins voice channel | Gateway connection, voice ready state |
| Bot hears greeting and replies | Full STT → LLM → TTS pipeline |
| Bot responds to direct question | Substantive response generation |
| Bot ignores undirected chatter | Admission gate rejection |
| Response latency is within SLO | End-to-end under 8s |

### Music Play-Now (`voiceMusicPlayNow.test.ts`)

Gate: `RUN_E2E_MUSIC=1`

Tests the non-blocking `music_play_now` tool implementation where the tool returns `{ status: "loading" }` immediately instead of blocking ~17s for yt-dlp download.

| Test | Validates | Requires |
|------|-----------|----------|
| Full lifecycle — fast ack, now-playing notification | Non-blocking ack within 8s, "now playing" injected prompt after download | Driver A |
| Double queue backtrack — second request replaces first | Back-to-back requests: second song replaces first, download completes | Driver A |
| Disambiguation with background chatter | Vague request → disambiguation → chatter overlaps → selection → download completes | Drivers A + B |

#### Chatter timing

Chatter fixtures fire **immediately** (500ms) after the music request or disambiguation response — during the tool-calling window — to test that the bot doesn't get sidetracked while processing. Gaps between chatter lines are 800ms to simulate rapid conversation.

### Crowded Channel (`voiceCrowdedChannel.test.ts`)

Gate: `RUN_E2E_CROWDED=1`

Simulates a multi-participant voice channel with overlapping speech, low-signal ASR hallucinations, and interleaved music requests. Validates that the bot correctly ignores garbage, handles rapid-fire direct addresses, and completes music requests despite chatter interference.

| Test | Validates | Requires |
|------|-----------|----------|
| Bot ignores rapid low-signal garbage from multiple speakers | brain_decides low-signal gate, deferred queue filtering | Drivers A + B |
| Direct address works after garbage storm | ASR buffer race, response.create race | Drivers A + B |
| Rapid back-to-back direct addresses from two speakers | response.create TOCTOU race handling | Drivers A + B |
| Music request succeeds despite overlapping chatter | Music deferral priority, stale coalescing filter | Drivers A + B |
| Garbage storm during bot response — bot stays healthy | ASR race, deferred queue with garbage, connection health | Drivers A + B |

### Dialogue Tests (`voiceDialogue.test.ts`)

Gate: `RUN_E2E_VOICE_PHYSICAL=1`

Multi-turn conversation tests with admission decisions.

### Text Harness (`textHarness.test.ts`)

Gate: `RUN_E2E_TEXT=1`

Text channel message response tests.

## Disambiguating TTS from Music Audio

### The Problem

When music is playing, the system bot sends both TTS voice responses and music audio through the same Discord audio stream. `waitForAudioResponse()` (which checks `getReceivedAudioBytes() > 0`) cannot distinguish between them — it will return immediately with music bytes, not a TTS response.

This makes it impossible to reliably test "does the bot respond to a voice question while music is playing?" using byte counting alone.

### Solution: Dashboard Transcript API

Expose recent voice transcripts via a dashboard API endpoint. The voice session manager already emits `openai_realtime_transcript` events with `transcriptSource=output` for TTS and `transcriptSource=input` for user speech.

#### Planned Endpoint

```
GET /api/voice/recent-transcripts?since=<epoch_ms>
```

**Response:**
```json
[
  {
    "timestamp": 1709600323000,
    "transcript": "Sicko Mode's loading up—get ready for that switch up!",
    "source": "output",
    "sessionId": "e6bf2059-..."
  },
  {
    "timestamp": 1709600320000,
    "transcript": "Hey Clanker, play Sicko Mode by Travis Scott",
    "source": "input",
    "speaker": "oathkeeper",
    "sessionId": "e6bf2059-..."
  }
]
```

#### Implementation Plan

1. **Ring buffer in VoiceSessionManager**: Store the last ~50 transcript events (both input and output) with timestamps
2. **Dashboard route**: `GET /api/voice/recent-transcripts` reads from the buffer, filters by `since` param
3. **Test helper on DriverBot or dashboard.ts**: `waitForTranscript(since, source, timeoutMs)` polls the endpoint

#### Test Usage

```typescript
// Record timestamp before playing fixture
const before = Date.now();

// Play the followup question
await driver.playAudio(followupFixture);

// Poll for a TTS output transcript (not music bytes)
const transcript = await waitForOutputTranscript(before, 15_000);
assert.ok(transcript, "Bot should respond to followup with TTS while music plays");
console.log(`[Lifecycle] Bot said: "${transcript.transcript}"`);
```

This provides **zero-ambiguity TTS detection** — the transcript event only fires for voice responses, never for music playback.

## Running Tests

### Generate Fixtures (First Time)

```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

### Run All E2E Tests

```sh
bun run test:e2e
```

### Run Single Suite

```sh
RUN_E2E_VOICE_PHYSICAL=1 bun test tests/e2e/voicePhysicalHarness.test.ts
RUN_E2E_MUSIC=1 bun test tests/e2e/voiceMusicPlayNow.test.ts
RUN_E2E_CROWDED=1 bun test tests/e2e/voiceCrowdedChannel.test.ts
RUN_E2E_TEXT=1 bun test tests/e2e/textHarness.test.ts
```

### Run via NPM Script

```sh
bun run test:e2e:voice
```

## Extending the Suite

### Adding New Test Cases

1. **Generate audio fixture** (macOS):

```sh
say -o /tmp/explain.aiff "clanker explain recursion" && ffmpeg -y -i /tmp/explain.aiff -ar 48000 -ac 1 tests/fixtures/explain_recursion.wav
```

Or programmatically: `await generatePcmAudioFixture("explain_recursion", "clanker explain recursion");`

2. **Add test case to suite**:

```typescript
test("E2E: Bot explains complex concept", async () => {
  if (!hasE2EConfig()) return;

  await driver.playAudio(getFixturePath("explain_recursion"));
  const gotResponse = await driver.waitForAudioResponse(responseWaitMs);

  assert.ok(gotResponse, "Expected audio response for complex question");
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
- Missing GUILD VOICE STATES intent in Discord developer portal

**Fix**:
1. Verify tokens: `curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v9/users/@me`
2. Check bot has View Channels, Connect, Speak permissions
3. Verify intents: MESSAGE CONTENT + GUILD VOICE STATES must be enabled
4. Verify network allows HTTPS/WSS to Discord

### "Dashboard did not become ready within 30000ms"

**Cause**: System bot not running or dashboard not accessible

**Fix**:
1. Start system bot: `bun start`
2. Verify dashboard: `curl http://127.0.0.1:8787/api/health`
3. Check `DASHBOARD_HOST` and `DASHBOARD_PORT` match the running instance

### Connection collision with multiple driver bots

**Cause**: `@discordjs/voice` uses a global connection map keyed by guild ID. Two `DriverBot` instances calling `joinVoiceChannel()` for the same guild return the same connection.

**Fix**: Each `DriverBot` instance uses a unique `group` parameter (auto-assigned via counter). No action needed — this is handled automatically.

### "Fixture not found"

**Cause**: Audio fixtures not generated

**Fix**:
```sh
bun tests/e2e/scripts/generate-fixtures.ts
```

Or run the test — fixtures are auto-generated on first run via `ensureFixture()`.

### Music tests: `waitForAudioResponse` returns immediately

**Cause**: When music is playing, audio bytes are streaming constantly. `waitForAudioResponse()` counts ALL audio (TTS + music) and returns immediately.

**Fix**: Use the transcript API (see "Disambiguating TTS from Music Audio" section) to detect actual TTS responses instead of byte counting.

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
          E2E_DRIVER_BOT_2_TOKEN: ${{ secrets.E2E_DRIVER_BOT_2_TOKEN }}
          E2E_TEST_GUILD_ID: ${{ secrets.E2E_TEST_GUILD_ID }}
          E2E_TEST_VOICE_CHANNEL_ID: ${{ secrets.E2E_TEST_VOICE_CHANNEL_ID }}
          E2E_TEST_TEXT_CHANNEL_ID: ${{ secrets.E2E_TEST_TEXT_CHANNEL_ID }}
          RUN_E2E_VOICE_PHYSICAL: "1"
          RUN_E2E_MUSIC: "1"
        run: bun run test:e2e
```

Alternatively, pre-generate and commit fixtures to `tests/fixtures/` to allow `ubuntu-latest` runners.

### Timing and Cost Considerations

**Cost Factors**:
- Discord API (rate limits: gateway connect, voice state updates)
- LLM inference (if system bot calls LLM)
- STT/TTS costs (realtime or pipeline mode)
- yt-dlp downloads (music tests)

**Recommendations**:
- Run on `main` branch merges, not every PR
- Music tests are slow (~2-3 min per test with 30s download waits)
- Parallelize across separate voice channels if needed

**Expected Duration**:
- Physical harness: ~60-90s total
- Music play-now: ~5-8 min total (3 tests with download waits)
- Dialogue: ~30-60s total

## Comparison: Golden vs E2E

| Aspect | Golden Harness | E2E Harness |
|--------|----------------|-------------|
| **Scope** | LLM brain logic | Physical voice layer |
| **Coverage** | Decision, prompts, instruction following | Connection, audio transport, encoding, music flow |
| **Infrastructure** | Mocked Discord client | Real Discord gateway |
| **Cost** | LLM inference only | LLM + STT + TTS + API calls |
| **Speed** | Fast (0.5-2s per case) | Slow (10-60s per test) |
| **CI Strategy** | Every PR | Main branch merges |
| **Mock Depth** | Voice manager, client, connection | None (real infrastructure) |
| **Multi-user** | N/A | Yes (Driver Bot A + B) |

Both are **complementary**:
- Golden tests catch logic bugs early
- E2E tests catch integration/transport bugs before production

## References

- **Implementation**: `tests/e2e/driver/DriverBot.ts`
- **Physical Voice Suite**: `tests/e2e/voicePhysicalHarness.test.ts`
- **Music Play-Now Suite**: `tests/e2e/voiceMusicPlayNow.test.ts`
- **Crowded Channel Suite**: `tests/e2e/voiceCrowdedChannel.test.ts`
- **Dialogue Suite**: `tests/e2e/voiceDialogue.test.ts`
- **Text Suite**: `tests/e2e/textHarness.test.ts`
- **Dashboard Helpers**: `tests/e2e/driver/dashboard.ts`
- **Audio Generation**: `tests/e2e/driver/audioGenerator.ts`
- **Environment Config**: `tests/e2e/driver/env.ts`
- **Discord.js Voice Guide**: https://discordjs.guide/voice/
- **@discordjs/voice Docs**: https://discord.js.org/#/docs/voice/main/general/welcome
