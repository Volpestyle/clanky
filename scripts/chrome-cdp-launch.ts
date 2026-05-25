import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface LaunchOptions {
	browserPath?: string;
	enableExtensions: boolean;
	headless: boolean;
	port: number;
	printCommand: boolean;
	url: string;
	userDataDir: string;
}

const DEFAULT_PORT = 9222;

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const browserPath = resolveBrowserPath(options.browserPath);
	if (browserPath === undefined) {
		throw new Error("No Chrome/Chromium binary found. Pass --browser <path> or set CHROME_PATH.");
	}
	mkdirSync(options.userDataDir, { recursive: true });

	const args = [
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${options.port}`,
		`--user-data-dir=${options.userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
	];
	if (!options.enableExtensions)
		args.push("--disable-extensions", "--disable-component-extensions-with-background-pages");
	if (options.headless) args.push("--headless=new", "--disable-gpu");
	if (options.url.length > 0) args.push(options.url);

	if (options.printCommand) {
		console.log(JSON.stringify({ browserPath, args }, null, 2));
		return;
	}

	const child = spawn(browserPath, args, { detached: true, stdio: "ignore" });
	child.unref();
	console.log(
		JSON.stringify(
			{
				pid: child.pid,
				port: options.port,
				userDataDir: options.userDataDir,
				endpoint: `http://127.0.0.1:${options.port}`,
			},
			null,
			2,
		),
	);
}

function parseArgs(args: string[]): LaunchOptions {
	const options: LaunchOptions = {
		enableExtensions: false,
		headless: false,
		port: DEFAULT_PORT,
		printCommand: false,
		url: "about:blank",
		userDataDir: defaultUserDataDir(DEFAULT_PORT),
	};
	let userDataDirExplicit = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--enable-extensions") {
			options.enableExtensions = true;
			continue;
		}
		if (arg === "--headless") {
			options.headless = true;
			continue;
		}
		if (arg === "--print-command") {
			options.printCommand = true;
			continue;
		}
		if (arg === "--browser") {
			index += 1;
			options.browserPath = readValue(args, index, "--browser");
			continue;
		}
		if (arg === "--port") {
			index += 1;
			options.port = parsePort(readValue(args, index, "--port"));
			if (!userDataDirExplicit) options.userDataDir = defaultUserDataDir(options.port);
			continue;
		}
		if (arg === "--user-data-dir") {
			index += 1;
			options.userDataDir = readValue(args, index, "--user-data-dir");
			userDataDirExplicit = true;
			continue;
		}
		if (arg === "--url") {
			index += 1;
			options.url = readValue(args, index, "--url");
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function readValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid --port value: ${value}`);
	}
	return port;
}

function defaultUserDataDir(port: number): string {
	return join(tmpdir(), `clanky-chrome-cdp-${port}-${process.pid}`);
}

function resolveBrowserPath(explicitPath: string | undefined): string | undefined {
	const candidates = [
		explicitPath,
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter((value): value is string => value !== undefined && value.trim().length > 0);

	return candidates.find((candidate) => existsSync(candidate));
}

function printHelp(): void {
	console.log(`Usage: pnpm browser:chrome-debug [options]

Launch Chrome/Chromium with a CDP remote debugging endpoint.

Options:
  --browser <path>        Chrome/Chromium binary path. Defaults to CHROME_PATH or common system paths.
  --port <port>           Remote debugging port. Default: ${DEFAULT_PORT}.
  --user-data-dir <dir>   Browser profile directory. Default: per-launch OS temp dir scoped by port.
  --url <url>             Initial page. Default: about:blank.
  --headless              Launch headless Chromium/Chrome.
  --enable-extensions     Allow Chrome extensions. Disabled by default for cleaner target lists.
  --print-command         Print the resolved binary and args without launching.
  --help                  Show this help.
`);
}

main();
