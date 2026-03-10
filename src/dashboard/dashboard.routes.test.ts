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
      assert.equal(json.promptContext.recentConversationHistory.length, 1);
      assert.equal(
        json.promptContext.recentConversationHistory[0]?.messages?.[0]?.content,
        "We talked about ramen bowls yesterday."
      );
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

test("dashboard runtime snapshot route returns the real turn-scoped memory slice", async () => {
  const factProfileCalls: unknown[] = [];
  const behavioralCalls: unknown[] = [];

  const result = await withDashboardServer(
    {
      botOverrides: {
        getRuntimeState() {
          return {
            voice: {
              activeCount: 1,
              sessions: [
                {
                  sessionId: "session-9",
                  guildId: "guild-1",
                  voiceChannelId: "voice-9",
                  textChannelId: "chan-9",
                  participantCount: 2,
                  participants: [
                    { userId: "user-1", displayName: "Alice" },
                    { userId: "user-2", displayName: "Bob" }
                  ]
                }
              ]
            }
          };
        }
      },
      memoryOverrides: {
        loadFactProfile(payload) {
          factProfileCalls.push(payload);
          return {
            participantProfiles: [
              {
                userId: "user-1",
                displayName: "Alice",
                isPrimary: true,
                facts: [
                  {
                    id: 11,
                    subject: "user-1",
                    fact: "Likes ramen.",
                    fact_type: "preference",
                    confidence: 0.94,
                    updated_at: "2026-03-08T11:00:00.000Z"
                  }
                ]
              },
              {
                userId: "user-2",
                displayName: "Bob",
                isPrimary: false,
                facts: [
                  {
                    id: 12,
                    subject: "user-2",
                    fact: "Knows the best ramen spot.",
                    fact_type: "relationship",
                    confidence: 0.78
                  }
                ]
              }
            ],
            userFacts: [
              {
                id: 21,
                subject: "user-1",
                fact: "Likes ramen.",
                fact_type: "preference",
                confidence: 0.94
              }
            ],
            relevantFacts: [
              {
                id: 22,
                subject: "user-2",
                fact: "Knows the best ramen spot.",
                fact_type: "relationship",
                confidence: 0.78
              }
            ],
            selfFacts: [
              {
                id: 23,
                subject: "__self__",
                fact: "Bot keeps replies concise.",
                fact_type: "profile",
                confidence: 0.81
              }
            ],
            loreFacts: [
              {
                id: 24,
                subject: "__lore__",
                fact: "Guild loves late-night food talk.",
                fact_type: "other",
                confidence: 0.69
              }
            ],
            guidanceFacts: [
              {
                id: 25,
                subject: "__lore__",
                fact: "Keep food recommendations practical.",
                fact_type: "guidance",
                confidence: 0.88
              }
            ]
          };
        },
        async loadBehavioralFactsForPrompt(payload) {
          behavioralCalls.push(payload);
          return [
            {
              id: 31,
              subject: "__lore__",
              fact: "Suggest ramen spots when people ask for food recommendations.",
              fact_type: "behavioral",
              confidence: 0.84
            }
          ];
        },
        async searchConversationHistory() {
          return [
            {
              anchorMessageId: "msg-7",
              createdAt: "2026-03-08T12:00:00.000Z",
              score: 0.92,
              semanticScore: 0.88,
              ageMinutes: 35,
              messages: [
                {
                  message_id: "msg-7",
                  created_at: "2026-03-08T12:00:00.000Z",
                  author_name: "Alice",
                  content: "We were comparing ramen spots downtown."
                }
              ]
            }
          ];
        }
      }
    },
    async ({ baseUrl, store }) => {
      store.recordLookupContext({
        guildId: "guild-1",
        channelId: "chan-9",
        userId: "user-1",
        source: "web_search",
        query: "best ramen downtown",
        provider: "brave",
        results: [
          {
            title: "Ramen Index",
            url: "https://ramen.example.com",
            domain: "ramen.example.com"
          }
        ]
      });

      const response = await fetch(`${baseUrl}/api/memory/runtime-snapshot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          channelId: "chan-9",
          userId: "user-1",
          queryText: "best ramen downtown",
          mode: "voice"
        })
      });
      assert.equal(response.status, 200);
      const json = await response.json();

      assert.equal(json.mode, "voice");
      assert.equal(json.participants.length, 2);
      assert.equal(json.participants[0]?.userId, "user-1");
      assert.equal(json.participants[1]?.userId, "user-2");
      assert.equal(json.slice.participantProfiles.length, 2);
      assert.equal(json.slice.userFacts[0]?.fact, "Likes ramen.");
      assert.equal(json.slice.relevantFacts[0]?.fact, "Knows the best ramen spot.");
      assert.equal(json.slice.guidanceFacts[0]?.fact, "Keep food recommendations practical.");
      assert.equal(
        json.slice.behavioralFacts[0]?.fact,
        "Suggest ramen spots when people ask for food recommendations."
      );
      assert.equal(
        json.promptContext.recentConversationHistory[0]?.messages?.[0]?.content,
        "We were comparing ramen spots downtown."
      );
      assert.equal(json.promptContext.recentWebLookups[0]?.query, "best ramen downtown");
      assert.equal(json.activeVoiceSession.sessionId, "session-9");
      assert.deepEqual(factProfileCalls[0]?.participantIds, ["user-1", "user-2"]);
      assert.deepEqual(behavioralCalls[0]?.participantIds, ["user-1", "user-2"]);
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard memory fact inspector routes list subjects and facts", async () => {
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

    const subjects = await fetch(`${baseUrl}/api/memory/subjects?guildId=guild-1&limit=10`);
    assert.equal(subjects.status, 200);
    const subjectsJson = await subjects.json();
    assert.equal(Array.isArray(subjectsJson.subjects), true);
    assert.equal(subjectsJson.subjects.length >= 2, true);
    assert.equal(subjectsJson.subjects.some((entry) => entry.subject === "user-1"), true);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard memory fact inspector can update and delete facts", async () => {
  let refreshCalls = 0;

  const result = await withDashboardServer(
    {
      memoryOverrides: {
        async refreshMemoryMarkdown() {
          refreshCalls += 1;
          return true;
        }
      }
    },
    async ({ baseUrl, store }) => {
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

      const initialFact = store.getFactsForScope({
        guildId: "guild-1",
        limit: 10,
        subjectIds: ["user-1"]
      })[0];
      assert.ok(initialFact);

      const updateResponse = await fetch(`${baseUrl}/api/memory/facts/${initialFact.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          guildId: "guild-1",
          subject: "user-1",
          fact: "Speaker likes modded handheld PCs.",
          factType: "project",
          evidenceText: "Operator corrected this durable fact.",
          confidence: 0.93
        })
      });
      assert.equal(updateResponse.status, 200);
      const updateJson = await updateResponse.json();
      assert.equal(updateJson.ok, true);
      assert.equal(updateJson.fact?.fact, "Speaker likes modded handheld PCs.");
      assert.equal(updateJson.fact?.fact_type, "project");
      assert.equal(updateJson.fact?.confidence, 0.93);

      const deleteResponse = await fetch(`${baseUrl}/api/memory/facts/${initialFact.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          guildId: "guild-1"
        })
      });
      assert.equal(deleteResponse.status, 200);
      const deleteJson = await deleteResponse.json();
      assert.equal(deleteJson.ok, true);
      assert.equal(deleteJson.deleted, 1);

      const afterDelete = await fetch(
        `${baseUrl}/api/memory/facts?guildId=guild-1&subject=user-1&limit=10`
      );
      assert.equal(afterDelete.status, 200);
      const afterDeleteJson = await afterDelete.json();
      assert.deepEqual(afterDeleteJson.facts, []);
      assert.equal(refreshCalls, 2);
    }
  );

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
        provider: "anthropic",
        model: "claude-sonnet-4-6",
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
        provider: "anthropic",
        model: "claude-sonnet-4-6",
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

test("dashboard admin routes do not accept dashboard tokens in the query string", async () => {
  const result = await withDashboardServer(
    {
      dashboardToken: "dash-token"
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings?token=dash-token`);
      assert.equal(response.status, 401);
      const json = await response.json();
      assert.equal(json.error, "Unauthorized. Provide x-dashboard-token.");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard requires a token before binding to a non-loopback host", async () => {
  await assert.rejects(
    () =>
      withDashboardServer(
        {
          appConfigOverrides: {
            dashboardHost: "0.0.0.0"
          }
        },
        async () => {}
      ),
    /DASHBOARD_TOKEN is required when DASHBOARD_HOST is not loopback-only/
  );
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

test("dashboard preset defaults preview settings without mutating saved state", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store, bot }) => {
    const before = store.getSettings();
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
    assert.equal(store.getSettings().agentStack.preset, before.agentStack.preset);
    assert.equal(bot.appliedSettings.length, 0);
    assert.equal(json._resolved.agentStack.voiceAdmissionPolicy.mode, "generation_decides");
    assert.equal(json.agentStack.preset, "claude_oauth");
    assert.equal(json._resolved.voiceAdmissionClassifierBinding, null);
    assert.equal(json._resolved.voiceGenerationBinding.provider, "claude-oauth");
    assert.equal(json._resolved.voiceGenerationBinding.model, "claude-sonnet-4-6");

    const openAiApiResponse = await fetch(`${baseUrl}/api/settings/preset-defaults`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        preset: "openai_api"
      })
    });

    assert.equal(openAiApiResponse.status, 200);
    const openAiApiJson = await openAiApiResponse.json();
    assert.equal(openAiApiJson.agentStack.preset, "openai_api");
    assert.equal(openAiApiJson._resolved.voiceGenerationBinding.provider, "openai");
    assert.equal(openAiApiJson._resolved.voiceGenerationBinding.model, "gpt-5-mini");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard fresh settings default claude_oauth brain to claude sonnet", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/settings`);
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.agentStack.preset, "claude_oauth");
    assert.equal(json._resolved.voiceAdmissionClassifierBinding, null);
    assert.equal(json._resolved.voiceGenerationBinding.provider, "claude-oauth");
    assert.equal(json._resolved.voiceGenerationBinding.model, "claude-sonnet-4-6");
    assert.equal(json.agentStack.runtimeConfig.voice.generation.mode, "dedicated_model");
    assert.equal(json.agentStack.runtimeConfig.voice.generation.model.provider, "claude-oauth");
    assert.equal(json.agentStack.runtimeConfig.voice.generation.model.model, "claude-sonnet-4-6");
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings save clears the memory LLM override when inherit is selected", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.patchSettings({
      memoryLlm: {
        provider: "anthropic",
        model: "claude-haiku-4-5"
      }
    });

    const beforeResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(beforeResponse.status, 200);
    const beforeJson = await beforeResponse.json();
    const expectedUpdatedAt = String(beforeJson._meta?.updatedAt || "");
    assert.equal(Boolean(expectedUpdatedAt), true);

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        _meta: {
          expectedUpdatedAt
        },
        memoryLlm: {}
      })
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.deepEqual(store.getSettings().memoryLlm, {});
    assert.deepEqual(json.memoryLlm, {});
    assert.equal(json._resolved?.memoryBinding?.provider, json._resolved?.orchestrator?.provider);
    assert.equal(json._resolved?.memoryBinding?.model, json._resolved?.orchestrator?.model);
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings save reports runtime apply failure without rolling back the saved config", async () => {
  const result = await withDashboardServer(
    {
      botOverrides: {
        async applyRuntimeSettings() {
          throw new Error("voice reconcile failed");
        }
      }
    },
    async ({ baseUrl, store }) => {
      const beforeResponse = await fetch(`${baseUrl}/api/settings`);
      assert.equal(beforeResponse.status, 200);
      const beforeJson = await beforeResponse.json();
      const expectedUpdatedAt = String(beforeJson._meta?.updatedAt || "");

      const response = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          _meta: {
            expectedUpdatedAt
          },
          identity: {
            botName: "patched bot"
          }
        })
      });

      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.identity?.botName, "patched bot");
      assert.equal(json._meta?.saveAppliedToRuntime, false);
      assert.equal(json._meta?.saveApplyError, "voice reconcile failed");
      assert.equal(store.getSettings().identity.botName, "patched bot");
    }
  );

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings save rejects requests from outdated clients that omit settings version metadata", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.patchSettings({
      agentStack: {
        overrides: {
          voiceAdmissionClassifier: {
            mode: "dedicated_model",
            model: {
              provider: "claude-oauth",
              model: "claude-sonnet-4-5"
            }
          }
        }
      },
      voice: {
        admission: {
          mode: "adaptive"
        },
        conversationPolicy: {
          replyPath: "bridge"
        }
      }
    });

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agentStack: {
          overrides: {
            voiceAdmissionClassifier: {
              mode: "dedicated_model",
              model: {
                provider: "claude-oauth",
                model: "claude-sonnet-4-6"
              }
            }
          }
        }
      })
    });

    assert.equal(response.status, 409);
    const json = await response.json();
    assert.equal(json.error, "settings_version_required");
    assert.equal(json._resolved.voiceAdmissionClassifierBinding.model, "claude-sonnet-4-5");
    assert.equal(
      store.getSettings().agentStack.overrides?.voiceAdmissionClassifier?.model?.model,
      "claude-sonnet-4-5"
    );
  });

  if (result?.skipped) {
    return;
  }
});

