// Idempotent ClankVox setup for Clanky Discord voice. Ensures the Rust
// toolchain (installs rustup unattended if missing), builds the clankvox
// release binary, and verifies it. Re-running is a no-op once built.
// Run: pnpm clankvox:setup   (force a rebuild with: pnpm clankvox:setup --force)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { clankvoxNativeBuildEnv, resolveClankvoxBinaryLocation } from "../agent/lib/voice/clankvoxIpcClient.ts";

const force = process.argv.includes("--force");
const { cwd, releaseBin } = resolveClankvoxBinaryLocation();

if (!existsSync(cwd)) {
	console.error(`ClankVox source not found at ${cwd}.`);
	console.error("Clone it as a sibling of this repo, or set CLANKY_CLANKVOX_DIR to its path, then re-run.");
	process.exit(1);
}

if (existsSync(releaseBin) && !force) {
	console.log(`ClankVox already built: ${releaseBin}`);
	console.log("Pass --force to rebuild.");
	process.exit(0);
}

// Prefer cargo from a freshly-installed rustup even if the parent shell never
// sourced it, without mutating the user's git-managed shell profiles.
const cargoBin = join(homedir(), ".cargo", "bin");
const buildEnv: NodeJS.ProcessEnv = { ...process.env, ...clankvoxNativeBuildEnv, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ""}` };

function hasCargo(): boolean {
	return spawnSync("cargo", ["--version"], { stdio: "ignore", env: buildEnv }).status === 0;
}

if (!hasCargo()) {
	console.log("Rust toolchain not found; installing via rustup (unattended)...");
	// --no-modify-path keeps James's git-managed dotfiles untouched; this script
	// puts ~/.cargo/bin on PATH for the build itself.
	const installer = spawnSync("sh", ["-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path"], {
		stdio: "inherit",
		env: process.env,
	});
	if (installer.status !== 0) {
		console.error("rustup install failed. Install Rust from https://rustup.rs and re-run.");
		process.exit(installer.status ?? 1);
	}
	if (!hasCargo()) {
		console.error(`cargo still not found after install. Ensure ${cargoBin} is on PATH and re-run.`);
		process.exit(1);
	}
}

console.log(`Building ClankVox (release) in ${cwd} ...`);
const build = spawnSync("cargo", ["build", "--release", "--locked"], { cwd, stdio: "inherit", env: buildEnv });
if (build.status !== 0) {
	console.error(`\ncargo build failed (${build.status === null ? `signal ${build.signal}` : `exit ${build.status}`}).`);
	process.exit(build.status ?? 1);
}

if (!existsSync(releaseBin)) {
	console.error(`Build finished but binary is missing at ${releaseBin}.`);
	process.exit(1);
}

console.log(`\nClankVox ready: ${releaseBin}`);
console.log("Discord voice join will now use this prebuilt binary.");
process.exit(0);
