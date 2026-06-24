import { defineTool } from "eve/tools";
import type { NeedsApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { gated } from "../lib/approvals.ts";
import { callBrowserBridge, type BrowserBridgeOp } from "../lib/browser-bridge.ts";

const paramsSchema = z.record(z.string(), z.unknown()).optional();
const browserBridgeOpSchema = z.enum([
	"status",
	"open_tab",
	"navigate",
	"list_tabs",
	"close_tab",
	"snapshot",
	"read_text",
	"query",
	"eval",
	"fill",
	"wait_for",
	"screenshot",
	"click",
	"double_click",
	"type",
	"key",
	"scroll",
	"drag",
	"hover",
	"back",
	"forward",
	"reload",
	"wait",
]);
const browserControlInputSchema = z.object({
	op: browserBridgeOpSchema,
	params: paramsSchema.describe("Parameters for the selected op, matching the browser bridge API."),
});
type BrowserControlInput = z.infer<typeof browserControlInputSchema>;
const MUTATING_BROWSER_OPS: ReadonlySet<BrowserBridgeOp> = new Set([
	"open_tab",
	"navigate",
	"close_tab",
	"eval",
	"fill",
	"click",
	"double_click",
	"type",
	"key",
	"scroll",
	"drag",
	"hover",
	"back",
	"forward",
	"reload",
	"wait",
]);

export function browserControlNeedsApproval(ctx: NeedsApprovalContext<BrowserControlInput>): boolean {
	const op = ctx.toolInput?.op;
	if (op === undefined) return true;
	if (!MUTATING_BROWSER_OPS.has(op)) return false;
	return !ctx.approvedTools.has(ctx.toolName);
}

export default defineTool({
	needsApproval: gated(browserControlNeedsApproval),
	description:
		"Control the user's real Chromium-family browser through Clanky's local browser-bridge extension. Read-only ops are status, list_tabs, snapshot, read_text, query, wait_for, and screenshot. Browser-control ops such as open_tab, navigate, eval, fill, click, type, key, scroll, drag, hover, history navigation, reload, close_tab, and wait require approval once per session.",
	inputSchema: browserControlInputSchema,
	async execute(input) {
		return await callBrowserBridge(input);
	},
	toModelOutput(output) {
		if (typeof output === "object" && output !== null && "dataUrl" in output) {
			const record = output as Record<string, unknown>;
			return {
				type: "json",
				value: {
					...record,
					dataUrl: typeof record.dataUrl === "string" ? `${record.dataUrl.slice(0, 80)}...` : record.dataUrl,
				},
			};
		}
		return { type: "json", value: output };
	},
});
