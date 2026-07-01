/**
 * Serial async executor for voice lifecycle ops. Concurrent joinVoice calls
 * (voice WS op racing the gateway "hop in vc" intent) would each spawn a
 * ClankVox process and orphan one live speaking session; running join/leave
 * through one queue makes the second caller wait for (and observe) the first.
 */
export interface SerialOpQueue {
	run<T>(op: () => Promise<T>): Promise<T>;
}

export function createSerialOpQueue(): SerialOpQueue {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		run<T>(op: () => Promise<T>): Promise<T> {
			const next = tail.then(op, op);
			tail = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		},
	};
}
