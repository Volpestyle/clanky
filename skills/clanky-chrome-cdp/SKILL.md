---
name: clanky-chrome-cdp
description: Use Chrome DevTools Protocol from Clanky's local CLI to inspect or control a running Chrome/Chromium debugging session.
when_to_use: Use Chrome DevTools Protocol from Clanky's local CLI to inspect or control a running Chrome/Chromium debugging session.
allowed_tools: []
deps:
  - chrome-remote-interface
---

# Chrome CDP

Use this when the task needs an existing or explicitly launched Chrome/Chromium debugging session: local app debugging, console/network inspection, or controlling a browser the user intentionally exposed through CDP.

## CLI

- Launch a temporary-profile Chrome with CDP: `pnpm browser:chrome-debug --port 9222 --url about:blank`
- Show launcher options: `pnpm browser:chrome-debug --help`
- List targets: `pnpm browser:cdp --port 9222 list`
- Open a tab: `pnpm browser:cdp --port 9222 new <url>`
- Inspect a target: `pnpm browser:cdp --port 9222 inspect <target-id>`
- For programmatic CDP, write a short TypeScript script in the current workspace, such as `./.clanky-tmp/cdp.ts`, and run it with `pnpm exec tsx ./.clanky-tmp/cdp.ts`. Keep output artifacts such as screenshots under `/tmp` when they do not need to be committed.
- Do not put the script itself under `/tmp` unless you also handle dependency resolution; Node resolves imports from the script path, so `/tmp/script.ts` will not find this workspace's `node_modules` by default.

## Workflow

1. Prefer Playwright for normal browsing. Use CDP when attaching to, inspecting, or debugging a running Chrome session matters.
2. Do not attach to the user's personal Chrome profile unless they explicitly request it. The launcher defaults to a temporary profile, binds CDP to `127.0.0.1`, and disables extensions for cleaner target lists. Pass `--enable-extensions` only when extensions are part of the task.
3. Start by listing targets and choosing a `page` target by id or URL. Avoid assuming the first target is the right one; Chrome may expose background pages, extensions, service workers, or other non-page targets first.
4. For console logs, network events, DOM snapshots, or screenshots, use the `chrome-remote-interface` library from a script rather than manual REPL interaction.
5. Keep CDP ports local (`127.0.0.1`) and mention the port in any handoff.

## Script Pattern

```ts
import CDP from "chrome-remote-interface";

interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
}

async function main(): Promise<void> {
  const targets = (await CDP.List({ port: 9222 })) as TargetInfo[];
  const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes("example.com"));
  if (target === undefined) throw new Error("No matching page target found");

  const client = await CDP({ port: 9222, target: target.id });
  try {
    const { Runtime, Page } = client;
    await Promise.all([Runtime.enable(), Page.enable()]);
    const result = await Runtime.evaluate({
      expression: "document.body.innerText.slice(0, 8000)",
      returnByValue: true,
    });
    console.log(JSON.stringify({ url: target.url, text: result.result.value }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
```

If the browser is not already exposing CDP, use `pnpm browser:chrome-debug` to launch a controlled temporary instance. If that cannot launch Chrome on the host, fall back to Playwright when the task does not specifically require CDP.
