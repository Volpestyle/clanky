import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderClankyOutline } from "./clanky-outline.ts";
import type { ClankySkillInventoryEntry } from "./skill-inventory.ts";

export type ClankySkillsPanelTheme = {
	readonly bold: (text: string) => string;
	readonly cyan: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly yellow: (text: string) => string;
};

export function renderClankySkillsPanel(
	entries: readonly ClankySkillInventoryEntry[],
	width: number,
	theme: ClankySkillsPanelTheme,
): string[] {
	const panelWidth = Math.max(4, Math.floor(width));
	const innerWidth = Math.max(1, panelWidth - 4);
	const agentSkills = entries.filter((entry) => entry.scope === "agent");
	const bundledSkills = entries.filter((entry) => entry.scope === "bundled");
	const lines = [
		`${theme.bold("Clanky skills")} ${theme.dim(`${entries.length} ${pluralWord(entries.length, "skill")}`)}`,
		...wrapTextWithAnsi(theme.dim("agent = Eve-visible brain skills; bundled = operator/worker packages on disk"), innerWidth),
	];
	appendSkillSection(lines, "Agent skills", "agent", agentSkills, innerWidth, theme);
	appendSkillSection(lines, "Bundled skills", "bundled", bundledSkills, innerWidth, theme);
	return renderClankyOutline(lines, panelWidth, theme.dim);
}

function appendSkillSection(
	lines: string[],
	title: string,
	scope: ClankySkillInventoryEntry["scope"],
	entries: readonly ClankySkillInventoryEntry[],
	innerWidth: number,
	theme: ClankySkillsPanelTheme,
): void {
	lines.push("", formatSkillsSectionHeader(title, scope, entries, theme));
	if (entries.length === 0) {
		lines.push(theme.dim("No skills found."));
		return;
	}
	for (const entry of entries) lines.push(...formatSkillRosterRows(entry, innerWidth, theme));
}

function formatSkillsSectionHeader(
	title: string,
	scope: ClankySkillInventoryEntry["scope"],
	entries: readonly ClankySkillInventoryEntry[],
	theme: ClankySkillsPanelTheme,
): string {
	const coloredTitle = scope === "agent" ? theme.cyan(theme.bold(title)) : theme.yellow(theme.bold(title));
	return `${coloredTitle} ${theme.dim(`${entries.length} ${pluralWord(entries.length, "skill")}`)}`;
}

function formatSkillRosterRows(
	entry: ClankySkillInventoryEntry,
	innerWidth: number,
	theme: ClankySkillsPanelTheme,
): string[] {
	const scopeWidth = 7;
	const minNameWidth = 8;
	const minDescriptionWidth = 12;
	if (innerWidth < scopeWidth + 1 + minNameWidth) {
		return [truncateToWidth(`${entry.scope} ${entry.name}`, innerWidth, "", true)];
	}
	if (innerWidth < 72) {
		return formatNarrowSkillRosterRows(entry, innerWidth, theme);
	}
	const availableAfterScope = innerWidth - scopeWidth - 1;
	const canShowDescription = availableAfterScope >= minNameWidth + 1 + minDescriptionWidth;
	const nameWidth = canShowDescription
		? Math.min(26, availableAfterScope - 1 - minDescriptionWidth)
		: availableAfterScope;
	const descriptionWidth = canShowDescription ? Math.max(1, availableAfterScope - nameWidth - 1) : 0;
	const scope = skillScopeColumn(entry.scope, theme);
	const name = theme.bold(padVisible(truncateToWidth(entry.name, nameWidth, "", true), nameWidth));
	if (descriptionWidth <= 0) return [`${scope} ${name}`];
	const continuationPrefix = `${padVisible("", scopeWidth)} ${padVisible("", nameWidth)} `;
	const descriptionLines = wrapTextWithAnsi(entry.description, descriptionWidth);
	return descriptionLines.map((line, index) => {
		const paddedDescription = padVisible(truncateToWidth(line, descriptionWidth, "", true), descriptionWidth);
		return index === 0
			? `${scope} ${name} ${paddedDescription}`
			: `${theme.dim(continuationPrefix)}${paddedDescription}`;
	});
}

function formatNarrowSkillRosterRows(
	entry: ClankySkillInventoryEntry,
	innerWidth: number,
	theme: ClankySkillsPanelTheme,
): string[] {
	const scopeWidth = 7;
	const nameWidth = Math.max(1, innerWidth - scopeWidth - 1);
	const scope = skillScopeColumn(entry.scope, theme);
	const name = theme.bold(truncateToWidth(entry.name, nameWidth, "", true));
	const descriptionIndent = "  ";
	const descriptionWidth = Math.max(1, innerWidth - visibleWidth(descriptionIndent));
	return [
		`${scope} ${name}`,
		...wrapTextWithAnsi(entry.description, descriptionWidth).map((line) => `${theme.dim(descriptionIndent)}${truncateToWidth(line, descriptionWidth, "", true)}`),
	];
}

function skillScopeColumn(scope: ClankySkillInventoryEntry["scope"], theme: ClankySkillsPanelTheme): string {
	const label = padVisible(scope, 7);
	return scope === "agent" ? theme.cyan(label) : theme.yellow(label);
}

function pluralWord(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
