import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function expect(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

const invalid = spawnSync(process.execPath, ["bin/clanky.ts", "help"], {
	env: { ...process.env, CLANKY_EVE_PORT: "0" },
	encoding: "utf8",
});
expect(invalid.status === 1, `invalid port should exit 1, got ${invalid.status}`);
expect(invalid.stderr.includes("CLANKY_EVE_PORT must be an integer from 1 to 65535"), "invalid port should print a clear error");

const ok = spawnSync(process.execPath, ["bin/clanky.ts", "help"], {
	env: { ...process.env, CLANKY_EVE_PORT: "" },
	encoding: "utf8",
});
expect(ok.status === 0, `empty port should use default and exit 0, got ${ok.status}`);

const clankyUp = readFileSync("scripts/clanky-up.ts", "utf8");
expect(clankyUp.includes("`CLANKY_EVE_PORT=${PORT}`"), "clanky-up should pass CLANKY_EVE_PORT to the command host");

console.log("port config smoke OK");
