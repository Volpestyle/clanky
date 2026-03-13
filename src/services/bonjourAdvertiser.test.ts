import { expect, test, mock } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { BonjourAdvertiser } from "./bonjourAdvertiser.ts";

function createFakeChild() {
  const child: Partial<ChildProcess> = {};
  child.on = mock(() => child as ChildProcess);
  child.kill = mock(() => true);
  return child as ChildProcess & {
    on: ReturnType<typeof mock>;
    kill: ReturnType<typeof mock>;
  };
}

test("BonjourAdvertiser does not advertise until a tunnel URL exists", () => {
  const calls: string[][] = [];
  const spawnFn = mock((binary: string, args: string[]) => {
    calls.push([binary, ...args]);
    return createFakeChild();
  });

  const advertiser = new BonjourAdvertiser(8787, { spawnFn });

  advertiser.start("");

  expect(spawnFn).toHaveBeenCalledTimes(0);

  advertiser.updateTunnelUrl("https://slide-doom-sensitive-utah.trycloudflare.com");

  expect(spawnFn).toHaveBeenCalledTimes(1);
  expect(calls[0]).toEqual([
    "dns-sd",
    "-R",
    "Clanky Dashboard",
    "_clanky._tcp",
    ".",
    "8787",
    "version=1",
    "tunnelUrl=https://slide-doom-sensitive-utah.trycloudflare.com"
  ]);
});

test("BonjourAdvertiser clears the advertisement when the tunnel URL disappears", () => {
  const child = createFakeChild();
  const spawnFn = mock(() => child);

  const advertiser = new BonjourAdvertiser(8787, { spawnFn });

  advertiser.start("https://slide-doom-sensitive-utah.trycloudflare.com");
  advertiser.updateTunnelUrl("");

  expect(spawnFn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
});
