# Owner Assistant Gap Plan

This document captures the biggest remaining gaps between Clanky's current Discord-native runtime and the product we want for the person running the instance: a deeply integrated personal assistant that still feels like a real community member.

This is a planning doc, not canonical architecture truth. Canonical product direction lives in:

- [`../architecture/relationship-model.md`](../architecture/relationship-model.md)
- [`../architecture/overview.md`](../architecture/overview.md)
- [`../../README.md`](../../README.md)

## Goal

Make Clanky feel OpenClaw-level useful as a personal assistant for the owner without flattening Clanky into a generic cross-channel assistant.

That means:

- Discord remains Clanky's primary public identity
- the owner gets deeper private assistant depth
- trusted collaborators can use higher-trust shared capabilities
- private owner-device integration stays attached to the owner's local instance

## Product thesis

Clanky does not need to become "OpenClaw with a Discord skin."

Clanky should become:

- a socially embedded Discord entity on the outside
- a deeply integrated owner assistant on the inside

The owner should feel:

- Clanky knows what is happening in my Discord world
- Clanky can also help me with my real devices, tasks, browser context, and ongoing work
- none of that private power breaks the community-facing identity

## Biggest gap

The biggest gap is owner-side device and environment integration.

Today Clanky already has strong foundations in:

- Discord embodiment
- voice and media presence
- tool orchestration
- browser and code-agent workflows
- memory and initiative

What Clanky still lacks is a strong private bridge into the owner's actual day-to-day environment.

That missing bridge includes:

- iPhone context and actions
- macOS context and actions
- notification delivery and intake
- screenshot, clipboard, and browser handoff
- location, camera, and share-sheet flows
- explicit owner-bound resource ownership for those capabilities

Without that, Clanky is a powerful Discord-native agent with tools. With that, Clanky starts to feel like a true personal assistant for the person running the instance.

## What we want to achieve

### 1. Private owner senses and hands

Clanky should be able to perceive and act on the owner's environment in a scoped, explicit way.

Target capabilities:

- owner can share links, text, files, and images directly into Clanky from phone or Mac
- owner can ask Clanky to inspect current screen context
- owner can receive private notifications/reminders from Clanky on phone and Mac
- owner can let Clanky access clipboard/browser context on demand
- owner can let Clanky fetch current location or capture camera/screenshot context on demand

### 2. Strong task follow-through

Clanky should not only answer in the moment. It should keep working on behalf of the owner.

Target capabilities:

- reminders with delivery to owner devices
- standing orders like "watch this" or "tell me if this changes"
- resumable tasks and background follow-ups
- better continuity across Discord text, Discord voice, dashboard, and device surfaces

### 3. Honest ownership boundaries

We need clear architecture and UX boundaries for who owns what.

Target outcomes:

- owner-only device powers stay owner-only
- trusted collaborators can use approved high-trust tools on approved shared resources
- memory ownership becomes more explicit
- access-denied behavior is natural and predictable

### 4. Better internal capability plumbing

As Clanky grows beyond pure Discord/runtime-local tools, we need cleaner internal structure.

Target outcomes:

- clearer capability classes in runtime
- explicit owner vs collaborator vs community boundaries
- easier future device/node integration
- easier future dashboard policy surfaces

## Gap breakdown

## Gap A - Owner companion integration is missing

This is the largest product gap.

### Why it matters

The difference between a clever bot and a real assistant is not just model quality. It is whether the assistant can interact with the owner's world.

### Desired end state

Clanky has private companion surfaces for the owner's iPhone and Mac.

Those surfaces are not separate public products or public identities. They are private organs of the owner-facing assistant relationship.

### V1 owner companion capabilities

- share-to-Clanky from iPhone and Mac
- outbound local notifications from Clanky
- screenshot/photo upload to Clanky
- Mac clipboard read on demand
- active browser/tab handoff on Mac
- location fetch on demand

### V2 companion capabilities

- richer screen context
- camera capture flows
- voice memo ingestion
- lock-screen quick actions / shortcuts
- structured app-intent handoff

### Key constraints

- no rival chat identity outside Discord
- no broad continuous surveillance
- explicit permissions and visible logs
- owner-device binding is required

## Gap B - Task and follow-through depth is still too thin

Clanky already has initiative and automations, but the owner-assistant loop is not yet strong enough.

### Why it matters

Real assistant value compounds through follow-through, not only in-turn replies.

### Desired end state

Clanky can own ongoing tasks for the operator and deliver results back into the most appropriate owner-facing surface.

### Needed capabilities

- owner reminders with real device delivery
- watch tasks for links/pages/repos/topics
- structured background task state
- better status, continuation, and cancellation surfaces
- private delivery routing: Discord DM, dashboard, phone notification, Mac notification

