# Claude AI OAuth Provider (`claude-oauth`)

## Overview

The `claude-oauth` provider authenticates against the Anthropic Messages API using OAuth tokens from a Claude Pro/Max subscription, instead of a paid API key. This gives access to Claude models at zero marginal cost (covered by the subscription).

This replaces the old `claude-code` provider which spawned the `claude` CLI as a subprocess. The OAuth provider calls the API directly via `@anthropic-ai/sdk` with a custom fetch wrapper.

## How It Works

### Authentication Flow

1. **One-time login**: OAuth 2.0 PKCE flow against `claude.ai/oauth/authorize`
2. **Token storage**: Refresh + access tokens stored in `data/claude-oauth-tokens.json`
3. **Per-request**: Access token auto-refreshed when expired, sent as `Authorization: Bearer <token>`

### API Compatibility Layer

The OAuth endpoint requires requests to look like they come from the Claude CLI. The custom fetch wrapper handles:

- `Authorization: Bearer <access_token>` instead of `x-api-key`
- `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14` header
- `user-agent: claude-cli/2.1.2 (external, cli)` spoofing
- Tool name prefixing: all tool names get `mcp_` prefix outbound, stripped on response
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

## Setup

### Option 1: Environment Variable (quickstart)

Set `CLAUDE_OAUTH_REFRESH_TOKEN` in your `.env`. You can obtain a refresh token by:

1. Visit the authorize URL (logged at startup when token is set)
2. Authorize and copy the code
3. Exchange via the token endpoint

### Option 2: Dashboard Login (TODO)

A dashboard route will be added to handle the full OAuth flow interactively.

### Option 3: Manual Token File

Create `data/claude-oauth-tokens.json`:

```json
{
  "refreshToken": "<your-refresh-token>",
  "accessToken": "",
  "expiresAt": 0
}
```

The access token will be auto-populated on first use.

## Configuration

```env
# Provider selection
DEFAULT_PROVIDER=claude-oauth

# OAuth refresh token (bootstrap)
CLAUDE_OAUTH_REFRESH_TOKEN=your-refresh-token-here
```

In settings, use `provider: "claude-oauth"` with standard Anthropic model IDs:

```json
{
  "provider": "claude-oauth",
  "model": "claude-sonnet-4-6"
}
```

## Pricing

All usage is zero-cost (covered by subscription). The pricing table reflects this with `0` rates for all models.

## Architecture

```
LLMService
  └── claude-oauth provider
        └── Anthropic SDK (same as `anthropic` provider)
              └── custom fetch wrapper (claudeOAuth.ts)
                    ├── token refresh (console.anthropic.com/v1/oauth/token)
                    ├── Bearer auth header
                    ├── beta headers + user-agent
                    ├── mcp_ tool name prefixing
                    └── ?beta=true query param
```

The provider reuses the exact same `callAnthropic` code path as the regular `anthropic` provider. The only difference is the Anthropic SDK client is configured with a custom fetch that handles OAuth auth.

## Reverse-Engineered From

This approach is based on the `opencode-anthropic-auth` plugin (npm `opencode-anthropic-auth@0.0.13`), which implements the same OAuth flow used by the Claude Code CLI. Key constants:

- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **OAuth authorize**: `https://claude.ai/oauth/authorize`
- **Token endpoint**: `https://console.anthropic.com/v1/oauth/token`
- **Redirect URI**: `https://console.anthropic.com/oauth/code/callback`
- **Scopes**: `org:create_api_key user:profile user:inference`
