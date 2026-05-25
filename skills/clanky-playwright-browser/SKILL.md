---
name: clanky-playwright-browser
description: Use Playwright from Clanky's local CLI for general web browsing, page extraction, screenshots, and repeatable browser automation.
when_to_use: Use Playwright from Clanky's local CLI for general web browsing, page extraction, screenshots, and repeatable browser automation.
allowed_tools: []
deps:
  - playwright
---

# Playwright Browser

Use this for general web browsing, research, screenshots, and deterministic browser automation.

## CLI

- Verify: `pnpm browser:playwright --version`
- Install Chromium if the browser binary is missing: `pnpm browser:install`
- Quick screenshot: `pnpm browser:playwright screenshot <url> /tmp/clanky-page.png`
- For multi-step work, write a short TypeScript script in the current workspace, such as `./.clanky-tmp/script.ts`, and run it with `pnpm exec tsx ./.clanky-tmp/script.ts`. Keep output artifacts such as screenshots under `/tmp` when they do not need to be committed.
- Do not put the script itself under `/tmp` unless you also handle dependency resolution; Node resolves imports from the script path, so `/tmp/script.ts` will not find this workspace's `node_modules` by default.

## Workflow

1. Prefer Playwright over CDP for new browsing sessions and repeatable automation.
2. Use a fresh browser context by default. Do not use a persistent/authenticated profile unless the user explicitly asks.
3. Capture useful artifacts under `/tmp` or the task workspace: screenshot, extracted text, relevant HTML snippet, and final URL.
4. Extract page text with DOM APIs such as `document.body.innerText`; use locators for clicking/form-filling instead of brittle coordinate clicks.
5. Close browsers and contexts in a `finally` block.
6. If browsing fails because Chromium is not installed, run `pnpm browser:install` once and retry.

## Script Pattern

```ts
import { chromium } from "playwright";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await page.title();
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    await page.screenshot({ path: "/tmp/clanky-page.png", fullPage: true });
    console.log(JSON.stringify({ url: page.url(), title, text: text.slice(0, 8000) }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
```

Report what was observed from browser output. If login, payment, personal data, or destructive actions are involved, stop and ask for explicit permission.
