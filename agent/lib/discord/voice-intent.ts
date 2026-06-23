/**
 * "Hop in vc" intent detection for Clanky's voice presence (SPEC.md §5.3).
 *
 * Pure and testable. The host runs this on already-accepted (addressed) messages
 * to decide whether the human is asking Clanky to join or leave a voice channel,
 * before the normal chat turn runs.
 */
export type VoiceIntent = "join" | "leave";

const VOICE_SURFACE = /\b(vc|voice(?:\s*chat)?|the\s*call|huddle)\b/;
const LEAVE_VERB = /\b(leave|get\s*out|drop|hop\s*out|hang\s*up|disconnect|get\s*off|dip|bounce)\b/;
const JOIN_VERB = /\b(join|hop\s*(?:in|on)|jump\s*in|get\s*(?:in|on)|come(?:\s*to)?|connect|pop\s*in|slide\s*in)\b/;

export function detectVoiceIntent(text: string): VoiceIntent | null {
	const normalized = text.toLowerCase();
	if (!VOICE_SURFACE.test(normalized)) return null;
	if (LEAVE_VERB.test(normalized)) return "leave";
	if (JOIN_VERB.test(normalized)) return "join";
	return null;
}
