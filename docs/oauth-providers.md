# OAuth Providers

Two OAuth-backed auth lanes let clanker conk use subscription-backed providers instead of standard API keys for its general-purpose orchestrator and voice paths.

| Provider | Upstream | Auth Target | Token Storage | Transport |
|---|---|---|---|---|
| `claude-oauth` | Anthropic Messages API | `claude.ai/oauth/authorize` | `data/claude-oauth-tokens.json` | Standard Anthropic SDK with custom fetch |
| OpenAI OAuth (`openai-oauth`) | OpenAI / ChatGPT-authenticated Codex lane | `auth.openai.com` | `data/openai-oauth-tokens.json` | Reverse-engineered ChatGPT Codex backend |

---

## Claude OAuth (`claude-oauth`)

### Overview

The `claude-oauth` provider authenticates against the Anthropic Messages API using OAuth tokens from a Claude Pro/Max subscription, instead of a paid API key. This gives access to Claude models at zero marginal cost (covered by the subscription).

The OAuth provider calls the API directly via `@anthropic-ai/sdk` with a custom fetch wrapper.

### Authentication Flow

1. **One-time login**: OAuth 2.0 PKCE flow against `claude.ai/oauth/authorize`
2. **Token storage**: Refresh + access tokens stored in `data/claude-oauth-tokens.json`
3. **Per-request**: Access token auto-refreshed when expired, sent as `Authorization: Bearer <token>`

### API Compatibility Layer

The OAuth endpoint requires requests to look like they come from the Claude CLI. The custom fetch wrapper handles:

- `Authorization: Bearer <access_token>` instead of `x-api-key`
- `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14` header
- `user-agent: claude-cli/2.1.2 (external, cli)` spoofing
- Tool name prefixing: `prefixToolNames()` / `stripToolPrefix()` plumbing exists but is currently disabled (`TOOL_PREFIX = ""`)
- `?beta=true` query param appended to `/v1/messages`

### Token Lifecycle

```
[refresh_token] --POST /v1/oauth/token--> [access_token + new refresh_token]
                                            |
                                            v
                                   stored in data/claude-oauth-tokens.json
                                   access_token used for API calls
                                   auto-refreshed when expires < Date.now()
```

### Setup

**Option 1: Environment Variable (quickstart)**

Set `CLAUDE_OAUTH_REFRESH_TOKEN` in your `.env`. You can obtain a refresh token by:

1. Visit the authorize URL (logged at startup when token is set)
2. Authorize and copy the code
3. Exchange via the token endpoint

**Option 2: Manual Token File**

Create `data/claude-oauth-tokens.json`:

```json
{
  "refreshToken": "<your-refresh-token>",
  "accessToken": "",
  "expiresAt": 0
}
```

The access token will be auto-populated on first use.

### Configuration

```env
DEFAULT_PROVIDER=claude-oauth
CLAUDE_OAUTH_REFRESH_TOKEN=your-refresh-token-here
```

In settings, use `provider: "claude-oauth"` with standard Anthropic model IDs:

```json
{
  "provider": "claude-oauth",
  "model": "claude-sonnet-4-6"
}
```

### Architecture

```
LLMService
  └── claude-oauth provider
        └── Anthropic SDK (same as `anthropic` provider)
              └── custom fetch wrapper (claudeOAuth.ts)
                    ├── token refresh (console.anthropic.com/v1/oauth/token)
                    ├── Bearer auth header
                    ├── beta headers + user-agent
                    ├── tool name prefix plumbing (currently disabled)
                    └── ?beta=true query param
```

The provider reuses the exact same `callAnthropic` code path as the regular `anthropic` provider. The only difference is the Anthropic SDK client is configured with a custom fetch that handles OAuth auth.

### Prompt Caching

The shared Anthropic request path now emits SDK-typed prompt-caching breakpoints for both the API-key `anthropic` lane and the subscription-backed `claude-oauth` lane.

- Stable system prompt text is sent as a cacheable Anthropic text block, so persona, long-form behavior instructions, and tool definitions can be reused instead of re-prefilled every turn.
- Anthropic tool-loop follow-ups mark the newest `tool_result` block as cacheable, so immediate continuation calls can reuse large fetched context such as search or article results.
- The shared Anthropic request path retries one transient overload/rate-limit/network failure before surfacing an error. Streaming retries only happen before any text delta has been emitted, so live voice output does not duplicate partial speech.

This is prompt-prefix reuse, not hidden server-side conversation memory. The Messages API remains stateless and still only knows the context the app resends on each call.

### Structured Output Handling

