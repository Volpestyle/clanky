import { test } from "bun:test";
import assert from "node:assert/strict";
import { withDashboardServer } from "../testHelpers.ts";

test("dashboard memory search handles missing params and valid lookups", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, memoryCalls }) => {
    const missing = await fetch(`${baseUrl}/api/memory/search?guildId=guild-1`);
    assert.equal(missing.status, 200);
    const missingJson = await missing.json();
    assert.deepEqual(missingJson.results, []);
    assert.equal(missingJson.limit, 0);

    const found = await fetch(
      `${baseUrl}/api/memory/search?q=launch+plan&guildId=guild-1&channelId=chan-2&limit=4`
    );
    assert.equal(found.status, 200);
    const foundJson = await found.json();
    assert.equal(foundJson.results.length, 1);
    assert.equal(memoryCalls.length, 1);
    assert.equal(memoryCalls[0]?.guildId, "guild-1");
    assert.equal(memoryCalls[0]?.channelId, "chan-2");
    assert.equal(memoryCalls[0]?.queryText, "launch plan");
    assert.equal(memoryCalls[0]?.limit, 4);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard fact profile route returns durable and active voice cache views", async () => {
  const result = await withDashboardServer(
    {
      botOverrides: {
        getRuntimeState() {
          return {
            voice: {
              activeCount: 1,
              sessions: [
                {
                  sessionId: "session-1",
                  guildId: "guild-1",
                  voiceChannelId: "voice-1",
                  textChannelId: "chan-2",
                  participantCount: 2,
                  participants: [
                    { userId: "user-1", displayName: "Alice" },
                    { userId: "user-2", displayName: "Bob" }
                  ],
                  memory: {
                    factProfiles: [
                      {
                        userId: "user-1",
                        displayName: "Alice",
                        loadedAt: "2026-03-08T12:00:00.000Z",
                        userFacts: [
                          {
                            id: 21,
                            subject: "user-1",
                            fact: "Likes ramen.",
                            factType: "preference",
                            confidence: 0.91,
                            updatedAt: "2026-03-08T11:59:00.000Z"
                          }
                        ]
                      }
                    ],
                    guildFactProfile: {
                      loadedAt: "2026-03-08T12:01:00.000Z",
                      selfFacts: [
                        {
                          id: 31,
                          subject: "__self__",
                          fact: "Bot keeps replies concise.",
                          factType: "profile",
                          confidence: 0.88
                        }
                      ],
                      loreFacts: [
                        {
                          id: 32,
                          subject: "__lore__",
                          fact: "Guild hosts Friday game night.",
                          factType: "relationship",
                          confidence: 0.82
                        }
                      ]
                    }
                  }
                }
              ]
            }
          };
        }
      },
      memoryOverrides: {
        loadUserFactProfile() {
          return {
            userFacts: [
              {
                id: 1,
                subject: "user-1",
                fact: "Likes tea.",
                fact_type: "preference",
                confidence: 0.75,
                updated_at: "2026-03-08T11:00:00.000Z"
              }
            ]
          };
        },
        loadGuildFactProfile() {
          return {
            selfFacts: [
              {
                id: 2,
                subject: "__self__",
                fact: "Bot likes short answers.",
                fact_type: "profile",
                confidence: 0.8
              }
            ],
            loreFacts: [
              {
                id: 3,
                subject: "__lore__",
                fact: "Guild prefers late-night sessions.",
                fact_type: "relationship",
                confidence: 0.7
              }
            ]
          };
        }
      }
    },
    async ({ baseUrl, store }) => {
      store.recordMessage({
        messageId: "msg-1",
        guildId: "guild-1",
        channelId: "chan-2",
        authorId: "user-1",
        authorName: "Alice",
        isBot: false,
        content: "We talked about ramen bowls yesterday."
      });

      const response = await fetch(
        `${baseUrl}/api/memory/fact-profile?guildId=guild-1&userId=user-1&channelId=chan-2&queryText=ramen`
      );
      assert.equal(response.status, 200);
      const json = await response.json();

      assert.equal(json.guildId, "guild-1");
      assert.equal(json.userId, "user-1");
      assert.equal(json.durableProfile.userFacts.length, 1);
      assert.equal(json.durableProfile.userFacts[0]?.fact, "Likes tea.");
      assert.equal(json.durableProfile.selfFacts[0]?.fact, "Bot likes short answers.");
      assert.equal(json.durableProfile.loreFacts[0]?.fact, "Guild prefers late-night sessions.");
      assert.equal(json.promptContext.relevantMessages.length, 1);
      assert.equal(json.promptContext.relevantMessages[0]?.content, "We talked about ramen bowls yesterday.");
      assert.equal(json.activeVoiceSession.sessionId, "session-1");
      assert.equal(json.activeVoiceSession.cachedUsers.length, 1);
      assert.equal(json.activeVoiceSession.userFactProfile.userFacts[0]?.fact, "Likes ramen.");
      assert.equal(json.activeVoiceSession.guildFactProfile.selfFacts[0]?.fact, "Bot keeps replies concise.");
      assert.equal(json.activeVoiceSession.guildFactProfile.loreFacts[0]?.fact, "Guild hosts Friday game night.");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard memory fact inspector routes search, edit, remove, and expose audit events", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-2",
      subject: "user-1",
      fact: "Speaker likes old school DS hardware.",
      factType: "preference",
      evidenceText: "Said they were hunting for an old school DS.",
      sourceMessageId: "msg-1",
      confidence: 0.82
    });
    store.addMemoryFact({
      guildId: "guild-1",
      channelId: "chan-3",
      subject: "user-2",
      fact: "Speaker likes tea.",
      factType: "preference",
      evidenceText: "Talked about tea.",
      sourceMessageId: "msg-2",
      confidence: 0.61
    });

    const searched = await fetch(
      `${baseUrl}/api/memory/facts?guildId=guild-1&subject=user-1&q=old+school+ds&limit=10`
    );
    assert.equal(searched.status, 200);
    const searchedJson = await searched.json();
    assert.equal(Array.isArray(searchedJson.facts), true);
    assert.equal(searchedJson.facts.length, 1);
    assert.equal(searchedJson.facts[0]?.fact, "Speaker likes old school DS hardware.");
    const factId = Number(searchedJson.facts[0]?.id);
    assert.equal(Number.isInteger(factId), true);

    const updated = await fetch(`${baseUrl}/api/memory/facts/${factId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        subject: "user-1",
        factType: "profile",
        fact: "Speaker collects old school DS hardware and games.",
        evidenceText: "Dashboard correction after audit.",
        confidence: 0.93
      })
    });
    assert.equal(updated.status, 200);
    const updatedJson = await updated.json();
    assert.equal(updatedJson.ok, true);
    assert.equal(updatedJson.fact.fact, "Speaker collects old school DS hardware and games.");
    assert.equal(updatedJson.fact.factType, "profile");

    const removed = await fetch(`${baseUrl}/api/memory/facts/${factId}/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        removalReason: "User said to clear stale memory."
      })
    });
    assert.equal(removed.status, 200);
    const removedJson = await removed.json();
    assert.equal(removedJson.ok, true);
    assert.equal(removedJson.factId, factId);

    const afterRemove = await fetch(`${baseUrl}/api/memory/facts?guildId=guild-1&subject=user-1&limit=10`);
    assert.equal(afterRemove.status, 200);
    const afterRemoveJson = await afterRemove.json();
    assert.deepEqual(afterRemoveJson.facts, []);

    const audit = await fetch(`${baseUrl}/api/memory/facts/audit?guildId=guild-1&factId=${factId}&limit=10`);
    assert.equal(audit.status, 200);
    const auditJson = await audit.json();
    assert.equal(Array.isArray(auditJson.events), true);
    assert.equal(auditJson.events.length, 2);
    assert.deepEqual(
      auditJson.events.map((event) => event.eventType),
      ["removed", "updated"]
    );
    assert.equal(auditJson.events[0]?.removalReason, "User said to clear stale memory.");
    assert.equal(
      auditJson.events[1]?.nextFact,
      "Speaker collects old school DS hardware and games."
    );
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard shell finalizes HEAD requests for non-API routes", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(baseUrl, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=UTF-8");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard adaptive directive routes add, edit, remove, and expose audit history", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const emptyNotes = await fetch(`${baseUrl}/api/memory/adaptive-directives?guildId=guild-1`);
    assert.equal(emptyNotes.status, 200);
    const emptyNotesJson = await emptyNotes.json();
    assert.deepEqual(emptyNotesJson.notes, []);

    const added = await fetch(`${baseUrl}/api/memory/adaptive-directives`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        directiveKind: "behavior",
        noteText: "Use \"type shit\" occasionally in casual replies."
      })
    });
    assert.equal(added.status, 200);
    const addedJson = await added.json();
    assert.equal(addedJson.ok, true);
    assert.equal(addedJson.status, "added");
    const noteId = Number(addedJson.note?.id);
    assert.equal(Number.isInteger(noteId), true);

    const updated = await fetch(`${baseUrl}/api/memory/adaptive-directives/${noteId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        directiveKind: "guidance",
        noteText: "Use \"type shit\" occasionally in casual replies. Keep it natural and not every message."
      })
    });
    assert.equal(updated.status, 200);
    const updatedJson = await updated.json();
    assert.equal(updatedJson.ok, true);
    assert.equal(updatedJson.status, "edited");

    const listed = await fetch(`${baseUrl}/api/memory/adaptive-directives?guildId=guild-1`);
    assert.equal(listed.status, 200);
    const listedJson = await listed.json();
    assert.equal(Array.isArray(listedJson.notes), true);
    assert.equal(listedJson.notes.length, 1);
    assert.equal(listedJson.notes[0]?.directiveKind, "guidance");
    assert.equal(String(listedJson.notes[0]?.noteText).includes("Keep it natural"), true);

    const removed = await fetch(`${baseUrl}/api/memory/adaptive-directives/${noteId}/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        removalReason: "user asked to stop"
      })
    });
    assert.equal(removed.status, 200);
    const removedJson = await removed.json();
    assert.equal(removedJson.ok, true);
    assert.equal(removedJson.status, "removed");

    const afterRemove = await fetch(`${baseUrl}/api/memory/adaptive-directives?guildId=guild-1`);
    const afterRemoveJson = await afterRemove.json();
    assert.deepEqual(afterRemoveJson.notes, []);

    const audit = await fetch(`${baseUrl}/api/memory/adaptive-directives/audit?guildId=guild-1&limit=10`);
    assert.equal(audit.status, 200);
    const auditJson = await audit.json();
    assert.equal(Array.isArray(auditJson.events), true);
    assert.equal(auditJson.events.length, 3);
    assert.deepEqual(
      auditJson.events.map((event) => event.eventType),
      ["removed", "edited", "added"]
    );
    assert.equal(auditJson.events[1]?.directiveKind, "guidance");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard memory reflections returns recent reflection runs with extracted and saved facts", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.logAction({
      kind: "memory_reflection_start",
      guildId: "guild-1",
      content: "Reflecting on 2026-03-03 guild:guild-1 via anthropic:claude-haiku-4-5",
      metadata: {
        runId: "reflection_run_1",
        dateKey: "2026-03-03",
        guildId: "guild-1",
        strategy: "two_pass_extract_then_main",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        extractorProvider: "anthropic",
        extractorModel: "claude-haiku-4-5",
        adjudicatorProvider: "anthropic",
        adjudicatorModel: "claude-sonnet-4-6",
        journalEntryCount: 14,
        authorCount: 3,
        maxFacts: 20
      }
    });
    store.logAction({
      kind: "memory_reflection_complete",
      guildId: "guild-1",
      content: "Completed reflection for 2026-03-03 guild:guild-1, added 1 facts.",
      usdCost: 0.0018,
      metadata: {
        runId: "reflection_run_1",
        dateKey: "2026-03-03",
        guildId: "guild-1",
        strategy: "two_pass_extract_then_main",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        extractorProvider: "anthropic",
        extractorModel: "claude-haiku-4-5",
        adjudicatorProvider: "anthropic",
        adjudicatorModel: "claude-sonnet-4-6",
        journalEntryCount: 14,
        authorCount: 3,
        maxFacts: 20,
        factsExtracted: 3,
        factsSelected: 1,
        factsAdded: 1,
        factsSaved: 1,
        factsSkipped: 2,
        rawResponseText:
          "{\"facts\":[{\"subject\":\"author\",\"subjectName\":\"alice\",\"fact\":\"likes rust\",\"type\":\"preference\",\"confidence\":0.88,\"evidence\":\"I love Rust\"}]}",
        extractedFacts: [
          { subject: "author", subjectName: "alice", fact: "likes rust", type: "preference", confidence: 0.88, evidence: "I love Rust" }
        ],
        selectedFacts: [
          { subject: "author", subjectName: "alice", fact: "likes rust", type: "preference", confidence: 0.88, evidence: "I love Rust" }
        ],
        savedFacts: [
          {
            subject: "author",
            subjectName: "alice",
            fact: "likes rust",
            type: "preference",
            confidence: 0.88,
            evidence: "I love Rust",
            scope: "user",
            subjectOverride: "user-1",
            userId: "user-1",
            status: "saved",
            saveReason: "added_new",
            storedFact: "Preference: likes rust.",
            storedSubject: "user-1"
          }
        ],
        skippedFacts: [
          {
            subject: "author",
            subjectName: "bob",
            fact: "works at acme",
            type: "profile",
            confidence: 0.61,
            evidence: "I work at Acme",
            scope: "user",
            subjectOverride: null,
            userId: null,
            status: "skipped",
            saveReason: "unresolved_author_subject",
            storedFact: null,
            storedSubject: null
          }
        ]
      }
    });

    const response = await fetch(`${baseUrl}/api/memory/reflections?limit=5`);
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(Array.isArray(json.runs), true);
    assert.equal(json.runs.length, 1);
    assert.equal(json.runs[0]?.dateKey, "2026-03-03");
    assert.equal(json.runs[0]?.status, "completed");
    assert.equal(json.runs[0]?.factsExtracted, 3);
    assert.equal(json.runs[0]?.factsSelected, 1);
    assert.equal(json.runs[0]?.factsAdded, 1);
    assert.equal(json.runs[0]?.strategy, "two_pass_extract_then_main");
    assert.equal(json.runs[0]?.extractorModel, "claude-haiku-4-5");
    assert.equal(json.runs[0]?.savedFacts.length, 1);
    assert.equal(json.runs[0]?.selectedFacts.length, 1);
    assert.equal(json.runs[0]?.skippedFacts.length, 1);
    assert.equal(typeof json.runs[0]?.rawResponseText, "string");
    assert.equal(json.runs[0]?.savedFacts[0]?.saveReason, "added_new");
    assert.equal(json.runs[0]?.skippedFacts[0]?.saveReason, "unresolved_author_subject");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard memory reflection rerun forwards date and guild to memory manager", async () => {
  const rerunCalls = [];
  const result = await withDashboardServer(
    {
      memoryOverrides: {
        async rerunDailyReflection(payload) {
          rerunCalls.push(payload);
          return true;
        }
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/memory/reflections/rerun`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          dateKey: "2026-03-03",
          guildId: "guild-1"
        })
      });
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.ok, true);
      assert.equal(rerunCalls.length, 1);
      assert.equal(rerunCalls[0]?.dateKey, "2026-03-03");
      assert.equal(rerunCalls[0]?.guildId, "guild-1");
      assert.equal(typeof rerunCalls[0]?.settings, "object");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard automations and share-session routes validate params and unavailable manager states", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.createAutomation({
      guildId: "guild-1",
      channelId: "chan-1",
      createdByUserId: "user-1",
      createdByName: "alice",
      title: "daily post",
      instruction: "post summary",
      schedule: { kind: "interval", everyMinutes: 15 },
      nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString()
    });

    const missingGuild = await fetch(`${baseUrl}/api/automations`);
    assert.equal(missingGuild.status, 400);

    const list = await fetch(`${baseUrl}/api/automations?guildId=guild-1&status=active,paused&q=daily`);
    assert.equal(list.status, 200);
    const listJson = await list.json();
    assert.equal(Array.isArray(listJson.rows), true);
    assert.equal(listJson.rows.length, 1);

    const invalidRuns = await fetch(`${baseUrl}/api/automations/runs?guildId=guild-1&automationId=0`);
    assert.equal(invalidRuns.status, 400);

    const shareCreate = await fetch(`${baseUrl}/api/voice/share-session`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        channelId: "chan-1",
        requesterUserId: "user-1"
      })
    });
    assert.equal(shareCreate.status, 503);

    const shareFrame = await fetch(`${baseUrl}/api/voice/share-session/token1234567890/frame`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mimeType: "image/jpeg",
        dataBase64: "abc"
      })
    });
    assert.equal(shareFrame.status, 503);

    const shareStop = await fetch(`${baseUrl}/api/voice/share-session/token1234567890/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: "manual" })
    });
    assert.equal(shareStop.status, 503);

    const sharePage = await fetch(`${baseUrl}/share/token1234567890`);
    assert.equal(sharePage.status, 503);
    const shareText = await sharePage.text();
    assert.equal(shareText.includes("Screen share link unavailable"), true);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard public tunnel and public API token gates are enforced", async () => {
  const result = await withDashboardServer(
    {
      appConfigOverrides: {
        dashboardToken: "dash-token",
        publicApiToken: "public-token"
      },
      publicHttpsState: {
        enabled: true,
        publicUrl: "https://fancy-cat.trycloudflare.com"
      }
    },
    async ({ baseUrl, ingestCalls }) => {
      const blockedSettings = await fetch(`${baseUrl}/api/settings`, {
        headers: {
          "x-forwarded-host": "fancy-cat.trycloudflare.com"
        }
      });
      assert.equal(blockedSettings.status, 404);

      const wrongPublicToken = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-public-api-token": "wrong"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          dataBase64: "abc"
        })
      });
      assert.equal(wrongPublicToken.status, 401);
      const wrongPublicJson = await wrongPublicToken.json();
      assert.equal(wrongPublicJson.reason, "unauthorized_public_api_token");

      const okPublicToken = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-public-api-token": "public-token"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          streamerUserId: "user-7",
          mimeType: "image/jpeg",
          dataBase64: "abc123"
        })
      });
      assert.equal(okPublicToken.status, 200);
      const okPublicJson = await okPublicToken.json();
      assert.equal(okPublicJson.accepted, true);
      assert.equal(ingestCalls.length, 1);
      assert.equal(ingestCalls[0]?.guildId, "guild-1");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard public ingest requires at least one dashboard/public token", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/voice/stream-ingest/frame`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1",
        dataBase64: "frame"
      })
    });

    assert.equal(response.status, 503);
    const json = await response.json();
    assert.equal(json.reason, "dashboard_or_public_api_token_required");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard voice join returns unavailable when bot does not expose join helper", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/voice/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        guildId: "guild-1"
      })
    });

    assert.equal(response.status, 503);
    const json = await response.json();
    assert.equal(json.ok, false);
    assert.equal(json.reason, "voice_join_unavailable");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings refresh reapplies runtime settings and reports active sessions", async () => {
  const applyCalls = [];
  const result = await withDashboardServer(
    {
      botOverrides: {
        async applyRuntimeSettings(settings) {
          applyCalls.push(settings);
        },
        getRuntimeState() {
          return {
            connected: true,
            replyQueuePending: 0,
            voice: {
              activeCount: 2
            }
          };
        }
      }
    },
    async ({ baseUrl, store }) => {
      const response = await fetch(`${baseUrl}/api/settings/refresh`, {
        method: "POST"
      });
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.ok, true);
      assert.equal(json.reason, "settings_refreshed");
      assert.equal(json.activeVoiceSessions, 2);
      assert.equal(applyCalls.length, 1);
      assert.deepEqual(applyCalls[0], store.getSettings());
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard preset defaults preserve the claude oauth voice admission mode", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/settings/preset-defaults`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        preset: "claude_oauth"
      })
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.voiceReplyDecisionRealtimeAdmissionMode, "generation_decides");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings expose realtime provider selection alongside file_wav override settings", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.patchSettings({
      agentStack: {
        runtimeConfig: {
          voice: {
            runtimeMode: "openai_realtime",
            openaiRealtime: {
              transcriptionMethod: "file_wav"
            }
          }
        }
      }
    });

    const response = await fetch(`${baseUrl}/api/settings`);
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json._resolved?.voiceProvider, "openai");
    assert.equal(json.agentStack?.runtimeConfig?.voice?.openaiRealtime?.transcriptionMethod, "file_wav");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings refresh returns unavailable when bot runtime apply is missing", async () => {
  const result = await withDashboardServer(
    {
      botOverrides: {
        applyRuntimeSettings: null
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings/refresh`, {
        method: "POST"
      });
      assert.equal(response.status, 503);
      const json = await response.json();
      assert.equal(json.ok, false);
      assert.equal(json.reason, "settings_refresh_unavailable");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard voice join forwards payload to bot helper", async () => {
  const joinCalls = [];
  const result = await withDashboardServer(
    {
      botOverrides: {
        async requestVoiceJoinFromDashboard(payload) {
          joinCalls.push(payload);
          return {
            ok: true,
            reason: "joined",
            guildId: payload.guildId || "guild-1",
            voiceChannelId: "voice-1",
            textChannelId: "text-1",
            requesterUserId: payload.requesterUserId || "user-1"
          };
        }
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/voice/join`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          guildId: "guild-99",
          requesterUserId: "user-42",
          textChannelId: "chan-77",
          source: "test_case"
        })
      });

      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.ok, true);
      assert.equal(json.reason, "joined");
      assert.equal(joinCalls.length, 1);
      assert.equal(joinCalls[0]?.guildId, "guild-99");
      assert.equal(joinCalls[0]?.requesterUserId, "user-42");
      assert.equal(joinCalls[0]?.textChannelId, "chan-77");
      assert.equal(joinCalls[0]?.source, "test_case");
    }
  );

  if (result?.skipped) {
    return;
  }
});
