/**
 * Lists unit/integration test files under src/ and dashboard/src/.
 *
 * Emits one path per line on stdout so it can be consumed via `$()` shell
 * substitution in `package.json` scripts. Excludes `.live.test.ts` files,
 * which are opt-in live-service tests (see `AGENTS.md`).
 *
 * Bun-native replacement for the previous ripgrep-based pipeline, so
 * developers don't need `rg` installed to run the default test suite.
 */

import { Glob } from "bun";

const patterns = [
  "src/**/*.{test,spec}.{ts,tsx,js,jsx}",
  "dashboard/src/**/*.{test,spec}.{ts,tsx,js,jsx}"
];

const results = new Set<string>();
for (const pattern of patterns) {
  const glob = new Glob(pattern);
  for await (const file of glob.scan({ cwd: ".", dot: false, followSymlinks: false, onlyFiles: true })) {
    if (file.includes(".live.")) continue;
    // Normalize Windows backslashes to forward slashes so downstream consumers
    // (bun test, shells) see a single canonical form.
    results.add(file.replaceAll("\\", "/"));
  }
}

for (const file of [...results].sort()) {
  console.log(file);
}
