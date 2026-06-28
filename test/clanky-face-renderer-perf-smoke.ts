import { performance } from "node:perf_hooks";
import type { HandleMessageStreamEvent } from "eve/client";
import {
	ClankyFaceRenderer,
	type FaceBlockHandle,
	type FaceBlockOptions,
	type FaceRenderSink,
} from "../agent/lib/clanky-face-renderer.ts";

const STREAM_EVENT_COUNT = 1_000;
const MAX_MARKDOWN_UPDATES_PER_STREAM = 2;
const MAX_SCENARIO_MS = 750;

type RenderCounts = {
	insertedBlocks: number;
	markdownUpdates: number;
	statusUpdates: number;
	loaderUpdates: number;
};

class CountingBlock implements FaceBlockHandle {
	markdown: string;
	readonly options: FaceBlockOptions | undefined;
	private readonly counts: RenderCounts;

	constructor(markdown: string, counts: RenderCounts, options?: FaceBlockOptions) {
		this.markdown = markdown;
		this.counts = counts;
		this.options = options;
	}

	setMarkdown(markdown: string): void {
		this.markdown = markdown;
		this.counts.markdownUpdates += 1;
	}
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function createCountingSink(): { counts: RenderCounts; sink: FaceRenderSink } {
	const counts: RenderCounts = {
		insertedBlocks: 0,
		loaderUpdates: 0,
		markdownUpdates: 0,
		statusUpdates: 0,
	};
	return {
		counts,
		sink: {
			insertMarkdown(markdown: string, options?: FaceBlockOptions): FaceBlockHandle {
				counts.insertedBlocks += 1;
				return new CountingBlock(markdown, counts, options);
			},
			setLoaderMessage(): void {
				counts.loaderUpdates += 1;
			},
			setStatus(): void {
				counts.statusUpdates += 1;
			},
		},
	};
}

function assistantStreamEvent(index: number): HandleMessageStreamEvent {
	const text = "x".repeat(index + 1);
	return {
		type: "message.appended",
		data: {
			messageDelta: "x",
			messageSoFar: text,
			sequence: index + 1,
			stepIndex: 0,
			turnId: "assistant-turn",
		},
	};
}

function subagentStreamEvent(index: number): HandleMessageStreamEvent {
	const text = "x".repeat(index + 1);
	return {
		type: "subagent.event",
		data: {
			callId: "sub-1",
			event: {
				type: "message.appended",
				data: {
					messageDelta: "x",
					messageSoFar: text,
					sequence: index + 2,
					stepIndex: 0,
					turnId: "child-turn",
				},
			},
			subagentName: "Planner",
		},
	};
}

function turnCompleted(sequence: number): HandleMessageStreamEvent {
	return { type: "turn.completed", data: { sequence, turnId: "assistant-turn" } };
}

function runScenario(name: string, render: (renderer: ClankyFaceRenderer) => void): RenderCounts & { elapsedMs: number; name: string } {
	const { counts, sink } = createCountingSink();
	const renderer = new ClankyFaceRenderer(sink);
	const startedAt = performance.now();
	render(renderer);
	const elapsedMs = performance.now() - startedAt;
	return { ...counts, elapsedMs, name };
}

const assistant = runScenario("assistant stream", (renderer) => {
	for (let index = 0; index < STREAM_EVENT_COUNT; index += 1) renderer.renderEvent(assistantStreamEvent(index));
	renderer.renderEvent(turnCompleted(STREAM_EVENT_COUNT + 1));
});

const subagent = runScenario("subagent stream", (renderer) => {
	renderer.renderEvent({
		type: "subagent.called",
		data: {
			callId: "sub-1",
			childSessionId: "child-session",
			name: "Planner",
			sequence: 1,
			sessionId: "parent-session",
			toolName: "planner",
			turnId: "parent-turn",
			workflowId: "workflow-1",
		},
	});
	for (let index = 0; index < STREAM_EVENT_COUNT; index += 1) renderer.renderEvent(subagentStreamEvent(index));
	renderer.renderEvent(turnCompleted(STREAM_EVENT_COUNT + 2));
});

for (const result of [assistant, subagent]) {
	assert(
		result.markdownUpdates <= MAX_MARKDOWN_UPDATES_PER_STREAM,
		`${result.name} should flush at most ${MAX_MARKDOWN_UPDATES_PER_STREAM} markdown updates for ${STREAM_EVENT_COUNT} stream events; got ${result.markdownUpdates}`,
	);
	assert(
		result.elapsedMs < MAX_SCENARIO_MS,
		`${result.name} should render ${STREAM_EVENT_COUNT} synthetic stream events under ${MAX_SCENARIO_MS}ms; got ${result.elapsedMs.toFixed(1)}ms`,
	);
}

console.log(
	`clanky-face-renderer-perf-smoke: ok (${assistant.name}: ${assistant.markdownUpdates} updates, ${assistant.elapsedMs.toFixed(1)}ms; ${subagent.name}: ${subagent.markdownUpdates} updates, ${subagent.elapsedMs.toFixed(1)}ms)`,
);
