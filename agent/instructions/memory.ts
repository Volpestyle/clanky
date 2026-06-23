import { defineDynamic, defineInstructions } from "eve/instructions";
import { buildMemoryContext } from "../lib/memory.ts";

export default defineDynamic({
	events: {
		"turn.started": async (_event, ctx) => {
			const parsedLimit = Number.parseInt(process.env.CLANKY_MEMORY_CONTEXT_LIMIT ?? "16", 10);
			const limit = Number.isFinite(parsedLimit) ? Math.max(0, Math.min(50, parsedLimit)) : 16;
			if (limit <= 0) return null;
			const markdown = await buildMemoryContext({
				limit,
				messages: ctx.messages,
				channelMetadata: ctx.channel.metadata,
				authPrincipalId: ctx.session.auth.current?.principalId,
				authAuthenticator: ctx.session.auth.current?.authenticator,
				authAttributes: ctx.session.auth.current?.attributes,
			});
			return markdown.length === 0 ? null : defineInstructions({ markdown });
		},
	},
});
