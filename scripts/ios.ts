#!/usr/bin/env bun
/**
 * ios.ts — Build, run, and manage the Clanky iOS app on a physical device.
 *
 * Usage:
 *   bun scripts/ios.ts build          Build for device
 *   bun scripts/ios.ts run            Build + install + launch on device
 *   bun scripts/ios.ts install        Install built app on device
 *   bun scripts/ios.ts launch         Launch already-installed app
 *   bun scripts/ios.ts log            Stream app logs from device
 *   bun scripts/ios.ts kill           Kill the running app
 *   bun scripts/ios.ts generate       Regenerate Xcode project from project.yml
 *   bun scripts/ios.ts clean          Clean build artifacts
 *   bun scripts/ios.ts device         Show connected device info
 *
 * Options:
 *   --release           Build in Release mode
 *   --verbose           Show full build output
 */

const IOS_DIR = new URL("../ios", import.meta.url).pathname;
const PROJECT = `${IOS_DIR}/Clanky.xcodeproj`;
const SCHEME = "Clanky";
const BUNDLE_ID = "com.clanky.app";

// Parse args
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "run";
const isRelease = args.includes("--release");
const isVerbose = args.includes("--verbose");
const config = isRelease ? "Release" : "Debug";

// ── Helpers ──────────────────────────────────────────────────────────

async function exec(cmd: string[], opts?: { cwd?: string; quiet?: boolean }): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? IOS_DIR,
    stdout: opts?.quiet ? "pipe" : "inherit",
    stderr: opts?.quiet ? "pipe" : "inherit",
  });
  const exitCode = await proc.exited;
  if (opts?.quiet) {
    const out = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${err}`);
    }
    return out.trim();
  }
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}`);
  }
  return "";
}

interface PhysicalDevice {
  udid: string;
  name: string;
  osVersion: string;
}

async function getConnectedDevice(): Promise<PhysicalDevice> {
  const out = await exec(
    ["xcrun", "xctrace", "list", "devices"],
    { quiet: true }
  );

  // Parse lines like: James's iPhone (2) (26.3.1) (00008150-0016258C21F2401C)
  // Physical devices appear before the "Simulators" section
  const lines = out.split("\n");
  const simulatorIdx = lines.findIndex((l) => l.includes("Simulator"));
  const deviceLines = simulatorIdx > 0 ? lines.slice(0, simulatorIdx) : lines;

  for (const line of deviceLines) {
    // Match: Name (OS Version) (UDID)
    const match = line.match(/^(.+?)\s+\((\d+\.\d+(?:\.\d+)?)\)\s+\(([A-F0-9-]+)\)\s*$/);
    if (match) {
      return {
        name: match[1].trim(),
        osVersion: match[2],
        udid: match[3],
      };
    }
  }

  throw new Error(
    "No physical device connected.\nPlug in your iPhone via USB or ensure Wi-Fi debugging is enabled."
  );
}

function getBuildDir(): string {
  return `${process.env.HOME ?? "~"}/Library/Developer/Xcode/DerivedData`;
}

async function getAppPath(): Promise<string> {
  const out = await exec(
    [
      "find", getBuildDir(),
      "-path", "*/Clanky-*/Build/Products/*-iphoneos/Clanky.app",
      "-maxdepth", 6,
      "-type", "d",
    ],
    { quiet: true }
  );
  const paths = out.split("\n").filter(Boolean);
  if (!paths.length) throw new Error("Built app not found. Run: bun scripts/ios.ts build");
  return paths[paths.length - 1];
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdGenerate(): Promise<void> {
  console.log("Regenerating Xcode project...");
  await exec(["xcodegen", "generate"], { cwd: IOS_DIR });
  console.log("Project regenerated");
}

async function cmdBuild(): Promise<void> {
  const device = await getConnectedDevice();
  console.log(`Building Clanky (${config}) for ${device.name}...`);
  const start = performance.now();

  const buildArgs = [
    "xcodebuild",
    "-project", PROJECT,
    "-scheme", SCHEME,
    "-destination", `id=${device.udid}`,
    "-configuration", config,
    "-allowProvisioningUpdates",
    "build",
  ];

  if (!isVerbose) {
    buildArgs.push("-quiet");
  }

  await exec(buildArgs);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`Build succeeded (${elapsed}s)`);
}

