import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory/memoryManager.ts";
import { Store } from "../store/store.ts";
import { rmTempDir } from "../testHelpers.ts";
import type { BotContext } from "./botContext.ts";
import {
  composeMessageContentForHistory,
  getConversationHistoryForPrompt,
  getImageInputs,
  getVideoInputs,
  isLikelyImageUrl,
  parseHistoryImageReference,
  recordReactionHistoryEvent,
  syncMessageSnapshot
} from "./messageHistory.ts";

async function withTempHistoryContext(run: (ctx: BotContext & { store: Store }) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-message-history-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: BotContext & { store: Store } = {
    appConfig,
    store,
    llm,
    memory,
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    botUserId: "bot-1"
  };

  try {
    await run(ctx);
  } finally {
    store.close();
    await rmTempDir(dir);
  }
}

function createAttachmentCollection(
  attachments: Array<{
    url?: string;
    proxyURL?: string;
    name?: string;
    contentType?: string;
  }>
) {
  return {
    size: attachments.length,
    *values() {
      for (const attachment of attachments) {
        yield attachment;
      }
    }
  };
}

function createReactionCollection(
  reactions: Array<{
    count?: number;
    emoji?: {
      id?: string;
      name?: string;
    } | null;
  }>
) {
  return {
    size: reactions.length,
    *values() {
      for (const reaction of reactions) {
        yield reaction;
      }
    }
  };
}

function recordStoreMessage(
  store: Store,
  {
    messageId,
    createdAt,
    guildId = "guild-1",
    channelId = "chan-1",
    authorId,
    authorName,
    isBot = false,
    content
  }: {
    messageId: string;
    createdAt: number;
    guildId?: string;
    channelId?: string;
    authorId: string;
    authorName: string;
    isBot?: boolean;
    content: string;
  }
) {
  store.recordMessage({
    messageId,
    createdAt,
    guildId,
    channelId,
    authorId,
    authorName,
    isBot,
    content
  });
}

test("composeMessageContentForHistory appends attachments embeds and reaction summary", () => {
  const content = composeMessageContentForHistory(
    {
      attachments: createAttachmentCollection([
        {
          url: "https://cdn.example.com/cat.png"
        }
      ]),
      embeds: [
        {
          video: {
            url: "https://video.example.com/demo.mp4"
          }
        },
        {
          url: "https://example.com/post"
        }
      ],
      reactions: {
        cache: createReactionCollection([
          {
            count: 2,
            emoji: {
              name: "party"
            }
          }
        ])
      }
    },
    "  hello there  "
  );

  assert.equal(
    content,
    "hello there https://cdn.example.com/cat.png https://video.example.com/demo.mp4 https://example.com/post [reactions: partyx2]"
  );
});

test("getImageInputs keeps only images and caps the list at three", () => {
  const images = getImageInputs({
    attachments: createAttachmentCollection([
      {
        url: "https://cdn.example.com/readme.pdf",
        name: "readme.pdf",
        contentType: "application/pdf"
      },
      {
        url: "https://cdn.example.com/one.png",
        name: "one.png"
      },
      {
        url: "https://cdn.example.com/two",
        name: "two",
        contentType: "image/jpeg"
      },
      {
        url: "https://cdn.example.com/three.webp?size=400",
        name: "three.webp"
      },
      {
        url: "https://cdn.example.com/four.gif",
        name: "four.gif"
      }
    ])
  });

  assert.deepEqual(images, [
    {
      url: "https://cdn.example.com/one.png",
      filename: "one.png",
      contentType: ""
    },
    {
      url: "https://cdn.example.com/two",
      filename: "two",
      contentType: "image/jpeg"
    },
    {
      url: "https://cdn.example.com/three.webp?size=400",
      filename: "three.webp",
      contentType: ""
    }
  ]);
});

test("getVideoInputs keeps only videos and caps the list at three", () => {
  const videos = getVideoInputs({
    attachments: createAttachmentCollection([
      {
        url: "https://cdn.example.com/readme.pdf",
        name: "readme.pdf",
        contentType: "application/pdf"
      },
      {
        url: "https://cdn.example.com/clip.mp4",
        name: "clip.mp4"
      },
      {
        url: "https://cdn.example.com/stream",
        name: "stream",
        contentType: "video/webm"
      },
      {
        url: "https://cdn.example.com/trailer.mov?download=1",
        name: "trailer.mov"
      },
      {
        url: "https://cdn.example.com/four.mkv",
        name: "four.mkv"
      }
    ]),
    embeds: [
      {
        video: {
          url: "https://video.example.com/embed-preview.mp4"
        }
      }
    ]
  });

  assert.deepEqual(videos, [
    {
      url: "https://cdn.example.com/clip.mp4",
      filename: "clip.mp4",
      contentType: ""
    },
    {
      url: "https://cdn.example.com/stream",
      filename: "stream",
      contentType: "video/webm"
    },
    {
      url: "https://cdn.example.com/trailer.mov?download=1",
      filename: "trailer.mov",
      contentType: ""
    }
  ]);
});

