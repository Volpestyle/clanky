// One-time Claude Pro/Max subscription login for Clanky's optional Claude
// conductor model. Run: pnpm claude:login
import { loginClaude } from "../agent/lib/claude-auth.ts";

const creds = await loginClaude((url) => {
	console.log("\nOpen this URL in your browser to authorize Clanky on your Claude subscription:\n");
	console.log(`  ${url}\n`);
	console.log("Waiting for the callback on http://localhost:53692 ...");
});

console.log(`\nClaude login complete. Token stored. Expires ${new Date(creds.expires).toISOString()}.`);
process.exit(0);
