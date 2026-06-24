import { defineHook } from "eve/hooks";
import { createPetClient } from "../lib/pet.ts";

// Mirror Clanky's runtime activity onto a petdex desktop pet. Optional: enabled
// with CLANKY_PET=1, no-ops otherwise (see lib/pet.ts). Because Clanky's
// free-will Discord presence runs each conversation as its own eve session,
// this single hook covers the face pane, Discord text/voice, and spawned work
// without per-channel wiring. The sidecar coalesces rapid transitions, so we
// fire freely and let it smooth the animation.
const pet = createPetClient();

// Working states carry a duration so a long turn keeps animating and the
// sidecar auto-reverts to idle if events stop arriving; each new step refreshes
// it. Reactions are short so the sprite settles back to whatever follows.
const WORKING_DURATION_MS = 12_000;
const REACTION_DURATION_MS = 2_500;
const FAILED_DURATION_MS = 4_000;

export default defineHook({
	events: {
		"turn.started"() {
			pet.setState("running", WORKING_DURATION_MS);
		},
		"step.started"() {
			pet.setState("running", WORKING_DURATION_MS);
		},
		"actions.requested"() {
			pet.setState("running", WORKING_DURATION_MS);
		},
		"subagent.called"(event) {
			pet.setState("jumping", REACTION_DURATION_MS);
			pet.say(`spawning ${event.data.name}`);
		},
		"subagent.started"() {
			pet.setState("jumping", REACTION_DURATION_MS);
		},
		"message.completed"(event) {
			if (event.data.message === null) return;
			pet.setState("waving", REACTION_DURATION_MS);
			pet.say(event.data.message);
		},
		"session.waiting"() {
			pet.setState("waiting");
		},
		"turn.completed"() {
			pet.setState("idle");
		},
		"session.completed"() {
			pet.setState("idle");
		},
		"turn.failed"(event) {
			pet.setState("failed", FAILED_DURATION_MS);
			pet.say(event.data.message);
		},
		"step.failed"(event) {
			pet.setState("failed", FAILED_DURATION_MS);
			pet.say(event.data.message);
		},
		"session.failed"(event) {
			pet.setState("failed", FAILED_DURATION_MS);
			pet.say(event.data.message);
		},
	},
});
