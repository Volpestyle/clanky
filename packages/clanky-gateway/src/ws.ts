import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";

export type GatewayEvent =
	| {
			type: "session.started";
			timestamp: string;
			sessionId: string;
			sessionFile?: string;
	  }
	| {
			type: "session.text_delta";
			timestamp: string;
			sessionId: string;
			delta: string;
	  }
	| {
			type: "session.completed";
			timestamp: string;
			sessionId: string;
	  }
	| {
			type: "session.error";
			timestamp: string;
			sessionId?: string;
			error: string;
	  }
	| {
			type: "cron.changed";
			timestamp: string;
			action: "add" | "remove" | "enable" | "disable";
			jobId?: string;
	  }
	| {
			type: "cron.ran";
			timestamp: string;
			jobId: string;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "cron.fired";
			timestamp: string;
			jobId: string;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "messaging.received";
			timestamp: string;
			platform: "telegram" | "discord";
			chatId: string;
			threadId?: string;
			userId: string;
			sessionId: string;
			text: string;
			command?: string;
	  }
	| {
			type: "messaging.sent";
			timestamp: string;
			platform: "telegram" | "discord";
			chatId: string;
			threadId?: string;
			sessionId: string;
			messageIds: string[];
			chunks: number;
			floodFallback: boolean;
			durationMs: number;
	  }
	| {
			type: "messaging.error";
			timestamp: string;
			platform: "telegram" | "discord";
			chatId: string;
			sessionId?: string;
			error: string;
	  }
	| {
			type: "messaging.policy";
			timestamp: string;
			platform: "telegram" | "discord";
			chatId: string;
			userId: string;
			decision: string;
			reason?: string;
	  };

type WithoutTimestamp<T> = T extends unknown ? Omit<T, "timestamp"> : never;

export type GatewayEventInput = WithoutTimestamp<GatewayEvent>;

export interface GatewayEventSubscription {
	sessionId?: string;
}

interface GatewayEventClient {
	socket: WSContext<WebSocket>;
	subscription: GatewayEventSubscription;
}

export class GatewayEventHub {
	private readonly clients = new Map<WSContext<WebSocket>, GatewayEventClient>();

	subscribe(client: WSContext<WebSocket>, subscription: GatewayEventSubscription = {}): () => void {
		this.clients.set(client, { socket: client, subscription });
		client.send(
			JSON.stringify({
				type: "connected",
				timestamp: new Date().toISOString(),
			}),
		);
		return () => {
			this.clients.delete(client);
		};
	}

	publish(event: GatewayEvent): void {
		const events = [event, ...gatewayCompatibilityEvents(event)];
		for (const client of this.clients.values()) {
			if (client.socket.readyState !== 1) {
				this.clients.delete(client.socket);
				continue;
			}
			for (const item of events) {
				if (!shouldSendEvent(item, client.subscription)) continue;
				try {
					client.socket.send(JSON.stringify(item));
				} catch {
					this.clients.delete(client.socket);
					break;
				}
			}
		}
	}

	close(): void {
		for (const client of this.clients.values()) {
			client.socket.close();
		}
		this.clients.clear();
	}
}

export function gatewayEvent(event: GatewayEventInput): GatewayEvent {
	return {
		...event,
		timestamp: new Date().toISOString(),
	} as unknown as GatewayEvent;
}

function gatewayCompatibilityEvents(event: GatewayEvent): GatewayEvent[] {
	if (event.type === "cron.ran") {
		const fired: GatewayEvent = {
			...event,
			type: "cron.fired",
		};
		return [fired];
	}
	return [];
}

function shouldSendEvent(event: GatewayEvent, subscription: GatewayEventSubscription): boolean {
	if (subscription.sessionId === undefined) return true;
	if (!("sessionId" in event)) return true;
	return event.sessionId === undefined || event.sessionId === subscription.sessionId;
}
