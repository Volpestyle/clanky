export interface SkillPromptInput {
	prompt: string;
	skill?: string;
}

export function formatSkillPrompt(input: SkillPromptInput): string {
	if (input.skill === undefined) return input.prompt;
	return `/skill:${input.skill} \n\n${input.prompt}`;
}
