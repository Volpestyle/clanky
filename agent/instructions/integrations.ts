import { defineDynamic, defineInstructions } from "eve/instructions";
import { INTEGRATION_ROLES, type IntegrationRoleBindings, resolveRoleBindings } from "../lib/integration-roles.ts";

export default defineDynamic({
	events: {
		"turn.started": async () => {
			const bindings = await resolveRoleBindings();
			return defineInstructions({ markdown: integrationInstructions(bindings) });
		},
	},
});

export function integrationInstructions(bindings: IntegrationRoleBindings): string {
	const lines = [
		"## Active integration role bindings",
		"",
		...INTEGRATION_ROLES.map((role) => roleInstructionLine(role, bindings[role.key])),
		"",
		"For any unset role, say the role is not configured instead of guessing. For work-tracker updates, report `tracker_update_skipped`.",
		"Never route OAuth or shared-credential SaaS role work through `mcp_*`; use the configured connection or say it is not configured.",
	];
	return lines.join("\n");
}

function roleInstructionLine(
	role: (typeof INTEGRATION_ROLES)[number],
	connectionName: string | undefined,
): string {
	const label = role.label;
	if (role.key === "workTracker") {
		return connectionName === undefined
			? "- Your work tracker is not configured."
			: `- Your work tracker is the ${connectionName} connection; use connection__${connectionName}__* for issues, status, and follow-up.`;
	}
	if (role.key === "designTool") {
		return connectionName === undefined
			? "- Your design tool is not configured."
			: `- Your design tool is the ${connectionName} connection; use connection__${connectionName}__* for design, components, specs, and visual references.`;
	}
	return connectionName === undefined
		? `- Your ${label} is not configured.`
		: `- Your ${label} is the ${connectionName} connection; use connection__${connectionName}__* for role-specific work.`;
}
