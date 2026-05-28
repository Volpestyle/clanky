#!/usr/bin/env -S node --experimental-strip-types
import { installBrowserBridge } from "../src/install.ts";

async function main(): Promise<void> {
	const result = await installBrowserBridge();
	const lines: string[] = [];
	lines.push("Clanky browser bridge installed.");
	lines.push("");
	lines.push(`Extension dir:       ${result.extensionDir}`);
	lines.push(`Extension id:        ${result.extensionId}`);
	lines.push(`Daemon config:       ${result.configFile}`);
	lines.push(`Extension config:    ${result.extensionConfigFile}`);
	lines.push(`Bridge port:         ${result.port}`);
	lines.push(`Auth token:          ${result.tokenPreview} (32 bytes; full value in config files)`);
	if (result.cleanedNativeMessagingManifests.length > 0) {
		lines.push("");
		lines.push("Removed legacy native-messaging manifests:");
		for (const file of result.cleanedNativeMessagingManifests) {
			lines.push(`  - ${file}`);
		}
	}
	lines.push("");
	lines.push("Next steps:");
	lines.push("  1. Start the daemon (leave running):");
	lines.push("       pnpm browser-bridge:serve");
	lines.push("  2. Load the unpacked extension:");
	lines.push("       chrome://extensions in Helium (or Chrome/Brave)");
	lines.push("       Enable Developer Mode");
	lines.push(`       Load unpacked → ${result.extensionDir}`);
	lines.push("  3. Verify by running web_backend_status from Clanky — browserBridge should report available: true.");
	console.log(lines.join("\n"));
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
