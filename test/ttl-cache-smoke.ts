// Pure smoke for the shared TtlCache (agent/lib/ttl-cache.ts): LRU bounds,
// TTL expiry with an injected clock, sliding TTL, eviction callbacks, and the
// opportunistic write-time sweep. Run: node test/ttl-cache-smoke.ts
import { TtlCache } from "../agent/lib/ttl-cache.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

// --- basic map behavior ----------------------------------------------------
{
	const cache = new TtlCache<string, number>({ maxEntries: 10 });
	cache.set("a", 1);
	cache.set("b", 2);
	check("get returns stored value", cache.get("a") === 1);
	check("has sees stored key", cache.has("b"));
	check("missing key reads undefined", cache.get("nope") === undefined);
	check("size counts entries", cache.size === 2);
	cache.set("a", 3);
	check("set overwrites in place", cache.get("a") === 3 && cache.size === 2);
	check("delete removes", cache.delete("a") && cache.get("a") === undefined);
	cache.clear();
	check("clear empties", cache.size === 0);
}

// --- LRU eviction ------------------------------------------------------------
{
	const evicted: string[] = [];
	const cache = new TtlCache<string, number>({ maxEntries: 2, onEvict: (key) => evicted.push(key) });
	cache.set("a", 1);
	cache.set("b", 2);
	cache.get("a"); // refresh recency: b is now least-recently-used
	cache.set("c", 3);
	check("over-cap set evicts the least-recently-used key", evicted.join("|") === "b");
	check("recently used key survives", cache.has("a") && cache.has("c") && !cache.has("b"));
}

// --- TTL expiry with injected clock ------------------------------------------
{
	let t = 1_000_000;
	const evicted: string[] = [];
	const cache = new TtlCache<string, string>({
		maxEntries: 10,
		ttlMs: 1_000,
		now: () => t,
		onEvict: (key) => evicted.push(key),
	});
	cache.set("k", "v");
	t += 1_000;
	check("entry at exactly ttl is still live", cache.get("k") === "v");
	t += 1;
	check("entry past ttl expires on get", cache.get("k") === undefined);
	check("ttl expiry reports through onEvict", evicted.join("|") === "k");
	check("expired key also fails has", !cache.has("k"));

	cache.set("x", "1");
	t += 2_000;
	cache.set("y", "2");
	check("values skips and drops expired entries", [...cache.values()].join("|") === "2");
	check("keys skips and drops expired entries", [...cache.keys()].join("|") === "y");
}

// --- get does not extend TTL by default --------------------------------------
{
	let t = 0;
	const cache = new TtlCache<string, boolean>({ maxEntries: 4, ttlMs: 100, now: () => t });
	cache.set("k", true);
	t = 90;
	check("read inside window sees entry", cache.get("k") === true);
	t = 101;
	check("fixed ttl expires from set time despite reads", cache.get("k") === undefined);
}

// --- sliding TTL (refreshTtlOnGet) --------------------------------------------
{
	let t = 0;
	const cache = new TtlCache<string, boolean>({ maxEntries: 4, ttlMs: 100, now: () => t, refreshTtlOnGet: true });
	cache.set("k", true);
	t = 90;
	check("sliding read refreshes the entry", cache.get("k") === true);
	t = 180;
	check("entry survives past original expiry after refresh", cache.get("k") === true);
	t = 300;
	check("idle sliding entry still expires", cache.get("k") === undefined);
}

// --- opportunistic sweep on writes --------------------------------------------
{
	let t = 0;
	const evicted: string[] = [];
	const cache = new TtlCache<string, number>({
		maxEntries: 10,
		ttlMs: 1_000,
		now: () => t,
		onEvict: (key) => evicted.push(key),
	});
	cache.set("stale", 1);
	// Advance past both the TTL and the sweep interval, then write an unrelated
	// key: the stale entry must be dropped without ever being read again.
	t = 70_000;
	cache.set("fresh", 2);
	check("write-time sweep drops never-read expired entries", evicted.includes("stale"));
	check("sweep keeps the fresh entry", cache.get("fresh") === 2);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