### Relationship to existing work

- async/background code task work is part of this story
- automations should eventually feel like assistant commitments, not detached cron entries

## Gap C - Memory ownership needs more explicit lanes

The current product direction is correct, but the memory model needs sharper ownership language over time.

### Desired categories

- owner-private memory
- collaborator-private memory
- shared-resource memory
- community/guild memory

### Why it matters

Without explicit lanes, "trusted" becomes vague and data boundaries become muddy.

### Outcome we want

Clanky can remember deeply without accidentally blending:

- owner life context
- collaborator-specific context
- shared project/workspace knowledge
- community lore

## Gap D - Permissions need to become a first-class runtime model

The docs are now pointing in the right direction, but runtime enforcement still needs to catch up.

### Desired model

Permissioning answers three questions:

1. who is asking?
2. what capability class are they asking for?
3. what resource does the action target?

### Desired capability classes

- `community`
- `assistant`
- `owner`
- `operator`

### Desired resource shapes

- owner device
- owner-private memory
- collaborator-private memory
- shared repo/workspace
- community/guild surface

## Gap E - Internal capability plumbing is still too ad hoc

Clanky has powerful tools, but the product is outgrowing a loose collection of tool-specific rules.

### Desired end state

- clearer capability registry or capability metadata layer
- easier mapping from tool -> capability class -> resource policy
- easier future owner companion integration
- less scattered policy logic

This does not require importing OpenClaw wholesale. It does mean borrowing the discipline of a cleaner backplane.

## Recommended execution order

## Phase 1 - Define owner-facing companion architecture

Deliverables:

- decide whether owner companion is iOS app + macOS app, iOS app + lightweight Mac helper, or another split
- define pairing/auth model for owner-owned devices
- define the initial owner capability surface
- define data flow between Bun runtime, dashboard, and companions

Output:

- architecture doc
- API/event surface proposal
- minimal pairing and trust model

## Phase 2 - Ship owner companion V1

Priority order:

1. share-to-Clanky ingest
2. outbound owner notifications
3. screenshot/photo ingest
4. Mac clipboard + browser handoff
5. location on demand

Success criteria:

- owner can route personal context into Clanky from real devices
- owner can receive proactive outputs from Clanky off-Discord
- Discord remains the primary public face

## Phase 3 - Strengthen task/follow-through engine

Deliverables:

- owner reminder delivery model
- watch task model
- task state/status surfaces
- background follow-up policy
- delivery routing model across Discord/dashboard/device notifications

Success criteria:

- Clanky can carry forward commitments for the owner
- task completion does not depend on the owner being actively in Discord at that moment

## Phase 4 - Implement explicit permission/resource model

Deliverables:

- concrete settings/runtime schema for capability classes
- resource ownership model
- tool policy enforcement path
- natural access-denied product behavior

Success criteria:

- owner-only powers are truly owner-only
- collaborator powers are safe and clear
- policy is inspectable rather than hidden in scattered checks

## Phase 5 - Clean up capability plumbing

Deliverables:

- capability metadata/registry layer
- reduced duplication in tool policy mapping
- cleaner future attachment point for owner-device capabilities

Success criteria:

- future assistant surfaces land into a clean system
- permissioning and ownership are easier to reason about

## Concrete next steps

### Immediate docs/design work

1. write an owner companion architecture doc
2. refine memory ownership doc language into explicit memory lanes
3. design runtime permission schema for `community` / `assistant` / `owner` / `operator`
4. map existing tools into those capability classes

### Immediate product decisions to make

1. Is the first owner companion surface iPhone, Mac, or both in parallel?
2. Is V1 primarily ingest-focused, notification-focused, or both?
3. Does owner task delivery prioritize Discord DM, local notifications, or configurable routing?
4. How much of the iOS companion should be passive vs explicit on-demand actions only?

### Immediate implementation candidates

1. share-to-Clanky ingest endpoint + minimal iOS/macOS handoff
2. owner notification delivery path
3. owner-device registration model in dashboard/backend
4. capability-class annotations for existing high-trust tools like `code_task`

## Non-goals for this plan

- making Clanky a public equal-weight multi-channel assistant product
- turning trusted collaborators into full private-device users of the owner's instance
- moving Clanky's social identity away from Discord
- replacing Clanky's soul with a generic orchestration framework

## Success test

We are succeeding if the owner can honestly say:

- Clanky still feels like a real part of my Discord community
- Clanky also helps me with my real devices, tasks, and environment
- I trust the privacy boundary between my private assistant relationship and shared community/collaborator interactions

Product language: the right future for Clanky is not to stop being a community entity, but to grow private senses, hands, and follow-through for the owner without losing its social soul.
