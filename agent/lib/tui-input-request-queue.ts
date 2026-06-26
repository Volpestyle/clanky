import type { InputRequest } from "eve/client";

export class InputRequestQueue {
	private readonly requestsById = new Map<string, InputRequest>();

	add(requests: readonly InputRequest[]): void {
		for (const request of requests) {
			this.requestsById.set(request.requestId, request);
		}
	}

	get size(): number {
		return this.requestsById.size;
	}

	drain(): InputRequest[] {
		const requests = [...this.requestsById.values()];
		this.requestsById.clear();
		return requests;
	}
}
