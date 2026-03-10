import { test } from "bun:test";
import assert from "node:assert/strict";
import { SentenceAccumulator } from "./sentenceAccumulator.ts";

test("SentenceAccumulator emits the first chunk eagerly after punctuation once threshold is met", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: true,
    eagerMinChars: 20,
    maxBufferChars: 120,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("Let me check that out for you. ");
  accumulator.push("I want one more sentence.");

  assert.equal(emitted[0], "Let me check that out for you.");
});

test("SentenceAccumulator keeps the first chunk intact until sentence punctuation arrives", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: true,
    eagerMinChars: 30,
    maxBufferChars: 120,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("Yo donky, what's good my guy, we back in the ");
  assert.deepEqual(emitted, []);

  accumulator.push("vc!");
  assert.deepEqual(emitted, ["Yo donky, what's good my guy, we back in the vc!"]);
});

test("SentenceAccumulator waits for a sentence break after the first emitted chunk", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: true,
    eagerMinChars: 10,
    maxBufferChars: 120,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("First sentence. Second");
  accumulator.push(" sentence is still coming");
  assert.deepEqual(emitted, ["First sentence."]);

  accumulator.push(" through now.");
  assert.deepEqual(emitted, ["First sentence.", "Second sentence is still coming through now."]);
});

test("SentenceAccumulator does not split the first chunk on an internal word boundary without a clean ending", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: true,
    eagerMinChars: 16,
    maxBufferChars: 120,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("yo vuhlp, what's good");
  assert.deepEqual(emitted, []);

  accumulator.flush();
  assert.deepEqual(emitted, ["yo vuhlp, what's good"]);
});

test("SentenceAccumulator flush emits trailing text without punctuation", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("still thinking about");
  accumulator.push(" the ending");
  accumulator.flush();

  assert.deepEqual(emitted, ["still thinking about the ending"]);
});

test("SentenceAccumulator forces a chunk when the buffer grows too large", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: false,
    maxBufferChars: 30,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("this sentence has no punctuation but should still break eventually because it is long");

  assert.equal(emitted.length > 0, true);
  assert.equal(emitted[0].length <= 30, true);
  assert.equal(emitted.join(" ").includes("this sentence has no punctuation"), true);
});

test("SentenceAccumulator does not split on the colon inside an inline soundboard directive", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: true,
    eagerMinChars: 10,
    maxBufferChars: 120,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("First sentence. ");
  assert.deepEqual(emitted, ["First sentence."]);

  accumulator.push("[[SOUNDBOARD:airhorn@123]] hold that thought.");
  assert.deepEqual(emitted, ["First sentence.", "[[SOUNDBOARD:airhorn@123]] hold that thought."]);
});

test("SentenceAccumulator does not force-break inside an inline soundboard directive", () => {
  const emitted: string[] = [];
  const accumulator = new SentenceAccumulator({
    eagerFirstChunk: false,
    maxBufferChars: 24,
    onSentence(text) {
      emitted.push(text);
    }
  });

  accumulator.push("lead [[SOUNDBOARD:airhorn@123]] tail");
  accumulator.flush();

  assert.equal(
    emitted.some((chunk) => chunk.includes("[[SOUNDBOARD:") && !chunk.includes("]]")),
    false
  );
});
