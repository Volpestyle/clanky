# Night Compiler

Shared React/Vite documentation shell for the Clanky agent ecosystem.

The package owns the reusable docs UI:

- responsive app shell
- sidebar and table of contents
- Markdown rendering
- Mermaid diagrams
- local docs-link routing
- cross-site docs links through `docs://site-id/slug`
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

Cross-site links resolve against `site.siteLinks`:

```md
[AgentRoom Ecosystem](docs://agent-room-docs/ecosystem)
[Clanky Start Here](docs://clanky-docs/start-here)
[ClankVox Overview](docs://clankvox-docs/overview)
```

Local dev can override published URLs with env vars such as
`DOCS_AGENT_ROOM_URL`, `DOCS_CLANKY_URL`, and `DOCS_CLANKVOX_URL`.
