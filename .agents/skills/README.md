# clanky-agent development skills

Repo-owned host-agent skills for developing and debugging `clanky-agent`.

These are source directories. `.claude/skills` points at this directory, and
the user-level skill roots (`~/.agents/skills`, `~/.claude/skills`,
`~/.codex/skills`) may symlink selected skills here so Claude, Codex, and other
harnesses can discover them. Clanky's bundled runtime skills live in `../skills/`.
