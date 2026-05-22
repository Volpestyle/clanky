import { runChat } from "../src/chat.ts";

const socketFile = process.argv[2];
if (socketFile === undefined || socketFile.trim().length === 0) {
	throw new Error("Usage: run-chat-child <socket-file> [session-id]");
}
const sessionId = process.argv[3];

await runChat({
	socketFile,
	...(sessionId === undefined ? {} : { sessionId }),
});
