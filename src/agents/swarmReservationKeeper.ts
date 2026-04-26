import {
  deleteUnadopted,
  fullDeregister,
  heartbeatUnadopted,
  isAdopted,
  reserveInstance,
  type ReserveInstanceOptions,
  type ReservedInstance
} from "./swarmDb.ts";

/**
 * 10s matches swarm-mcp's own peer heartbeat cadence
 * (`startInstanceTimers` in swarm-mcp/src/index.ts) and stays well inside
 * the registry's 30s stale-prune window.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export type SwarmReservationKeeperOptions = {
  dbPath: string;
  /** Heartbeat cadence for unadopted reservations. Defaults to 10s. */
  heartbeatIntervalMs?: number;
  /**
   * Optional sink for unexpected errors during background heartbeat work.
   * The keeper never throws from its timer.
   */
  onError?: (error: unknown) => void;
};

type Reservation = {
  instance: ReservedInstance;
};

/**
 * Owns the lifecycle of pre-adoption swarm-mcp instance rows that Clanky
 * has reserved on behalf of soon-to-be-spawned worker peers.
 *
 * Responsibilities, mirroring swarm-ui's PTY supervisor (`writes.rs` callers):
 *   - Pre-create instance rows with `pid=0, adopted=0` so the worker's
 *     swarm-mcp can adopt the row by id on boot.
 *   - Keep heartbeats fresh on a 10s cadence so swarm-mcp's 30s stale-row
 *     sweep doesn't reclaim a placeholder while the worker is still booting.
 *   - On `release`, if the worker never adopted, the row is deleted so the
 *     scope's instance list is not left with ghost placeholders.
 *
 * Adopted rows are owned by the worker after that point; the worker's own
 * MCP runtime handles its heartbeat and final deregister. We never refresh
 * heartbeats for adopted rows from this side.
 */
export class SwarmReservationKeeper {
  private readonly dbPath: string;
  private readonly heartbeatIntervalMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly active: Map<string, Reservation>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private shuttingDown: boolean;

  constructor(options: SwarmReservationKeeperOptions) {
    this.dbPath = options.dbPath;
    this.heartbeatIntervalMs = Math.max(
      1000,
      Number(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    );
    this.onError = options.onError;
    this.active = new Map();
    this.heartbeatTimer = null;
    this.shuttingDown = false;
  }

  reserve(opts: Omit<ReserveInstanceOptions, "dbPath">): ReservedInstance {
    if (this.shuttingDown) {
      throw new Error("SwarmReservationKeeper is shutting down; cannot reserve.");
    }
    const instance = reserveInstance({ dbPath: this.dbPath, ...opts });
    this.active.set(instance.id, { instance });
    this.ensureTimer();
    return instance;
  }

  /**
   * Drop a reservation that Clanky owns. If the worker never adopted, the
   * row is removed so the scope's instance list is not littered with
   * placeholders. If the worker has already adopted, the row's lifecycle
   * is the worker's — we just stop tracking it from this side.
   */
  release(instanceId: string): void {
    if (!this.active.delete(instanceId)) return;
    try {
      deleteUnadopted(this.dbPath, instanceId);
    } catch (error) {
      this.reportError(error);
    }
    this.maybeStopTimer();
  }

  /**
   * Forcibly tear down a reservation — adopted or not — and cascade-clean
   * its tasks/locks/messages. Used when Clanky needs to kill a worker it
   * owns and reset DB state instead of waiting for stale-row sweep.
   */
  forceDeregister(instanceId: string): void {
    this.active.delete(instanceId);
    try {
      fullDeregister(this.dbPath, instanceId);
    } catch (error) {
      this.reportError(error);
    }
    this.maybeStopTimer();
  }

  /** Number of currently tracked reservations (for tests/telemetry). */
  size(): number {
    return this.active.size;
  }

  /**
   * Run a single heartbeat pass and prune any rows whose adoption state
   * shifted under us. Exposed so tests don't have to wait on the real
   * timer cadence.
   */
  tick(): void {
    if (this.shuttingDown || this.active.size === 0) return;
    for (const [id, _entry] of this.active) {
      try {
        const adopted = isAdopted(this.dbPath, id);
        if (adopted === null) {
          // Row was pruned by swarm-mcp's stale sweep. Stop tracking.
          this.active.delete(id);
          continue;
        }
        if (adopted) {
          // Worker took over — stop refreshing from our side.
          this.active.delete(id);
          continue;
        }
        heartbeatUnadopted(this.dbPath, id);
      } catch (error) {
        this.reportError(error);
      }
    }
    this.maybeStopTimer();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const id of [...this.active.keys()]) {
      try {
        deleteUnadopted(this.dbPath, id);
      } catch (error) {
        this.reportError(error);
      }
    }
    this.active.clear();
  }

  private ensureTimer(): void {
    if (this.heartbeatTimer || this.shuttingDown) return;
    this.heartbeatTimer = setInterval(() => this.tick(), this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private maybeStopTimer(): void {
    if (!this.heartbeatTimer) return;
    if (this.active.size > 0) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      try {
        this.onError(error);
      } catch {
        // Swallow — caller's error handler is theirs to debug.
      }
    }
  }
}
