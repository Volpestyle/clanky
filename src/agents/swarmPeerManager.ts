import path from "node:path";
import { ClankyPeer, type ClankyPeerOptions } from "./swarmPeer.ts";
import { resolveSwarmDbPath } from "./swarmDbConnection.ts";

export type ClankySwarmPeerManagerOptions = {
  dbPath?: string | null;
  heartbeatIntervalMs?: number;
  labelExtras?: {
    thread?: string | null;
    user?: string | null;
  };
};

export class ClankySwarmPeerManager {
  private readonly dbPath: string;
  private readonly heartbeatIntervalMs?: number;
  private readonly labelExtras: NonNullable<ClankySwarmPeerManagerOptions["labelExtras"]>;
  private readonly peers = new Map<string, ClankyPeer>();

  constructor(options: ClankySwarmPeerManagerOptions = {}) {
    this.dbPath = resolveSwarmDbPath(options.dbPath || "");
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.labelExtras = options.labelExtras ?? {};
  }

  ensurePeer(scope: string, repoRoot: string, fileRoot: string): ClankyPeer {
    const key = this.normalizeScopeKey(scope);
    const existing = this.peers.get(key);
    if (existing) return existing;

    const options: ClankyPeerOptions = {
      dbPath: this.dbPath,
      scope: key,
      repoRoot,
      fileRoot,
      thread: this.labelExtras.thread,
      user: this.labelExtras.user,
      heartbeatIntervalMs: this.heartbeatIntervalMs
    };
    const peer = new ClankyPeer(options);
    this.peers.set(key, peer);
    return peer;
  }

  shutdown(): void {
    for (const peer of this.peers.values()) {
      peer.shutdown();
    }
    this.peers.clear();
  }

  private normalizeScopeKey(scope: string) {
    const normalized = String(scope || "").trim();
    if (!normalized) throw new Error("scope is required.");
    const resolved = path.resolve(normalized);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}
