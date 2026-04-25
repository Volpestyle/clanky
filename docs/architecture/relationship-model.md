# Relationship And Capability Model

This document defines Clanky's intended product relationship to the people around it.

Clanky is one socially real Discord-native entity, not a pile of separate bots for separate audiences. The same agent participates in the community, hangs out in voice, remembers shared history, and can also become a deeper assistant for the person running it while serving as a higher-trust collaborator for explicitly approved others.

## Core product shape

- Discord is the primary public surface where Clanky lives.
- The dashboard is the private control plane for operators and permissioning.
- Community participation stays the visible default.
- Deeper powers unlock through explicit trust, not through hidden prompt branches.

The target product experience is:

- everyone can know Clanky as a community member
- the owner can rely on Clanky as a deeply integrated personal assistant
- approved others can use higher-trust shared capabilities without borrowing the owner's full private assistant surface
- operators can safely widen or narrow those powers from the dashboard

## Relationship tiers

Clanky's permissions should be modeled as relationship depth, not as one flat allowlist.

### Community participant

Default relationship for ordinary server members.

Expected capabilities:

- natural conversation in text and voice
- web search and page reading
- music playback and lightweight media lookup
- community-scoped memory and server lore
- normal socially embedded initiative

Community users should not automatically gain access to private user data, personal reminders, code workers, or linked-device actions.

### Trusted collaborator

Explicitly approved user who can ask more of Clanky on shared or specifically approved resources.

Expected capabilities:

- everything in the community tier
- deeper assistant workflows
- longer-running tasks and follow-through
- richer memory access where policy allows
- code orchestration and other higher-trust tools

Trusted collaborator access is still bounded by resource ownership and tool-specific policies. This tier is intentionally not the same thing as "full personal assistant with private device integration."

Memory for this tier should eventually distinguish at least three categories explicitly:

- collaborator-private memory - user-specific context for that approved collaborator relationship
- shared-resource memory - facts tied to shared repos, projects, channels, or team workflows
- owner-private memory - personal context that belongs only to the operator-facing assistant relationship

### Owner assistant

The person running this Clanky instance and the only relationship that should assume deep local integration by default.

Expected capabilities:

- everything in the trusted collaborator tier
- access to owner-paired device surfaces
- private notification delivery
- screenshot, clipboard, camera, location, and share handoff flows

Deep device powers are personal to the owner-facing assistant relationship. Other users should not be expected to attach their private devices to someone else's machine-hosted Clanky instance.

### Operator

User with dashboard and runtime administration powers.

Expected capabilities:

- settings and preset control
- permission grants and revocation
- dangerous-action gating
- runtime inspection, logs, and maintenance

Operators control access. Operators are not automatically entitled to impersonate another trusted user's private context.

## Capability classes

Capability access should be reasoned about in classes rather than one-off tool names.

Recommended classes:

- `community` - safe shared capabilities available to normal members
- `assistant` - higher-trust shared or approved collaborator capabilities
- `owner` - private owner-assistant and local-device capabilities
- `operator` - admin and dangerous control-plane actions

Examples:

- `web_search`, `web_scrape`, `music_*` -> usually `community`
- `spawn_code_worker`, swarm code orchestration, private reminders -> usually `assistant`
- future iPhone/mac node tools -> `owner`
- permission changes, runtime resets, dangerous approvals -> `operator`

## Resource ownership

Capability grants alone are not enough. Clanky also needs resource ownership boundaries.

Three separate questions matter:

1. is this user allowed to ask for this class of action?
2. which resource does the action touch?
3. does that resource belong to this user, the community, or an operator-controlled shared space?

Examples:

- a trusted collaborator may have `assistant` access but only for approved repositories
- owner-device capabilities should stay bound to the operator's paired phone or Mac for this instance
- community memory may be visible in a guild, while deeper personal memory stays scoped to the owner or to explicitly approved user relationships

This model prevents "trusted" from collapsing into "can do everything."

## Public behavior vs private powers

Clanky should stay one consistent personality across all tiers.

What changes by tier:

- available tools
- visible memory scopes
- task depth and follow-through
- owner-only device and notification access
- dashboard and admin controls

What does not change by tier:

- identity
- social presence in the community
- core tone/personality
- Discord-first embodiment

## Design constraints

- Do not flatten Clanky into a generic private assistant that merely cross-posts to Discord.
- Do not flatten permissions into one giant allowlist.
- Do not leak one trusted user's private context into shared community interactions.
- Do not imply that every trusted collaborator should attach their private devices to this Clanky instance.
- Do not treat non-Discord surfaces as equal public identities; companion surfaces are private organs, not rival personas.

## Architecture implications

This relationship model implies a few architectural requirements:

- permissions should separate role, capability class, and resource ownership
- dashboard controls should grant trust deliberately, with clear reviewable state
- memory should distinguish community-scoped knowledge, collaborator-private context, shared-resource context, and owner-private context
- future device integration should bind devices to the operator/owner explicitly for this instance
- higher-trust tools should fail with clear, natural access-denied outcomes instead of silent weirdness

Related docs:

- [`overview.md`](overview.md)
- [`activity.md`](activity.md)
- [`../capabilities/code.md`](../capabilities/code.md)
- [`../capabilities/memory.md`](../capabilities/memory.md)
- [`../reference/settings.md`](../reference/settings.md)
