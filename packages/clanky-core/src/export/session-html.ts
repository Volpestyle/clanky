import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export interface SessionHtmlInput {
	sessionId: string;
	content: string;
}

interface PendingSessionHtmlRender {
	id: number;
	input: SessionHtmlInput;
	resolve: (html: string) => void;
	reject: (error: Error) => void;
}

interface SessionHtmlWorkerSlot {
	worker: Worker;
	current: PendingSessionHtmlRender | undefined;
	closed: boolean;
}

type SessionHtmlWorkerMessage =
	| {
			id: number;
			ok: true;
			html: string;
	  }
	| {
			id: number;
			ok: false;
			error: string;
	  };

class SessionHtmlWorkerPool {
	private readonly maxWorkers: number;
	private readonly workers: SessionHtmlWorkerSlot[] = [];
	private readonly queue: PendingSessionHtmlRender[] = [];
	private nextRequestId = 1;

	constructor(maxWorkers: number) {
		this.maxWorkers = maxWorkers;
	}

	async render(input: SessionHtmlInput): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			this.queue.push({
				id: this.nextRequestId,
				input,
				resolve,
				reject,
			});
			this.nextRequestId += 1;
			this.pump();
		});
	}

	private pump(): void {
		while (this.queue.length > 0) {
			const slot = this.idleWorker() ?? this.createWorkerIfCapacityAvailable();
			if (slot === undefined) return;
			const pending = this.queue.shift();
			if (pending === undefined) return;
			slot.current = pending;
			slot.worker.ref();
			slot.worker.postMessage({ id: pending.id, input: pending.input });
		}
	}

	private idleWorker(): SessionHtmlWorkerSlot | undefined {
		return this.workers.find((slot) => !slot.closed && slot.current === undefined);
	}

	private createWorkerIfCapacityAvailable(): SessionHtmlWorkerSlot | undefined {
		if (this.workers.length >= this.maxWorkers) return undefined;
		const worker = new Worker(new URL("./session-html-worker.mjs", import.meta.url));
		worker.unref();
		const slot: SessionHtmlWorkerSlot = {
			worker,
			current: undefined,
			closed: false,
		};
		worker.on("message", (message: unknown) => {
			this.handleMessage(slot, message);
		});
		worker.on("error", (error) => {
			this.discardWorker(slot, error);
		});
		worker.on("exit", (code) => {
			if (code === 0) {
				this.discardWorker(slot);
				return;
			}
			this.discardWorker(slot, new Error(`Session HTML worker exited with code ${code}`));
		});
		this.workers.push(slot);
		return slot;
	}

	private handleMessage(slot: SessionHtmlWorkerSlot, message: unknown): void {
		const pending = slot.current;
		if (pending === undefined) return;
		if (!isSessionHtmlWorkerMessage(message)) {
			slot.current = undefined;
			pending.reject(new Error(`Session HTML worker returned an invalid message: ${JSON.stringify(message)}`));
			this.discardWorker(slot);
			return;
		}
		if (message.id !== pending.id) {
			slot.current = undefined;
			pending.reject(new Error(`Session HTML worker returned response ${message.id} for request ${pending.id}`));
			this.discardWorker(slot);
			return;
		}
		slot.current = undefined;
		slot.worker.unref();
		if (message.ok) {
			pending.resolve(message.html);
		} else {
			pending.reject(new Error(message.error));
		}
		this.pump();
	}

	private discardWorker(slot: SessionHtmlWorkerSlot, error?: Error): void {
		if (slot.closed) return;
		slot.closed = true;
		const workerIndex = this.workers.indexOf(slot);
		if (workerIndex !== -1) this.workers.splice(workerIndex, 1);
		const pending = slot.current;
		slot.current = undefined;
		if (pending !== undefined) {
			pending.reject(error ?? new Error("Session HTML worker exited before returning a result"));
		}
		void slot.worker.terminate().catch(() => undefined);
		this.pump();
	}
}

const SESSION_HTML_WORKER_POOL_SIZE = Math.max(1, Math.min(2, availableParallelism()));
const sessionHtmlWorkerPool = new SessionHtmlWorkerPool(SESSION_HTML_WORKER_POOL_SIZE);

export async function renderSessionHtml(input: SessionHtmlInput): Promise<string> {
	return await sessionHtmlWorkerPool.render(input);
}

function isSessionHtmlWorkerMessage(value: unknown): value is SessionHtmlWorkerMessage {
	if (typeof value !== "object" || value === null || !("id" in value) || !("ok" in value)) return false;
	if (typeof value.id !== "number" || !Number.isInteger(value.id) || value.id <= 0) return false;
	if (value.ok === true) return "html" in value && typeof value.html === "string";
	if (value.ok === false) return "error" in value && typeof value.error === "string";
	return false;
}
