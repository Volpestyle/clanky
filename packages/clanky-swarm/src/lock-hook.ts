export interface SwarmFileLockDecision {
	blocked: boolean;
	ownerId?: string;
	ownerLabel?: string;
	reason?: string;
}

export function decideSwarmFileLock(
	file: string,
	active: unknown,
	instanceId: string | undefined,
): SwarmFileLockDecision {
	if (active === null || active === undefined) return { blocked: false };
	const activeRecord = recordOrUndefined(active);
	if (activeRecord === undefined) {
		return {
			blocked: true,
			reason: `Swarm file lock for ${file} has an unreadable owner record.`,
		};
	}
	if (activeRecord.hidden === true) {
		const reason = stringProperty(activeRecord, "reason");
		return {
			blocked: true,
			reason: `Swarm file lock for ${file} is hidden${reason === undefined ? "" : `: ${reason}`}.`,
		};
	}
	const ownerRecord = recordOrUndefined(activeRecord.owner);
	const ownerId = stringProperty(activeRecord, "instance_id") ?? stringProperty(ownerRecord, "id");
	const ownerLabel = stringProperty(ownerRecord, "label");
	if (ownerId === undefined) {
		return {
			blocked: true,
			reason: `Swarm file lock for ${file} exists without an owner id.`,
		};
	}
	if (ownerId === instanceId) {
		const decision: SwarmFileLockDecision = { blocked: false };
		decision.ownerId = ownerId;
		if (ownerLabel !== undefined) decision.ownerLabel = ownerLabel;
		return decision;
	}
	const decision: SwarmFileLockDecision = {
		blocked: true,
		ownerId,
		reason: `Swarm lock held by ${ownerLabel ?? ownerId}; aborting write to ${file}.`,
	};
	if (ownerLabel !== undefined) decision.ownerLabel = ownerLabel;
	return decision;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringProperty(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const item = value?.[key];
	return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}
