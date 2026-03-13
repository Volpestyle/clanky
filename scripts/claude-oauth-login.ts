#!/usr/bin/env bun
/**
 * One-time script to obtain Claude OAuth tokens for clanky.
 * Run: bun scripts/claude-oauth-login.ts
 *
 * 1. Opens the authorize URL in your browser
 * 2. You log in / authorize
 * 3. Paste the code back here
 * 4. Tokens are saved to data/claude-oauth-tokens.json
 */

import { buildAuthorizeUrl, exchangeCodeForTokens } from "../src/llm/claudeOAuth.ts";
import { createInterface } from "node:readline";

const { url, verifier } = buildAuthorizeUrl();

console.log("\n--- Claude OAuth Login ---\n");
console.log("1. Open this URL in your browser:\n");
console.log(`   ${url}\n`);
console.log("2. Log in with your Claude Pro/Max account and authorize.\n");
console.log("3. You'll see an authorization code. Copy it and paste it below.\n");

// Try to open the URL automatically
try {
  const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
} catch {
  // ignore - user can open manually
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = await new Promise<string>((resolve) => {
  rl.question("Authorization code: ", (answer) => {
    rl.close();
    resolve(answer.trim());
  });
});

if (!code) {
  console.error("\nNo code provided. Aborting.");
  process.exit(1);
}

try {
  const tokens = await exchangeCodeForTokens(code, verifier);
  console.log("\nTokens saved to data/claude-oauth-tokens.json");
  console.log(`Refresh token: ${tokens.refreshToken.slice(0, 12)}...`);
  console.log(`Access token expires: ${new Date(tokens.expiresAt).toISOString()}`);
  console.log("\nYou can now use provider: claude-oauth in your settings.");
  console.log("Or set DEFAULT_PROVIDER=claude-oauth in your .env\n");
} catch (error) {
  console.error("\nFailed to exchange code:", (error as Error).message);
  process.exit(1);
}
