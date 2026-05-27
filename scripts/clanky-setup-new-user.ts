import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-new-user-"));
const profile = "fresh";

console.log("Clanky fresh-user setup sandbox");
console.log(`Home: ${homeDir}`);
console.log(`Profile: ${profile}`);
console.log("");
console.log("Inside the TUI, run /setup.");
console.log("");

const child = spawn("pnpm", ["clanky", "--home", homeDir, "--profile", profile], {
	stdio: "inherit",
	env: {
		...process.env,
		CLANKY_HOME: homeDir,
		CLANKY_PROFILE: profile,
	},
});

child.on("exit", (code, signal) => {
	if (signal !== null) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 0);
});

child.on("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
