export type ClankyNewSessionCommandOptions = {
	readonly quiet?: boolean;
};

export type ClankyNewSessionCommandOutcome = {
	readonly clearTranscript: true;
	readonly newSession: true;
	readonly announceNewSession?: false;
};

export type ClankyCommandResultAnnouncement = {
	readonly announceNewSession?: boolean;
	readonly newSession?: boolean;
};

export function clankyNewSessionCommandOutcome(options: ClankyNewSessionCommandOptions = {}): ClankyNewSessionCommandOutcome {
	if (options.quiet === true) return { clearTranscript: true, newSession: true, announceNewSession: false };
	return { clearTranscript: true, newSession: true };
}

export function shouldAnnounceNewSessionCommand(outcome: ClankyCommandResultAnnouncement): boolean {
	return outcome.newSession === true && outcome.announceNewSession !== false;
}
