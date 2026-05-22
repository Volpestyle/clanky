import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { Platform } from "./types.ts";

export interface StickerCacheKey {
	platform: Platform;
	fileId: string;
	emoji?: string;
}

export interface StickerCacheEntry {
	key: StickerCacheKey;
	cacheFile: string;
	mime?: string;
	cachedAt: string;
}

export interface StickerCacheLoader {
	download: (key: StickerCacheKey) => Promise<{ data: Buffer; mime?: string; extension?: string } | undefined>;
}

export class StickerCache {
	private readonly cacheDir: string;
	private index: Map<string, StickerCacheEntry> = new Map();
	private loaded = false;

	constructor(cacheDir: string) {
		this.cacheDir = cacheDir;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const indexFile = this.indexPath();
		const raw = await readFile(indexFile, "utf8").catch(() => undefined);
		if (raw !== undefined) {
			try {
				const parsed = JSON.parse(raw) as { entries?: StickerCacheEntry[] };
				if (Array.isArray(parsed.entries)) {
					for (const entry of parsed.entries) {
						this.index.set(this.cacheKey(entry.key), entry);
					}
				}
			} catch {
				// ignore corrupt file
			}
		}
		this.loaded = true;
	}

	async get(key: StickerCacheKey, loader: StickerCacheLoader): Promise<StickerCacheEntry | undefined> {
		await this.ensureLoaded();
		const existing = this.index.get(this.cacheKey(key));
		if (existing !== undefined) {
			const stillThere = await stat(existing.cacheFile)
				.then(() => true)
				.catch(() => false);
			if (stillThere) return existing;
			this.index.delete(this.cacheKey(key));
		}
		const downloaded = await loader.download(key).catch(() => undefined);
		if (downloaded === undefined) return undefined;
		const extension = downloaded.extension ?? defaultExtension(downloaded.mime);
		const cacheFile = join(this.cacheDir, `${this.cacheKey(key)}${extension}`);
		await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
		await writeFile(cacheFile, downloaded.data, { mode: 0o600 });
		const entry: StickerCacheEntry = {
			key,
			cacheFile,
			cachedAt: new Date().toISOString(),
		};
		if (downloaded.mime !== undefined) entry.mime = downloaded.mime;
		this.index.set(this.cacheKey(key), entry);
		await this.persistIndex();
		return entry;
	}

	async list(): Promise<StickerCacheEntry[]> {
		await this.ensureLoaded();
		return [...this.index.values()];
	}

	async invalidate(key: StickerCacheKey): Promise<void> {
		await this.ensureLoaded();
		this.index.delete(this.cacheKey(key));
		await this.persistIndex();
	}

	private cacheKey(key: StickerCacheKey): string {
		const hash = createHash("sha256")
			.update(`${key.platform}:${key.fileId}:${key.emoji ?? ""}`)
			.digest("hex")
			.slice(0, 32);
		return `${key.platform}-${hash}`;
	}

	private indexPath(): string {
		return join(this.cacheDir, "index.json");
	}

	private async persistIndex(): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
		const file = this.indexPath();
		const tmp = `${file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify({ version: 1, entries: [...this.index.values()] }, null, "\t")}\n`, {
			mode: 0o600,
		});
		await (await import("node:fs/promises")).rename(tmp, file);
	}
}

function defaultExtension(mime: string | undefined): string {
	if (mime === undefined) return ".bin";
	if (mime.includes("webp")) return ".webp";
	if (mime.includes("png")) return ".png";
	if (mime.includes("gif")) return ".gif";
	if (mime.includes("jpeg")) return ".jpg";
	if (mime.includes("ogg") || mime.includes("oga")) return ".ogg";
	if (mime.includes("mpeg")) return ".mp3";
	const subtype = mime.split("/")[1];
	if (subtype !== undefined && /^[a-zA-Z0-9]+$/.test(subtype)) return `.${subtype}`;
	return ".bin";
}

export function extensionFor(mime: string | undefined): string {
	return defaultExtension(mime);
}

export function extOfFile(path: string): string {
	return extname(path);
}