async function cmdInstall(): Promise<void> {
  const device = await getConnectedDevice();
  const appPath = await getAppPath();
  console.log(`Installing ${appPath.split("/").pop()} on ${device.name}...`);

  await exec([
    "xcrun", "devicectl", "device", "install", "app",
    "--device", device.udid,
    appPath,
  ]);

  console.log("Installed");
}

async function cmdLaunch(): Promise<void> {
  const device = await getConnectedDevice();
  console.log(`Launching Clanky on ${device.name}...`);

  await exec([
    "xcrun", "devicectl", "device", "process", "launch",
    "--device", device.udid,
    BUNDLE_ID,
  ]);

  console.log("Launched");
}

async function cmdRun(): Promise<void> {
  await cmdBuild();
  await cmdInstall();
  await cmdLaunch();
}

async function cmdLog(): Promise<void> {
  const device = await getConnectedDevice();
  console.log(`Streaming logs from ${device.name} (Ctrl+C to stop)...\n`);

  const proc = Bun.spawn(
    [
      "xcrun", "devicectl", "device", "process", "logstream",
      "--device", device.udid,
      "--process-name", "Clanky",
      "--style", "compact",
    ],
    { stdout: "inherit", stderr: "inherit" }
  );

  process.on("SIGINT", () => {
    proc.kill();
    process.exit(0);
  });

  await proc.exited;
}

async function cmdKill(): Promise<void> {
  const device = await getConnectedDevice();
  console.log("Terminating Clanky...");
  try {
    // List running processes to find PID
    const out = await exec([
      "xcrun", "devicectl", "device", "info", "processes",
      "--device", device.udid,
      "--json-output", "/dev/stdout",
    ], { quiet: true });
    const json = JSON.parse(out);
    const processes = json?.result?.runningProcesses ?? [];
    const clanky = processes.find((p: { executable?: string; bundleIdentifier?: string }) =>
      p.bundleIdentifier === BUNDLE_ID || p.executable?.includes("Clanky")
    );

    if (clanky?.processIdentifier) {
      await exec([
        "xcrun", "devicectl", "device", "process", "terminate",
        "--device", device.udid,
        "--pid", String(clanky.processIdentifier),
      ], { quiet: true });
      console.log("Terminated");
    } else {
      console.log("App was not running");
    }
  } catch {
    console.log("App was not running");
  }
}

async function cmdClean(): Promise<void> {
  console.log("Cleaning build artifacts...");
  await exec([
    "xcodebuild",
    "-project", PROJECT,
    "-scheme", SCHEME,
    "-configuration", config,
    "clean",
    "-quiet",
  ]);
  console.log("Clean");
}

async function cmdDevice(): Promise<void> {
  console.log("\nLooking for connected devices...\n");
  try {
    const device = await getConnectedDevice();
    console.log(`  NAME:     ${device.name}`);
    console.log(`  UDID:     ${device.udid}`);
    console.log(`  OS:       iOS ${device.osVersion}`);
    console.log();
  } catch (e) {
    console.log(`  ${e instanceof Error ? e.message : e}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const commands: Record<string, () => Promise<void>> = {
  build: cmdBuild,
  run: cmdRun,
  install: cmdInstall,
  launch: cmdLaunch,
  log: cmdLog,
  kill: cmdKill,
  generate: cmdGenerate,
  clean: cmdClean,
  device: cmdDevice,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  console.error(`Available: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

try {
  await handler();
} catch (e) {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
