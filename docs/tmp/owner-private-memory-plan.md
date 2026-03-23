# Owner Private Memory Plan

This is the implementation plan for the first owner-private memory extension of Clanky's memory system.

## Goal

Add a narrow, safe `owner` memory scope that closes the gap between Clanky's public social memory and OpenClaw-like private assistant continuity for the owner.

## Scope model

### Domain/storage names

- `user` - current portable person memory
- `guild` - current community memory
- `owner` - new owner-private memory

Note: product/UI language should present these as `People`, `Community`, and `Owner Private`.

## V1 constraints

- Facts only, no new note/artifact subsystem
- One canonical owner subject: `__owner__`
- Narrow context gating only
- No collaborator-sharing machinery
- No broad channel inference for owner-private writes

## What owner memory is for

- private reminders
- personal routines and preferences
- ongoing follow-through
- private project continuity
- personal assistant context that should never appear in public community interactions

## What owner memory is not for

- general facts about other people
- community lore or server canon
- future shared-resource/team memory
- dashboard settings or operator state that already belongs elsewhere

## Narrow context gating

Introduce a narrow `isOwnerPrivateContext` primitive.

V1 true cases:

- DM with the configured owner
- explicit owner-only dashboard memory flows

V1 false cases:

- normal guild text
- normal guild voice
- non-owner DMs
- public dashboard surfaces for general memory inspection

Read eligibility and write eligibility should be reasoned about separately.

## Implementation sequence

1. Extend memory scope acceptance to include `owner`
2. Add canonical owner subject handling (`__owner__`)
3. Add store/query support for owner facts
4. Add owner-context gating primitive in runtime/tool layers
5. Add owner/private memory-write namespace resolution
6. Add owner retrieval path for owner-private contexts only
7. Add dashboard Owner Private surface
8. Add tests for scope isolation, retrieval, and dashboard behavior
9. Update canonical docs after the code lands

## Storage shape

Use existing `memory_facts` table.

Owner rows should look like:

- `scope = 'owner'`
- `guild_id = NULL`
- `user_id = <owner user id>`
- `subject = '__owner__'`

## Retrieval rules

### Public/community contexts

- load user facts for relevant people
- load guild facts for the active guild
- do not load owner facts

### Owner-private contexts

- load relevant user facts
- load relevant guild facts when the context is tied to a guild
- load owner facts
- rank and trim like other durable fact pools

## Tool/write behavior

Add owner-private namespace aliases:

- `owner`
- `private`

Only the owner can write this memory.

## Dashboard behavior

- Add explicit `Owner Private` presentation
- Keep it visually separate from person/community memory
- Do not frame it as generic `user` memory

## Tests to add

- owner scope rows can be stored and retrieved
- non-owner contexts do not receive owner memory
- owner contexts do receive owner memory
- owner/private tool writes reject non-owner callers
- dashboard owner-private view reads canonical owner rows
- public memory inspector does not confuse owner memory with people/community memory

## Future follow-up

- `shared-resource` memory is the next likely memory lane after owner-private
- if facts prove insufficient for owner continuity, add an owner-private note/artifact layer later

Product language: owner-private memory gives Clanky a true private assistant layer for the owner without contaminating the shared social world.
