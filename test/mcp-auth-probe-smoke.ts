import { inspectConnectionSearchOutput } from "../agent/lib/mcp-auth-probe.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const unauthorized = inspectConnectionSearchOutput(
	[
		{
			connection: "linear",
			description: "Linear workspace connection",
			needsAuthorization: true,
		},
	],
	"linear",
);
assert(unauthorized.matchedConnection, "unauthorized result should match linear");
assert(unauthorized.needsAuthorization, "unauthorized result should report needsAuthorization");
assert(!unauthorized.sawUsableTool, "unauthorized result should not report a usable tool");
assert(unauthorized.errors.length === 0, "unauthorized result should not invent errors");

const authorized = inspectConnectionSearchOutput(
	[
		{
			connection: "linear",
			description: "List issues",
			qualifiedName: "connection__linear__list_issues",
			tool: "list_issues",
		},
	],
	"linear",
);
assert(authorized.matchedConnection, "authorized result should match linear");
assert(!authorized.needsAuthorization, "authorized result should not need authorization");
assert(authorized.sawUsableTool, "authorized result should report a usable tool");

const wrapped = inspectConnectionSearchOutput(
	{
		type: "json",
		value: JSON.stringify([
			{
				connection: "figma",
				description: "Figma workspace connection",
				error: "Authorization failed for figma: token rejected",
			},
		]),
	},
	"figma",
);
assert(wrapped.matchedConnection, "wrapped result should match figma");
assert(wrapped.errors.length === 1, "wrapped result should preserve connection errors");

const unrelated = inspectConnectionSearchOutput(
	[
		{
			connection: "figma",
			description: "Figma workspace connection",
			needsAuthorization: true,
		},
	],
	"linear",
);
assert(!unrelated.matchedConnection, "unrelated result should not match linear");
assert(!unrelated.needsAuthorization, "unrelated result should not affect linear auth state");

console.log("ALL OK");
