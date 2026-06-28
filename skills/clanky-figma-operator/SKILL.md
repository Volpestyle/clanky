---
name: clanky-figma-operator
description: Clanky's conventions for working with the curated Figma connection, and routing to Figma's official figma-* skills for Plugin API depth.
when_to_use: Use when SELF.md, the project's AGENTS.md, or the user designates Figma and the task involves design, components, specs, layouts, design tokens, design systems, design-to-code, or visual references.
allowed_tools: []
deps: []
---

# Clanky Figma Operator

Treat the configured Figma design-tool connection as the default source of truth for design work. Do not wait for the user to ask before consulting it when the task is clearly design-related.

## Availability First

- Figma is a curated OAuth connection in `agent/connections/figma.ts`, not a dynamic MCP server. Use the configured design-tool role and the exposed Figma connection tools.
- If the connection is unavailable or unauthenticated, say so plainly and stop. Setup/auth path: `/mcp auth figma` or `/mcp install figma` from Clanky's face.

## Routing to Figma's Official Skills

If the official Figma skills are installed (profile/user skills dir), prefer them for anything beyond a simple read — they carry the Plugin API reference docs and gotchas Clanky should not guess at:

- `figma-use` — MANDATORY before any `use_figma` (Plugin API JS execution) call: node create/edit/delete, variables, components, auto-layout, fills.
- `figma-generate-design` — building or updating full screens/layouts from a design system.
- `figma-generate-library` — creating components, variant sets, and design-token bindings.
- `figma-code-connect` — wiring published components to code.

Load the matching official skill first, follow its rules, then apply the Clanky conventions below.

## Clanky Conventions

These are our house rules layered on top of Figma's own guidance. Keep them short and concrete; extend this list as preferences solidify.

- Read before write: inspect the relevant frame/node (screenshot or metadata) and confirm the target before mutating a file.
- Work incrementally and validate after each `use_figma` step; return affected node IDs so later steps can reference them.
- For design-to-code, ground implementation in the actual Figma values (tokens, spacing, fills) rather than approximating from a screenshot.
- Report what changed: file/page, nodes created or mutated, and any design-system components used.

<!-- Add project- or user-specific Figma conventions here as they come up:
     preferred team/file, naming schemes, token collections, review expectations. -->
