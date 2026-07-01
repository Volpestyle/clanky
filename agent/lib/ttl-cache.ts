/**
 * Bounded in-process map with LRU eviction and optional per-entry TTL. The
 * always-on brain accumulates per-channel/per-stream registries for its whole
 * uptime; unbounded Maps there are slow leaks. This caps them: expired entries
 * drop lazily on access, an opportunistic sweep on writes clears entries that
 * are never read again, and the entry cap evicts least-recently-used first.
 */
export interface TtlCacheOptions<K, V> {
	/** Hard entry cap; least-recently-used entries are evicted beyond it. */
	maxEntries: number;
	/** Per-entry lifetime from the last set (or last get with refreshTtlOnGet). */
	ttlMs?: number;
	/** Reads extend an entry's TTL (idle-based expiry instead of fixed-from-set). */
	refreshTtlOnGet?: boolean;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Observes entries dropped by TTL or LRU (not explicit delete/clear). */
	onEvict?: (key: K, value: V) => void;
}

interface TtlCacheEntry<V> {
	value: V;
	expiresAt: number | undefined;
}

/** Writes sweep expired entries at most this often; reads never pay for a sweep. */
const SWEEP_MIN_INTERVAL_MS = 60_000;

export class TtlCache<K, V> {
	private readonly entries = new Map<K, TtlCacheEntry<V>>();
	private readonly maxEntries: number;
	private readonly ttlMs: number | undefined;
	private readonly refreshTtlOnGet: boolean;
	private readonly now: () => number;
	private readonly onEvict: ((key: K, value: V) => void) | undefined;
	private lastSweepAt: number;

	constructor(options: TtlCacheOptions<K, V>) {
		if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
			throw new Error(`TtlCache maxEntries must be a positive integer; got ${options.maxEntries}`);
		}
		this.maxEntries = options.maxEntries;
		this.ttlMs = options.ttlMs;
		this.refreshTtlOnGet = options.refreshTtlOnGet ?? false;
		this.now = options.now ?? Date.now;
		this.onEvict = options.onEvict;
		this.lastSweepAt = this.now();
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: K): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		if (this.isExpired(entry)) {
			this.entries.delete(key);
			this.onEvict?.(key, entry.value);
			return undefined;
		}
		if (this.refreshTtlOnGet && this.ttlMs !== undefined) entry.expiresAt = this.now() + this.ttlMs;
		// Re-insert to move the key to the back of the Map's insertion order (LRU).
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	/** Presence check without refreshing recency or TTL. */
	has(key: K): boolean {
		const entry = this.entries.get(key);
		if (entry === undefined) return false;
		if (this.isExpired(entry)) {
			this.entries.delete(key);
			this.onEvict?.(key, entry.value);
			return false;
		}
		return true;
	}

	set(key: K, value: V): void {
		this.sweepIfDue();
		this.entries.delete(key);
		this.entries.set(key, {
			value,
			expiresAt: this.ttlMs === undefined ? undefined : this.now() + this.ttlMs,
		});
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.entries().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest[0]);
			this.onEvict?.(oldest[0], oldest[1].value);
		}
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	/** Live values, oldest-recency first; expired entries are dropped as encountered. */
	*values(): IterableIterator<V> {
		for (const [key, entry] of this.entries) {
			if (this.isExpired(entry)) {
				this.entries.delete(key);
				this.onEvict?.(key, entry.value);
				continue;
			}
			yield entry.value;
		}
	}

	/** Live keys, oldest-recency first; expired entries are dropped as encountered. */
	*keys(): IterableIterator<K> {
		for (const [key, entry] of this.entries) {
			if (this.isExpired(entry)) {
				this.entries.delete(key);
				this.onEvict?.(key, entry.value);
				continue;
			}
			yield key;
		}
	}

	private isExpired(entry: TtlCacheEntry<V>): boolean {
		return entry.expiresAt !== undefined && this.now() > entry.expiresAt;
	}

	private sweepIfDue(): void {
		if (this.ttlMs === undefined) return;
		const now = this.now();
		if (now - this.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
		this.lastSweepAt = now;
		for (const [key, entry] of this.entries) {
			if (!this.isExpired(entry)) continue;
			this.entries.delete(key);
			this.onEvict?.(key, entry.value);
		}
	}
}