test("image reference helpers detect format-param images and decode filenames", () => {
  assert.equal(isLikelyImageUrl("https://cdn.example.com/render?id=1&format=webp"), true);
  assert.equal(isLikelyImageUrl("not a url"), false);
  assert.deepEqual(
    parseHistoryImageReference("https://cdn.example.com/path/My%20Photo?format=png"),
    {
      filename: "My Photo",
      contentType: "image/png"
    }
  );
});

test("getConversationHistoryForPrompt searches normalized conversation windows", async () => {
  await withTempHistoryContext(async (ctx) => {
    const baseTime = Date.now() - 10 * 60 * 1000;

    recordStoreMessage(ctx.store, {
      messageId: "m1",
      createdAt: baseTime,
      authorId: "user-1",
      authorName: "alice",
      content: "can you check nvidia stock price today"
    });
    recordStoreMessage(ctx.store, {
      messageId: "m2",
      createdAt: baseTime + 1000,
      authorId: "bot-1",
      authorName: "clanky",
      isBot: true,
      content: "NVDA was around 181 earlier."
    });
    recordStoreMessage(ctx.store, {
      messageId: "m3",
      createdAt: baseTime + 2000,
      authorId: "user-1",
      authorName: "alice",
      content: "what do you think about that nvidia stock price"
    });

    const windows = await getConversationHistoryForPrompt(ctx, {
      guildId: "guild-1",
      channelId: "chan-1",
      queryText: "   that nvidia stock price   ",
      limit: 2,
      maxAgeHours: 24,
      before: 1,
      after: 1
    });

    assert.equal(windows.length, 1);
    assert.equal(
      windows[0]?.messages?.some((row) => row?.content === "NVDA was around 181 earlier."),
      true
    );
  });
});

test("syncMessageSnapshot stores normalized message content and references", async () => {
  await withTempHistoryContext(async (ctx) => {
    await syncMessageSnapshot(ctx, {
      id: "msg-1",
      createdTimestamp: 1_710_000_000_000,
      guildId: "guild-1",
      channelId: "chan-1",
      content: "  hello world  ",
      attachments: createAttachmentCollection([
        {
          url: "https://cdn.example.com/cat.png"
        }
      ]),
      author: {
        id: "user-1",
        username: "alice",
        bot: false
      },
      member: {
        displayName: "Alice"
      },
      reference: {
        messageId: "msg-0"
      }
    });

    const stored = ctx.store.db
      .prepare(
        `SELECT author_name, content, referenced_message_id
         FROM messages
         WHERE message_id = ?`
      )
      .get("msg-1") as {
      author_name: string;
      content: string;
      referenced_message_id: string | null;
    };

    assert.equal(stored.author_name, "Alice");
    assert.equal(stored.content, "hello world https://cdn.example.com/cat.png");
    assert.equal(stored.referenced_message_id, "msg-0");
  });
});

test("recordReactionHistoryEvent records user reactions to bot-authored messages", async () => {
  await withTempHistoryContext(async (ctx) => {
    await recordReactionHistoryEvent(
      ctx,
      {
        emoji: {
          id: "emoji-1",
          name: "wave"
        },
        message: {
          id: "bot-message-1",
          guildId: "guild-1",
          channelId: "chan-1",
          content:
            "this is a fairly long bot message that should still be summarized cleanly for reaction history",
          author: {
            id: "bot-1",
            username: "bot"
          },
          member: {
            displayName: "Clanker"
          },
          guild: {
            members: {
              cache: new Map([
                [
                  "user-2",
                  {
                    displayName: "Alice"
                  }
                ]
              ])
            }
          }
        }
      },
      {
        id: "user-2",
        username: "alice_user"
      }
    );

    const stored = ctx.store.db
      .prepare(
        `SELECT author_id, author_name, content, referenced_message_id
         FROM messages
         WHERE referenced_message_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get("bot-message-1") as {
      author_id: string;
      author_name: string;
      content: string;
      referenced_message_id: string;
    };

    assert.equal(stored.author_id, "user-2");
    assert.equal(stored.author_name, "Alice");
    assert.equal(
      stored.content,
      `Alice reacted with :wave: to Clanker's message: "this is a fairly long bot message that should still be summarized cleanly for..."`
    );
    assert.equal(stored.referenced_message_id, "bot-message-1");
  });
});
