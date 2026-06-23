#!/usr/bin/env -S node --experimental-strip-types
import { resolveBrowserBridgePaths } from "../src/paths.ts";
import { startBrowserBridgeServer } from "../src/server.ts";

async function main(): Promise<void> {
	const paths = resolveBrowserBridgePaths();
	const shutdown = await startBrowserBridgeServer();
	console.log(`Clanky browser bridge server running.`);
	console.log(`  State file: ${paths.stateFile}`);
	console.log(`  Log file:   ${paths.serverLogFile}`);
	console.log(`Leave this process running while you want browser_open_tab to work.`);
	console.log(`Press Ctrl-C to stop.`);
	const keepAlive = setInterval(() => {}, 60_000);
	const stopKeepAlive = (): void => clearInterval(keepAlive);
	process.once("SIGTERM", stopKeepAlive);
	process.once("SIGINT", stopKeepAlive);
	// Touch shutdown to satisfy lint; the server already wires its own signal handlers.
	void shutdown;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
