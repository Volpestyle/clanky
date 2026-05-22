import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrokerReceivedEvent, BrokerSentEvent } from "./broker.ts";

export type MessagingHookEvent =
	| { type: "messaging.received"; event: BrokerReceivedEvent }
	| { type: "messaging.sent"; event: BrokerSentEvent }
	| { type: "messaging.startup"; profile: string };

export type MessagingHook = (event: MessagingHookEvent) => Promise<void> | void;

export interface HookRegistryOptions {
	hooksDir: string;
	dynamicImport: (file: string) => Promise<{ default?: MessagingHook }>;
}

export class HookRegistry {
	private readonly hooksDir: string;
	private readonly dynamicImport: (file: string) => Promise<{ default?: MessagingHook }>;
	private hooks: MessagingHook[] = [];
	private loaded = false;

	constructor(options: HookRegistryOptions) {
		this.hooksDir = options.hooksDir;
		this.dynamicImport = options.dynamicImport;
	}

	async load(): Promise<void> {
		const entries = await readdir(this.hooksDir).catch(() => []);
		const programmatic = this.hooks.filter((hook) => isProgrammaticHook(hook));
		const fresh: MessagingHook[] = [...programmatic];
		for (const entry of entries) {
			if (!entry.endsWith(".js") && !entry.endsWith(".mjs")) continue;
			const file = join(this.hooksDir, entry);
			const exists = await stat(file)
				.then((info) => info.isFile())
				.catch(() => false);
			if (!exists) continue;
			try {
				const moduleExports = await this.dynamicImport(file);
				if (typeof moduleExports.default === "function") {
					fresh.push(moduleExports.default);
				}
			} catch {
				// ignore broken hooks
			}
		}
		this.hooks = fresh;
		this.loaded = true;
	}

	registerProgrammatic(hook: MessagingHook): void {
		markProgrammaticHook(hook);
		this.hooks.push(hook);
		this.loaded = true;
	}

	async emit(event: MessagingHookEvent): Promise<void> {
		if (!this.loaded) await this.load().catch(() => undefined);
		await Promise.all(
			this.hooks.map((hook) =>
				Promise.resolve()
					.then(() => hook(event))
					.catch(() => undefined),
			),
		);
	}

	async describe(): Promise<{ hooksDir: string; count: number; files: string[] }> {
		const files = await readdir(this.hooksDir).catch(() => []);
		const candidates = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
		const sample = await readSample(this.hooksDir, candidates[0]);
		return {
			hooksDir: this.hooksDir,
			count: this.hooks.length,
			files: sample === undefined ? candidates : candidates,
		};
	}
}

const PROGRAMMATIC_HOOK_MARKER = Symbol("clanky.messaging.programmatic_hook");

function markProgrammaticHook(hook: MessagingHook): void {
	(hook as MessagingHook & { [PROGRAMMATIC_HOOK_MARKER]?: true })[PROGRAMMATIC_HOOK_MARKER] = true;
}

function isProgrammaticHook(hook: MessagingHook): boolean {
	return (hook as MessagingHook & { [PROGRAMMATIC_HOOK_MARKER]?: true })[PROGRAMMATIC_HOOK_MARKER] === true;
}

async function readSample(dir: string, name: string | undefined): Promise<string | undefined> {
	if (name === undefined) return undefined;
	return await readFile(join(dir, name), "utf8").catch(() => undefined);
}
