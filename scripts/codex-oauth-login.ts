#!/usr/bin/env bun
/**
 * One-time script to obtain OpenAI OAuth tokens for clanky.
 * Canonical entrypoint: bun scripts/openai-oauth-login.ts
 *
 * 1. Starts a temporary localhost callback server
 * 2. Opens the OpenAI authorization URL in your browser
 * 3. Completes ChatGPT account login
 * 4. Saves tokens to data/openai-oauth-tokens.json
 */

import { buildAuthorizeUrl, codexOAuthConstants, exchangeCodeForTokens } from "../src/llm/codexOAuth.ts";

const redirectUri = codexOAuthConstants.defaultRedirectUri;
const { url, verifier, state } = buildAuthorizeUrl({ redirectUri });

console.log("\n--- OpenAI OAuth Login ---\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${url}\n`);
console.log("2. Log in with a supported ChatGPT account and authorize.\n");
console.log("3. This script will capture the callback automatically.\n");

let resolveCode: ((value: string) => void) | null = null;
let rejectCode: ((error: Error) => void) | null = null;

const codePromise = new Promise<string>((resolve, reject) => {
  resolveCode = resolve;
  rejectCode = reject;
});

const server = Bun.serve({
  port: codexOAuthConstants.defaultCallbackPort,
  fetch(request) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/auth/callback") {
      const code = String(requestUrl.searchParams.get("code") || "").trim();
      const returnedState = String(requestUrl.searchParams.get("state") || "").trim();
      const error = String(requestUrl.searchParams.get("error") || "").trim();
      const errorDescription = String(requestUrl.searchParams.get("error_description") || "").trim();

      if (error) {
        rejectCode?.(new Error(errorDescription || error));
        return new Response(
          `<html><body><h1>Authorization failed</h1><p>${errorDescription || error}</p></body></html>`,
          {
            status: 400,
            headers: { "Content-Type": "text/html" }
          }
        );
      }

      if (!code) {
        rejectCode?.(new Error("Missing authorization code"));
        return new Response(
          "<html><body><h1>Authorization failed</h1><p>Missing authorization code.</p></body></html>",
          {
            status: 400,
            headers: { "Content-Type": "text/html" }
          }
        );
      }

      if (returnedState !== state) {
        rejectCode?.(new Error("OAuth state mismatch"));
        return new Response(
          "<html><body><h1>Authorization failed</h1><p>OAuth state mismatch.</p></body></html>",
          {
            status: 400,
            headers: { "Content-Type": "text/html" }
          }
        );
      }

      resolveCode?.(code);
      return new Response(
        "<html><body><h1>Authorization successful</h1><p>You can close this window.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>",
        {
          headers: { "Content-Type": "text/html" }
        }
      );
    }

    if (requestUrl.pathname === "/cancel") {
      rejectCode?.(new Error("Login cancelled"));
      return new Response("Login cancelled");
    }

    return new Response("Not found", { status: 404 });
  }
});

const timeout = setTimeout(() => {
  rejectCode?.(new Error("OAuth callback timeout - authorization took too long"));
}, 5 * 60 * 1000);

try {
  try {
    const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // ignore - user can open manually
  }

  const code = await codePromise;
  const tokens = await exchangeCodeForTokens({
    code,
    redirectUri,
    verifier
  });

  console.log("\nOpenAI OAuth tokens saved to data/openai-oauth-tokens.json");
  console.log(`Refresh token: ${tokens.refreshToken.slice(0, 12)}...`);
  console.log(`Account id: ${tokens.accountId || "(not returned)"}`);
  console.log(`Access token expires: ${new Date(tokens.expiresAt).toISOString()}`);
  console.log("\nYou can now use OpenAI OAuth in the app via provider: openai-oauth.");
  console.log("Or set DEFAULT_PROVIDER=openai-oauth in your .env\n");
} catch (error) {
  console.error("\nFailed to complete OpenAI OAuth login:", (error as Error).message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  server.stop();
}
