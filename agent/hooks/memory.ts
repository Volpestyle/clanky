import { defineHook } from "eve/hooks";
import { rememberRuntimeMessageFacts } from "../lib/runtime-memory.ts";

export default defineHook({
	events: {
		async "message.received"(event, ctx) {
			try {
				await rememberRuntimeMessageFacts({
					message: event.data.message,
					sessionId: ctx.session.id,
					turnId: event.data.turnId,
					channelKind: ctx.channel.kind,
					authPrincipalId: ctx.session.auth.current?.principalId,
					authAuthenticator: ctx.session.auth.current?.authenticator,
					authAttributes: ctx.session.auth.current?.attributes,
				});
			} catch (error) {
				console.error("runtime memory capture failed:", error);
			}
		},
	},
});
