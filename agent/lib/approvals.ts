import type { NeedsApprovalContext } from "eve/tools/approval";

// Global auto-approve switch. When CLANKY_AUTO_APPROVE is truthy, every approval
// gate (tool needsApproval and connection approval) resolves to "no approval
// needed", so Clanky never parks a turn waiting for a human decision. The face
// can't yet render input.requested prompts (SPEC.md §4.2 known gap), so this is
// also the practical way to keep approval-gated tools from hanging. Toggle with
// `/approvals auto` in the face (writes .env.local + restarts the brain) or set
// CLANKY_AUTO_APPROVE=1 in .env.local directly.
export function isAutoApproveValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// Read at call time (not module load) so a brain restart picks up a changed
// .env.local without stale state.
export function autoApproveAll(): boolean {
	return isAutoApproveValue(process.env.CLANKY_AUTO_APPROVE);
}

// Wraps a needsApproval / connection approval predicate so auto-approve mode
// forces it off. Every tool and connection that would otherwise gate runs its
// predicate through this.
export function gated<TInput = unknown>(
	needsApproval: (ctx: NeedsApprovalContext<TInput>) => boolean,
): (ctx: NeedsApprovalContext<TInput>) => boolean {
	return (ctx) => (autoApproveAll() ? false : needsApproval(ctx));
}