JSON compliance for reply generation is requested via a text instruction appended to the system prompt (`"Return strict JSON only."` + the schema). API-level enforcement via `output_config.format` is not used because `REPLY_OUTPUT_SCHEMA` exceeds Claude's union type limit (29 `type: ["string", "null"]` / `anyOf` parameters).

When the model returns plain prose instead of JSON (e.g. short simple requests like "call me X"), the reply pipeline recovers the raw text as the reply content (`structured_output_recovered_as_prose` warning) instead of silently dropping it. Only truly empty model output is skipped.

### Reverse-Engineered From

Based on the `opencode-anthropic-auth` plugin (npm `opencode-anthropic-auth@0.0.13`), which implements the same OAuth flow used by the Claude Code CLI. Key constants:

- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **OAuth authorize**: `https://claude.ai/oauth/authorize`
- **Token endpoint**: `https://console.anthropic.com/v1/oauth/token`
- **Redirect URI**: `https://console.anthropic.com/oauth/code/callback`
- **Scopes**: `org:create_api_key user:profile user:inference`

---

## OpenAI OAuth (`openai-oauth`)

### Overview

OpenAI OAuth is the product-level auth lane for ChatGPT-backed OpenAI usage in this repo. The canonical provider key is `openai-oauth`.

Use it for the general-purpose OpenAI orchestrator, voice admission, and voice generation paths. It is not itself the coding worker. The local OpenAI-side coding worker is `codex-cli`; remote `codex` remains an optional separate worker.

When the `openai_oauth` preset is used, the expected split is:

- general brain/orchestrator work runs on OpenAI OAuth (`openai-oauth`)
- implementation defaults to the local `codex-cli` worker
- `claude-code` can still be used as an optional local coding worker

This provider is experimental. The authentication model is grounded in the official OpenAI docs, but the transport described below is reverse-engineered from current ChatGPT behavior and from `../opencode`; it is not part of the public OpenAI API contract.

### What OpenAI Documents

- Codex supports ChatGPT sign-in and API-key sign-in
- ChatGPT sign-in opens a browser login flow by default, and active sessions refresh tokens automatically
- ChatGPT-authenticated Codex usage follows plan limits and credits instead of standard API-key billing

### Authentication Flow

1. Current implementation performs a PKCE login against `https://auth.openai.com`.
2. Tokens are stored in `data/openai-oauth-tokens.json`
3. Access tokens are refreshed automatically from the stored refresh token
4. Requests are sent with bearer auth plus the ChatGPT account id when available

Dashboard auth indicators treat `OPENAI_OAUTH_REFRESH_TOKEN` and `data/openai-oauth-tokens.json` equivalently, so file-backed logins show as authenticated even when no env var is set.

### Transport Layer (Reverse-Engineered)

The custom fetch wrapper rewrites OpenAI Responses API requests onto a ChatGPT backend path that OpenAI does not document as a public API surface:

- `/v1/responses` -> `https://chatgpt.com/backend-api/codex/responses`
- `Authorization: Bearer <access_token>`
- `ChatGPT-Account-Id: <account_id>`
- `originator: clanker_conk`

### Setup

**One-time login:**

```sh
bun scripts/openai-oauth-login.ts
```

This starts a local callback server, opens the browser login flow, then writes tokens to `data/openai-oauth-tokens.json`.

**Environment bootstrap:**

```env
OPENAI_OAUTH_REFRESH_TOKEN=your-refresh-token
DEFAULT_PROVIDER=openai-oauth
DEFAULT_MODEL_OPENAI_OAUTH=gpt-5.4
```

### Usage

Use the canonical provider id `provider: "openai-oauth"` in settings with a supported model such as:

```json
{
  "provider": "openai-oauth",
  "model": "gpt-5.4"
}
```

For dev-team code-agent tasks:

- `codex-cli` is the local workspace-aware OpenAI coding worker and uses the local Codex CLI login/session on that machine
- remote `codex` will prefer `OPENAI_API_KEY` when present and otherwise fall back to the `openai-oauth` client

### Pricing

The local pricing table records `openai-oauth` usage as zero USD for app bookkeeping.

In product terms, treat this as ChatGPT-authenticated usage subject to ChatGPT plan limits and credits, not standard API-key billing. It is not an OpenAI-documented guarantee of unlimited or free usage.

### Reverse-Engineered From

Based primarily on the `../opencode` provider approach plus current observed ChatGPT behavior:

- OAuth issuer: `https://auth.openai.com`
- ChatGPT backend: `https://chatgpt.com/backend-api/codex/responses`
- Account-scoped bearer requests with `ChatGPT-Account-Id`

Treat this provider as experimental and isolated from the standard `openai` API-key path.
