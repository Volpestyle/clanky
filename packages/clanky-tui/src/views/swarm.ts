import type { SwarmSnapshotGatewayResult } from "@clanky/gateway";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function renderSwarmView(result: SwarmSnapshotGatewayResult): string {
	const lines = ["Swarm"];
	if (!result.ok) {
		lines.push(`  ${result.state}: ${result.message}`);
		return lines.join("\n");
	}
	const instances = countArray(result.instances);
	const tasks = countArray(result.tasks);
	const heldLocks = countArray(recordArrayField(result.health, "held_locks"));
	const blockingLocks = countArray(recordArrayField(result.health, "blocking_locks"));
	const warnings = countArray(recordArrayField(result.health, "warnings"));
	lines.push(`  peers: ${instances}`);
	lines.push(`  tasks: ${tasks}`);
	lines.push(`  locks: held=${heldLocks} blocking=${blockingLocks} warnings=${warnings}`);
	for (const instance of firstRecords(result.instances, 6)) {
		const id = (stringField(instance, "instance_id") ?? stringField(instance, "id") ?? "(no-id)").slice(0, 8);
		const label = stringField(instance, "label") ?? stringField(instance, "directory") ?? "";
		lines.push(`  peer ${id}  ${fixedCell(label, 68)}`);
	}
	if (instances > 6) lines.push(`  ... ${instances - 6} more peers`);
	for (const lock of recordArrayField(result.health, "held_locks").slice(0, 4)) {
		lines.push(renderLockRow("held", lock));
	}
	for (const lock of recordArrayField(result.health, "blocking_locks").slice(0, 4)) {
		lines.push(renderLockRow("block", lock));
	}
	for (const task of firstRecords(result.tasks, 8)) {
		const id = stringField(task, "id")?.slice(0, 8) ?? "(no-id)";
		const status = stringField(task, "status") ?? "unknown";
		const title = stringField(task, "title") ?? "";
		lines.push(`  ${id}  ${fixedCell(status, 10)}  ${fixedCell(title, 64)}`);
	}
	if (tasks > 8) lines.push(`  ... ${tasks - 8} more`);
	return lines.join("\n");
}

function renderLockRow(kind: "held" | "block", lock: Record<string, unknown>): string {
	const file = stringField(lock, "file") ?? stringField(lock, "path") ?? "(unknown)";
	const owner =
		stringField(lock, "instance_id")?.slice(0, 8) ?? stringField(lock, "owner_id")?.slice(0, 8) ?? "(unknown)";
	return `  ${kind} ${owner}  ${fixedCell(file, 72)}`;
}

function fixedCell(value: string, width: number): string {
	const text = truncateToWidth(value.replace(/\s+/g, " ").trim(), width);
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function countArray(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	return 0;
}

function firstRecords(value: unknown, limit: number): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	const records: Array<Record<string, unknown>> = [];
	for (const item of value) {
		if (typeof item === "object" && item !== null && !Array.isArray(item)) {
			records.push(item as Record<string, unknown>);
		}
		if (records.length >= limit) return records;
	}
	return records;
}

function recordArrayField(value: unknown, key: string): Array<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return firstRecords((value as Record<string, unknown>)[key], Number.POSITIVE_INFINITY);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" ? item : undefined;
}
