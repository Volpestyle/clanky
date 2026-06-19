---
description: Use when remembering or recalling durable facts about the main user, Discord users, servers, projects, or preferences.
---

# Memory

Use `memory_remember` when the user explicitly asks you to remember something or
when a stable personal fact is obviously important, such as a preferred name or
durable preference. Do not save routine transient chat.

Use `memory_search` before claiming recall. Dynamic memory context is injected
each turn when available, but explicit search is better for targeted recall.

Discord presence automatically captures narrow explicit identity/preference
patterns like "call me Paul" or "remember I like pie"; still use
`memory_remember` for nuanced durable facts the extractor cannot safely infer.

Subjects:

- `main_user`: the owner/operator.
- `discord_user`: another Discord participant. Include their Discord user id
  when available.
- `discord_server`: durable facts about a server/community.
- `project`: durable project facts.
- `other`: stable facts that do not fit the above.
