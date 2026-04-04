#!/usr/bin/env bun
/**
 * Cross-platform build script for the clankvox Rust voice engine.
 *
 * Replaces the old bash one-liner that doesn't work on Windows:
 *   cd src/voice/clankvox && OPUS_STATIC=1 OPUS_NO_PKG=1 cargo build --release
 *
 * Sets the right environment variables for native C dependency builds
 * (opus, turbojpeg) and works on macOS, Linux, and Windows.
 */
import path from "node:path";
import fs from "node:fs";

// ── Ensure cargo is reachable ──────────────────────────────────────────────
// rustup installs to ~/.cargo/bin which may not be in PATH yet if the shell
// hasn't been restarted since install.  Detect and patch at runtime.
function ensureCargoInPath(): void {
  try {
    Bun.spawnSync(["cargo", "--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return; // already reachable
  } catch {
    // not in PATH — try the standard rustup location
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cargoBin = path.join(home, ".cargo", "bin");
  const cargoExe = path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");

  if (fs.existsSync(cargoExe)) {
    process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH ?? ""}`;
    console.log(`[build:voice] Added ${cargoBin} to PATH (restart your terminal to make this permanent)`);
    return;
  }

  console.error(
    "[build:voice] cargo not found in PATH or ~/.cargo/bin.\n" +
    "  Install Rust: https://rustup.rs"
  );
  process.exit(1);
}

ensureCargoInPath();

// ── Locate clankvox ────────────────────────────────────────────────────────
const clankvoxDir = path.resolve(import.meta.dirname!, "..", "src", "voice", "clankvox");

// Verify the directory exists (submodule might not be initialized)
const cargoToml = Bun.file(path.join(clankvoxDir, "Cargo.toml"));
if (!(await cargoToml.exists())) {
  console.error(
    "[build:voice] src/voice/clankvox/Cargo.toml not found.\n" +
    "  Run: git submodule update --init --recursive"
  );
  process.exit(1);
}

// ── Build ──────────────────────────────────────────────────────────────────
console.log(`[build:voice] Building clankvox in ${clankvoxDir}`);

const result = Bun.spawnSync(["cargo", "build", "--release"], {
  cwd: clankvoxDir,
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    // Build opus from vendored source instead of looking for system pkg-config
    OPUS_STATIC: "1",
    OPUS_NO_PKG: "1",
    // CMake 4.x removed compat with cmake_minimum_required < 3.5.
    // audiopus_sys bundles an older CMakeLists.txt that triggers this.
    CMAKE_POLICY_VERSION_MINIMUM: "3.5",
  },
});

if (result.exitCode !== 0) {
  console.error(`[build:voice] cargo build failed with exit code ${result.exitCode}`);
  process.exit(result.exitCode ?? 1);
}

console.log("[build:voice] Done.");
