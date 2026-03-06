import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  classifyApiAccessPath,
  isAllowedPublicApiPath,
  isPublicSessionTokenApiPath
} from "./publicIngressAccess.ts";

const SHARE_TOKEN = "token1234567890ab";

test("classifyApiAccessPath allows only tokenized share-session frame/stop routes", () => {
  assert.equal(classifyApiAccessPath("/voice/stream-ingest/frame"), "public_header_token");
  assert.equal(classifyApiAccessPath("/voice/stream-ingest/frame/"), "public_header_token");

  assert.equal(
    classifyApiAccessPath(`/voice/share-session/${SHARE_TOKEN}/frame`),
    "public_session_token"
  );
  assert.equal(
    classifyApiAccessPath(`/voice/share-session/${SHARE_TOKEN}/stop`),
    "public_session_token"
  );

  assert.equal(
    classifyApiAccessPath(`/voice/share-session/${SHARE_TOKEN}`),
    "private"
  );
  assert.equal(
    classifyApiAccessPath(`/voice/share-session/${SHARE_TOKEN}/status`),
    "private"
  );
});

test("isAllowedPublicApiPath and isPublicSessionTokenApiPath match tightened token rules", () => {
  assert.equal(isAllowedPublicApiPath(`/voice/share-session/${SHARE_TOKEN}/frame`), true);
  assert.equal(isAllowedPublicApiPath(`/voice/share-session/${SHARE_TOKEN}`), false);

  assert.equal(isPublicSessionTokenApiPath(`/voice/share-session/${SHARE_TOKEN}/stop`), true);
  assert.equal(isPublicSessionTokenApiPath(`/voice/share-session/${SHARE_TOKEN}`), false);
});
