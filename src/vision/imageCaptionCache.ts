/**
 * Image Caption Cache — caches vision-model captions for image URLs.
 *
 * Each image URL is captioned at most once. Subsequent lookups return the
 * cached caption until it expires or the cache is evicted.
 *
 * Concurrent requests for the same URL are coalesced — only one vision call
 * fires, and all waiters receive the same result.
 */

import { captionImage } from "./captionImage.ts";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface CachedCaption {
    caption: string;
    captionedAt: number;
    provider: string | null;
    model: string | null;
}

export class ImageCaptionCache {
    private cache: Map<string, CachedCaption>;
    private inflight: Map<string, Promise<CachedCaption | null>>;
    private maxEntries: number;
    private defaultTtlMs: number;

    constructor({
        maxEntries = DEFAULT_MAX_ENTRIES,
        defaultTtlMs = DEFAULT_TTL_MS
    } = {}) {
        this.cache = new Map();
        this.inflight = new Map();
        this.maxEntries = Math.max(10, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
        this.defaultTtlMs = Math.max(1, Number(defaultTtlMs) || DEFAULT_TTL_MS);
    }

    /**
     * Get a cached caption by URL without generating.
     */
    get(rawUrl: string): CachedCaption | null {
        const key = normalizeUrl(rawUrl);
        if (!key) return null;
        return this.cache.get(key) || null;
    }

    /**
     * Check if a URL has a cached caption.
     */
    has(rawUrl: string): boolean {
        const key = normalizeUrl(rawUrl);
        if (!key) return false;
        return this.cache.has(key);
    }

    /**
     * Check if a URL has a cached caption or is currently being captioned.
     */
    hasOrInflight(rawUrl: string): boolean {
        const key = normalizeUrl(rawUrl);
        if (!key) return false;
        return this.cache.has(key) || this.inflight.has(key);
    }

    /**
     * Get cached caption or generate + cache via captionImage().
     * Concurrent requests for the same URL are coalesced.
     */
    async getOrCaption({
        url,
        llm,
        settings = null,
        mimeType = "",
        trace = null
    }: {
        url: string;
        llm: unknown;
        settings?: Record<string, unknown> | null;
        mimeType?: string;
        trace?: Record<string, unknown> | null;
    }): Promise<CachedCaption | null> {
        const key = normalizeUrl(url);
        if (!key) return null;

        // Cache hit
        const existing = this.cache.get(key);
        if (existing) return existing;

        // Coalesce concurrent requests
        const pending = this.inflight.get(key);
        if (pending) return pending;

        const promise = this.generateAndCache(key, url, llm, settings, mimeType, trace);
        this.inflight.set(key, promise);

        try {
            return await promise;
        } finally {
            this.inflight.delete(key);
        }
    }

    /**
     * Manually set a caption for a URL (e.g. from an external source).
     */
    set(rawUrl: string, caption: string, provider: string | null = null, model: string | null = null): void {
        const key = normalizeUrl(rawUrl);
        if (!key || !caption) return;

        this.enforceMaxEntries();
        this.cache.set(key, {
            caption: String(caption).trim(),
            captionedAt: Date.now(),
            provider,
            model
        });
    }

    /**
     * Evict entries older than maxAgeMs. Returns the number evicted.
     */
    evict(maxAgeMs?: number): number {
        const ttl = Math.max(0, Number(maxAgeMs) || this.defaultTtlMs);
        const cutoff = Date.now() - ttl;
        let evicted = 0;

        for (const [key, entry] of this.cache) {
            if (entry.captionedAt < cutoff) {
                this.cache.delete(key);
                evicted++;
            }
        }

        return evicted;
    }

    /**
     * Get the current number of cached entries.
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Clear all entries.
     */
    clear(): void {
        this.cache.clear();
        this.inflight.clear();
    }

    // --- private ---

    private async generateAndCache(
        key: string,
        url: string,
        llm: unknown,
        settings: Record<string, unknown> | null,
        mimeType: string,
        trace: Record<string, unknown> | null
    ): Promise<CachedCaption | null> {
        const result = await captionImage({
            llm,
            settings,
            url,
            mimeType,
            trace
        });

        if (!result?.caption) return null;

        const entry: CachedCaption = {
            caption: result.caption,
            captionedAt: Date.now(),
            provider: result.provider || null,
            model: result.model || null
        };

        this.enforceMaxEntries();
        this.cache.set(key, entry);
        return entry;
    }

    private enforceMaxEntries(): void {
        if (this.cache.size < this.maxEntries) return;

        // Evict oldest entries first
        const entries = [...this.cache.entries()].sort(
            (a, b) => a[1].captionedAt - b[1].captionedAt
        );

        const toRemove = Math.max(1, Math.floor(this.maxEntries * 0.1));
        for (let i = 0; i < toRemove && i < entries.length; i++) {
            this.cache.delete(entries[i][0]);
        }
    }
}

function normalizeUrl(rawUrl: unknown): string {
    const text = String(rawUrl || "").trim();
    if (!text) return "";
    // Strip query params for cache key normalization to avoid
    // Discord CDN token variations causing cache misses.
    // Keep the path but normalize the host.
    try {
        const parsed = new URL(text);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase();
    } catch {
        return text.toLowerCase();
    }
}
