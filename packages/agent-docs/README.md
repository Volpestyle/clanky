# Agent Docs

Shared React/Vite documentation shell for the Clanky agent ecosystem.

The package owns the reusable docs UI:

- responsive app shell
- sidebar and table of contents
- Markdown rendering
- Mermaid diagrams
- local docs-link routing
- command palette search
- theme persistence
- `llms.txt` and `llms-full.txt` generation

Each consumer repo owns only:

- `apps/docs/src/docs-manifest.ts`
- `apps/docs/src/content.ts`
- `apps/docs/src/main.tsx`
- `apps/docs/scripts/generate-llms.ts`
- repo-specific branding assets

Use `defineDocsConfig` in the consumer app to bind page metadata to raw Markdown imports, then render `<DocsApp config={docsConfig} />`.
