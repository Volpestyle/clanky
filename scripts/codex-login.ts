// One-time Codex (ChatGPT subscription) browser login for Clanky's default
// conductor model. Run: pnpm codex:login
import { loginCodex } from "../agent/lib/codex-auth.ts";

const creds = await loginCodex((url) => {
	console.log("\nOpen this URL in your browser to authorize Clanky on your ChatGPT subscription:\n");
	console.log(`  ${url}\n`);
	console.log("Waiting for the callback on http://localhost:1455 ...");
});

console.log(`\nCodex login complete. Token stored. Expires ${new Date(creds.expires).toISOString()}.`);
process.exit(0);
