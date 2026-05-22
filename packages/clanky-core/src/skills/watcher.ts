import { mkdir } from "node:fs/promises";
import { type FSWatcher, watch } from "chokidar";
import type { ClankyPaths } from "../paths.ts";
import { defaultBundledSkillsDir } from "./loader.ts";

export interface ClankySkillWatcherOptions {
	paths: ClankyPaths;
	bundledSkillsDir?: string;
	debounceMs?: number;
	onChange(): void | Promise<void>;
	onError?(error: Error): void;
}

const DEFAULT_DEBOUNCE_MS = 50;

export class ClankySkillWatcher {
	private readonly paths: ClankyPaths;
	private readonly bundledSkillsDir: string | undefined;
	private readonly debounceMs: number;
	private readonly onChange: () => void | Promise<void>;
	private readonly onError: ((error: Error) => void) | undefined;
	private watcher: FSWatcher | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private reloadQueue: Promise<void> = Promise.resolve();

	constructor(options: ClankySkillWatcherOptions) {
		this.paths = options.paths;
		this.bundledSkillsDir = options.bundledSkillsDir;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.onChange = options.onChange;
		this.onError = options.onError;
	}

	async start(): Promise<void> {
		if (this.watcher !== undefined) return;
		await mkdir(this.paths.skillsDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.profileSkillsDir, { recursive: true, mode: 0o700 });
		const watcher = watch(this.watchDirs(), {
			ignoreInitial: true,
			persistent: false,
			usePolling: true,
			interval: 100,
			awaitWriteFinish: {
				stabilityThreshold: 50,
				pollInterval: 10,
			},
			ignored: (path) => path.endsWith(".usage.json"),
		});
		this.watcher = watcher;
		watcher.on("all", (_event, path) => {
			if (isSkillPath(path)) this.scheduleReload();
		});
		watcher.on("error", (error) => {
			this.reportError(error instanceof Error ? error : new Error(String(error)));
		});
		await new Promise<void>((resolve) => {
			watcher.once("ready", resolve);
		});
	}

	async close(): Promise<void> {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const watcher = this.watcher;
		this.watcher = undefined;
		await watcher?.close();
		await this.reloadQueue;
	}

	private watchDirs(): string[] {
		return [this.bundledSkillsDir ?? defaultBundledSkillsDir(), this.paths.skillsDir, this.paths.profileSkillsDir];
	}

	private scheduleReload(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.reloadQueue = this.reloadQueue
				.then(async () => {
					await this.onChange();
				})
				.catch((error: unknown) => {
					this.reportError(error instanceof Error ? error : new Error(String(error)));
				});
		}, this.debounceMs);
	}

	private reportError(error: Error): void {
		if (this.onError !== undefined) {
			this.onError(error);
			return;
		}
		console.error(error.message);
	}
}

function isSkillPath(path: string): boolean {
	return path.endsWith("SKILL.md") || !path.includes(".");
}
