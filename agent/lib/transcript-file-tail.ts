import { watch, type FSWatcher } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
	appendTranscriptChunk,
	type TranscriptRun,
	type TranscriptStream,
} from "./transcripts.ts";

type AppendTranscriptChunk = (
	run: TranscriptRun,
	stream: TranscriptStream,
	chunk: Buffer | Uint8Array,
) => Promise<void>;

export type TranscriptFileTailStats = {
	readonly bytes: number;
	readonly chunks: number;
	readonly flushes: number;
	readonly watchEvents: number;
};

export type TranscriptFileTail = {
	stats(): TranscriptFileTailStats;
	stop(): Promise<Error | undefined>;
};

type TranscriptFileTailOptions = {
	readonly appendChunk?: AppendTranscriptChunk;
	readonly debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 25;

export async function startTranscriptFileTail(
	run: TranscriptRun,
	path: string,
	options: TranscriptFileTailOptions = {},
): Promise<TranscriptFileTail> {
	const appendChunk = options.appendChunk ?? appendTranscriptChunk;
	const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
	const handle = await open(path, "r");
	let offset = 0;
	let stopped = false;
	let writeError: Error | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let chain = Promise.resolve();
	const stats = {
		bytes: 0,
		chunks: 0,
		flushes: 0,
		watchEvents: 0,
	};

	const flush = async (): Promise<void> => {
		stats.flushes += 1;
		const fileStats = await handle.stat();
		if (fileStats.size <= offset) return;
		const length = fileStats.size - offset;
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		offset += bytesRead;
		if (bytesRead === 0) return;
		stats.bytes += bytesRead;
		stats.chunks += 1;
		await appendChunk(run, "stdout", buffer.subarray(0, bytesRead));
	};

	const enqueueFlush = (): void => {
		chain = chain.then(flush).catch((error) => {
			writeError = error instanceof Error ? error : new Error(String(error));
		});
	};

	const scheduleFlush = (): void => {
		if (stopped || flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			enqueueFlush();
		}, debounceMs);
	};

	const watcher: FSWatcher = watch(path, { persistent: false }, () => {
		stats.watchEvents += 1;
		scheduleFlush();
	});
	watcher.on("error", (error) => {
		writeError = error;
	});

	return {
		stats(): TranscriptFileTailStats {
			return { ...stats };
		},
		async stop(): Promise<Error | undefined> {
			stopped = true;
			watcher.close();
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushTimer = undefined;
			}
			enqueueFlush();
			await chain;
			await closeFileHandle(handle, (error) => {
				writeError = error;
			});
			return writeError;
		},
	};
}

async function closeFileHandle(handle: FileHandle, onError: (error: Error) => void): Promise<void> {
	try {
		await handle.close();
	} catch (error) {
		onError(error instanceof Error ? error : new Error(String(error)));
	}
}
