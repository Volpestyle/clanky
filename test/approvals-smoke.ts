import type { NeedsApprovalContext } from "eve/tools/approval";
import { always } from "eve/tools/approval";
import { autoApproveAll, gated, isAutoApproveValue } from "../agent/lib/approvals.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ctx: NeedsApprovalContext = { toolName: "mcp_call", approvedTools: new Set() };

// Truthy parsing accepts the documented forms and rejects everything else.
for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
	assert(isAutoApproveValue(value), `expected "${value}" to enable auto-approve`);
}
for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
	assert(!isAutoApproveValue(value), `expected "${String(value)}" to leave auto-approve off`);
}

// Default (env unset): gates behave as authored.
delete process.env.CLANKY_AUTO_APPROVE;
assert(!autoApproveAll(), "auto-approve should default off when unset");
assert(gated(always())(ctx), "always() must still require approval when auto-approve is off");
assert(gated((c) => c.toolName === "mcp_call")(ctx), "predicate gate must apply when auto-approve is off");

// Auto-approve on: every gate resolves to no-approval-needed.
process.env.CLANKY_AUTO_APPROVE = "1";
assert(autoApproveAll(), "auto-approve should be on when CLANKY_AUTO_APPROVE=1");
assert(!gated(always())(ctx), "always() must be bypassed when auto-approve is on");
assert(!gated((c) => c.toolName === "mcp_call")(ctx), "predicate gate must be bypassed when auto-approve is on");
assert(!gated(() => true)(ctx), "a hard always-true predicate must still be bypassed when auto-approve is on");

// Restoring the off value re-enables gating at call time (no module-load caching).
process.env.CLANKY_AUTO_APPROVE = "0";
assert(gated(always())(ctx), "setting CLANKY_AUTO_APPROVE=0 must restore approval prompting");
delete process.env.CLANKY_AUTO_APPROVE;

console.log("approvals-smoke: ok");
