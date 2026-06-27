import {
	clankyNewSessionCommandOutcome,
	shouldAnnounceNewSessionCommand,
} from "../agent/lib/clanky-command-result.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const announced = clankyNewSessionCommandOutcome();
assert(announced.clearTranscript === true, "/new should clear the transcript");
assert(announced.newSession === true, "/new should start a new session");
assert(shouldAnnounceNewSessionCommand(announced), "/new should announce the new session");

const quiet = clankyNewSessionCommandOutcome({ quiet: true });
assert(quiet.clearTranscript === true, "/n should clear the transcript");
assert(quiet.newSession === true, "/n should start a new session");
assert(!shouldAnnounceNewSessionCommand(quiet), "/n should not print a command result");

assert(!shouldAnnounceNewSessionCommand({}), "non-session commands should not announce a new session");