test("dashboard settings save rejects stale form snapshots instead of overwriting newer values", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, store }) => {
    store.patchSettings({
      voice: {
        admission: {
          mode: "adaptive"
        },
        conversationPolicy: {
          replyPath: "bridge"
        }
      }
    });

    const initialResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(initialResponse.status, 200);
    const initialJson = await initialResponse.json();
    const initialUpdatedAt = String(initialJson._meta?.updatedAt || "");
    assert.equal(Boolean(initialUpdatedAt), true);

    const firstSaveResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        _meta: {
          expectedUpdatedAt: initialUpdatedAt
        },
        agentStack: {
          overrides: {
            voiceAdmissionClassifier: {
              mode: "dedicated_model",
              model: {
                provider: "claude-oauth",
                model: "claude-sonnet-4-5"
              }
            }
          }
        }
      })
    });

    assert.equal(firstSaveResponse.status, 200);
    const firstSaveJson = await firstSaveResponse.json();
    assert.equal(firstSaveJson._resolved.voiceAdmissionClassifierBinding.model, "claude-sonnet-4-5");
    const firstSaveUpdatedAt = String(firstSaveJson._meta?.updatedAt || "");
    assert.equal(Boolean(firstSaveUpdatedAt), true);
    assert.notEqual(firstSaveUpdatedAt, initialUpdatedAt);

    const staleSaveResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        _meta: {
          expectedUpdatedAt: initialUpdatedAt
        },
        agentStack: {
          overrides: {
            voiceAdmissionClassifier: {
              mode: "dedicated_model",
              model: {
                provider: "claude-oauth",
                model: "claude-sonnet-4-6"
              }
            }
          }
        }
      })
    });

    assert.equal(staleSaveResponse.status, 409);
    const staleSaveJson = await staleSaveResponse.json();
    assert.equal(staleSaveJson.error, "settings_conflict");
    assert.equal(staleSaveJson._resolved.voiceAdmissionClassifierBinding.model, "claude-sonnet-4-5");
    assert.equal(
      store.getSettings().agentStack.overrides?.voiceAdmissionClassifier?.model?.model,
      "claude-sonnet-4-5"
    );
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

test("dashboard settings expose provider auth from OAuth-backed app config", async () => {
  const result = await withDashboardServer(
    {
      appConfigOverrides: {
        claudeOAuthRefreshToken: "claude-refresh-token",
        openaiOAuthRefreshToken: "openai-refresh-token"
      }
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/settings`);
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json._resolved?.providerAuth?.claude_code, true);
      assert.equal(json._resolved?.providerAuth?.codex_cli, true);
      assert.equal(json._resolved?.providerAuth?.codex, true);
    }
  );

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
