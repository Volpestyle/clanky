import type { SessionContext } from "eve/tools";
import { autoApproveAll } from "../approvals.ts";

// Approval-mode ladder for the host_command tool (ADR-0003): read-only is the
// gated default, auto runs workspace-write sandboxed without prompts, yolo
// drops the sandbox entirely and never asks. Yolo is transient by design: the
// face injects CLANKY_YOLO into the owned brain's environment and never writes
// it to .env.local, so a cold start always comes back gated.
export type ApprovalMode = "read-only" | "auto" | "yolo";

export const APPROVAL_MODE_ENV = "CLANKY_APPROVAL_MODE";
export const YOLO_ENV = "CLANKY_YOLO";

const TRUTHY_YOLO_VALUES = new Set(["1", "true", "yes", "on"]);
const APPROVAL_MODES = new Set<string>(["read-only", "auto", "yolo"]);

export function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (APPROVAL_MODES.has(normalized)) return normalized as ApprovalMode;
	return undefined;
}

// Read at call time (not module load), matching autoApproveAll(): a brain
// restart with a changed environment must not see stale state.
// CLANKY_AUTO_APPROVE (the global approval bypass) implies at least auto.
export function resolveApprovalMode(env: NodeJS.ProcessEnv = process.env): ApprovalMode {
	if (TRUTHY_YOLO_VALUES.has(env[YOLO_ENV]?.trim().toLowerCase() ?? "")) return "yolo";
	const mode = parseApprovalMode(env[APPROVAL_MODE_ENV]);
	if (mode !== undefined) return mode;
	return autoApproveAll() ? "auto" : "read-only";
}

// Owner-driven turn detection for the yolo guardrail (ADR-0003): yolo applies
// only to surfaces the owner authenticates through. Surfaces mark themselves
// with the SURFACE_HEADER on their loopback eve client (localUserAuth() copies
// it into auth attributes, see agent/lib/frontdoor-auth.ts); the relay
// frontdoor is owner by its bearer token. Anything unmarked — legacy
// local-face requests, schedules, workers, presence hosts — fails closed to
// non-owner.
const OWNER_SURFACES = new Set(["frontdoor", "face"]);

type SessionAuthLike = SessionContext["session"]["auth"];

export function isOwnerDrivenTurn(auth: SessionAuthLike): boolean {
	const surface = auth.current?.attributes.surface;
	return typeof surface === "string" && OWNER_SURFACES.has(surface);
}
