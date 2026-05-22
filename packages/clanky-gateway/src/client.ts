import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { GatewayMethod, GatewayResponse } from "./protocol.ts";

export interface RequestGatewayOptions {
	socketFile: string;
	method: GatewayMethod;
	params?: unknown;
	timeoutMs?: number;
}

export async function requestGateway(options: RequestGatewayOptions): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const id = randomUUID();

	return await new Promise<unknown>((resolve, reject) => {
		const socket = createConnection(options.socketFile);
		let buffer = "";
		let settled = false;
		const timeout = setTimeout(() => {
			finish(new Error(`Timed out waiting for clanky daemon after ${timeoutMs}ms`));
		}, timeoutMs);

		const finish = (error: Error | undefined, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		};

		socket.on("connect", () => {
			const payload = JSON.stringify({ id, method: options.method, params: options.params });
			socket.write(`${payload}\n`);
		});

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			const line = buffer.slice(0, newlineIndex);
			try {
				const response = JSON.parse(line) as GatewayResponse;
				if (response.id !== id) {
					finish(new Error("Received mismatched response id from clanky daemon"));
					return;
				}
				if (!response.ok) {
					finish(new Error(response.error));
					return;
				}
				finish(undefined, response.result);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});

		socket.on("error", (error) => {
			finish(error);
		});
	});
}
