import { visibleWidth } from "@earendil-works/pi-tui";

// Frame data ported from expo-agent-spinners (MIT © eronred):
// /Users/james/dev/expo-agent-spinners/src/components/spinners
export type AgentSpinnerDefinition = {
	readonly frames: readonly string[];
	readonly intervalMs: number;
};

export type AgentSpinnerCustomSelection = `custom:${string}`;
export type AgentSpinnerSelection = AgentSpinnerName | AgentSpinnerPresetName | AgentSpinnerCustomSelection | typeof AGENT_SPINNER_CYCLE_NAME;

export type ResolvedAgentSpinner = {
	readonly name: AgentSpinnerSelection;
	readonly frames: string[];
	readonly intervalMs: number;
};

export const AGENT_SPINNERS = {
	arc: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], intervalMs: 100 },
	arrow: { frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], intervalMs: 100 },
	balloon: { frames: [".", "o", "O", "o", "."], intervalMs: 120 },
	bounce: { frames: ["⠁", "⠂", "⠄", "⡀", "⠄", "⠂"], intervalMs: 120 },
	breathe: { frames: ["⠀", "⠂", "⠌", "⡑", "⢕", "⢝", "⣫", "⣟", "⣿", "⣟", "⣫", "⢝", "⢕", "⡑", "⠌", "⠂", "⠀"], intervalMs: 100 },
	cascade: { frames: ["⠀⠀⠀⠀", "⠀⠀⠀⠀", "⠁⠀⠀⠀", "⠋⠀⠀⠀", "⠞⠁⠀⠀", "⡴⠋⠀⠀", "⣠⠞⠁⠀", "⢀⡴⠋⠀", "⠀⣠⠞⠁", "⠀⢀⡴⠋", "⠀⠀⣠⠞", "⠀⠀⢀⡴", "⠀⠀⠀⣠", "⠀⠀⠀⢀"], intervalMs: 60 },
	"checkerboard": { frames: ["⢕⢕⢕", "⡪⡪⡪", "⢊⠔⡡", "⡡⢊⠔"], intervalMs: 250 },
	"circle-halves": { frames: ["◐", "◓", "◑", "◒"], intervalMs: 50 },
	"circle-quarters": { frames: ["◴", "◷", "◶", "◵"], intervalMs: 120 },
	columns: { frames: ["⡀⠀⠀", "⡄⠀⠀", "⡆⠀⠀", "⡇⠀⠀", "⣇⠀⠀", "⣧⠀⠀", "⣷⠀⠀", "⣿⠀⠀", "⣿⡀⠀", "⣿⡄⠀", "⣿⡆⠀", "⣿⡇⠀", "⣿⣇⠀", "⣿⣧⠀", "⣿⣷⠀", "⣿⣿⠀", "⣿⣿⡀", "⣿⣿⡄", "⣿⣿⡆", "⣿⣿⡇", "⣿⣿⣇", "⣿⣿⣧", "⣿⣿⣷", "⣿⣿⣿", "⣿⣿⣿", "⠀⠀⠀"], intervalMs: 60 },
	diagswipe: { frames: ["⠁⠀", "⠋⠀", "⠟⠁", "⡿⠋", "⣿⠟", "⣿⡿", "⣿⣿", "⣿⣿", "⣾⣿", "⣴⣿", "⣠⣾", "⢀⣴", "⠀⣠", "⠀⢀", "⠀⠀", "⠀⠀"], intervalMs: 60 },
	"dots": { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
	"dots-circle": { frames: ["⢎⠀", "⠎⠁", "⠊⠑", "⠈⠱", "⠀⡱", "⢀⡰", "⢄⡠", "⢆⡀"], intervalMs: 80 },
	"dots2": { frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"], intervalMs: 80 },
	"dots3": { frames: ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"], intervalMs: 80 },
	"dots4": { frames: ["⠄", "⠆", "⠇", "⠋", "⠙", "⠸", "⠰", "⠠", "⠰", "⠸", "⠙", "⠋", "⠇", "⠆"], intervalMs: 80 },
	"dots5": { frames: ["⠋", "⠙", "⠚", "⠒", "⠂", "⠂", "⠒", "⠲", "⠴", "⠦", "⠖", "⠒", "⠐", "⠐", "⠒", "⠓", "⠋"], intervalMs: 80 },
	"dots6": { frames: ["⠁", "⠉", "⠙", "⠚", "⠒", "⠂", "⠂", "⠒", "⠲", "⠴", "⠤", "⠄", "⠄", "⠤", "⠴", "⠲", "⠒", "⠂", "⠂", "⠒", "⠚", "⠙", "⠉", "⠁"], intervalMs: 80 },
	"dots7": { frames: ["⠈", "⠉", "⠋", "⠓", "⠒", "⠐", "⠐", "⠒", "⠖", "⠦", "⠤", "⠠", "⠠", "⠤", "⠦", "⠖", "⠒", "⠐", "⠐", "⠒", "⠓", "⠋", "⠉", "⠈"], intervalMs: 80 },
	"dots8": { frames: ["⠁", "⠁", "⠉", "⠙", "⠚", "⠒", "⠂", "⠂", "⠒", "⠲", "⠴", "⠤", "⠄", "⠄", "⠤", "⠠", "⠠", "⠤", "⠦", "⠖", "⠒", "⠐", "⠐", "⠒", "⠓", "⠋", "⠉", "⠈", "⠈"], intervalMs: 80 },
	"dots9": { frames: ["⢹", "⢺", "⢼", "⣸", "⣇", "⡧", "⡗", "⡏"], intervalMs: 80 },
	"dots10": { frames: ["⢄", "⢂", "⢁", "⡁", "⡈", "⡐", "⡠"], intervalMs: 80 },
	"dots11": { frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"], intervalMs: 100 },
	"dots12": { frames: ["⢀⠀", "⡀⠀", "⠄⠀", "⢂⠀", "⡂⠀", "⠅⠀", "⢃⠀", "⡃⠀", "⠍⠀", "⢋⠀", "⡋⠀", "⠍⠁", "⢋⠁", "⡋⠁", "⠍⠉", "⠋⠉", "⠋⠉", "⠉⠙", "⠉⠙", "⠉⠩", "⠈⢙", "⠈⡙", "⢈⠩", "⡀⢙", "⠄⡙", "⢂⠩", "⡂⢘", "⠅⡘", "⢃⠨", "⡃⢐", "⠍⡐", "⢋⠠", "⡋⢀", "⠍⡁", "⢋⠁", "⡋⠁", "⠍⠉", "⠋⠉", "⠋⠉", "⠉⠙", "⠉⠙", "⠉⠩", "⠈⢙", "⠈⡙", "⠈⠩", "⠀⢙", "⠀⡙", "⠀⠩", "⠀⢘", "⠀⡘", "⠀⠨", "⠀⢐", "⠀⡐", "⠀⠠", "⠀⢀", "⠀⡀"], intervalMs: 80 },
	"dots13": { frames: ["⣼", "⣹", "⢻", "⠿", "⡟", "⣏", "⣧", "⣶"], intervalMs: 80 },
	"dots14": { frames: ["⠉⠉", "⠈⠙", "⠀⠹", "⠀⢸", "⠀⣰", "⢀⣠", "⣀⣀", "⣄⡀", "⣆⠀", "⡇⠀", "⠏⠀", "⠋⠁"], intervalMs: 80 },
	"double-arrow": { frames: ["⇐", "⇖", "⇑", "⇗", "⇒", "⇘", "⇓", "⇙"], intervalMs: 100 },
	dqpb: { frames: ["d", "q", "p", "b"], intervalMs: 100 },
	fillsweep: { frames: ["⣀⣀", "⣤⣤", "⣶⣶", "⣿⣿", "⣿⣿", "⣿⣿", "⣶⣶", "⣤⣤", "⣀⣀", "⠀⠀", "⠀⠀"], intervalMs: 100 },
	"grow-horizontal": { frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"], intervalMs: 120 },
	"grow-vertical": { frames: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"], intervalMs: 120 },
	helix: { frames: ["⢌⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉"], intervalMs: 80 },
	noise: { frames: ["▓", "▒", "░", " ", "░", "▒"], intervalMs: 100 },
	orbit: { frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"], intervalMs: 100 },
	point: { frames: ["···", "•··", "·•·", "··•", "···"], intervalMs: 200 },
	pulse: { frames: ["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"], intervalMs: 180 },
	rain: { frames: ["⢁⠂⠔⠈", "⠂⠌⡠⠐", "⠄⡐⢀⠡", "⡈⠠⠀⢂", "⠐⢀⠁⠄", "⠠⠁⠊⡀", "⢁⠂⠔⠈", "⠂⠌⡠⠐", "⠄⡐⢀⠡", "⡈⠠⠀⢂", "⠐⢀⠁⠄", "⠠⠁⠊⡀"], intervalMs: 100 },
	"rolling-line": { frames: ["/", "-", "\\", "|", "\\", "-"], intervalMs: 80 },
	sand: { frames: ["⠁", "⠂", "⠄", "⡀", "⡈", "⡐", "⡠", "⣀", "⣁", "⣂", "⣄", "⣌", "⣔", "⣤", "⣥", "⣦", "⣮", "⣶", "⣷", "⣿", "⡿", "⠿", "⢟", "⠟", "⡛", "⠛", "⠫", "⢋", "⠋", "⠍", "⡉", "⠉", "⠑", "⠡", "⢁"], intervalMs: 80 },
	scan: { frames: ["⠀⠀⠀⠀", "⡇⠀⠀⠀", "⣿⠀⠀⠀", "⢸⡇⠀⠀", "⠀⣿⠀⠀", "⠀⢸⡇⠀", "⠀⠀⣿⠀", "⠀⠀⢸⡇", "⠀⠀⠀⣿", "⠀⠀⠀⢸"], intervalMs: 70 },
	"simple-dots": { frames: [".  ", ".. ", "...", "   "], intervalMs: 400 },
	"simple-dots-scrolling": { frames: [".  ", ".. ", "...", " ..", "  .", "   "], intervalMs: 200 },
	snake: { frames: ["⣁⡀", "⣉⠀", "⡉⠁", "⠉⠉", "⠈⠙", "⠀⠛", "⠐⠚", "⠒⠒", "⠖⠂", "⠶⠀", "⠦⠄", "⠤⠤", "⠠⢤", "⠀⣤", "⢀⣠", "⣀⣀"], intervalMs: 80 },
	sparkle: { frames: ["⡡⠊⢔⠡", "⠊⡰⡡⡘", "⢔⢅⠈⢢", "⡁⢂⠆⡍", "⢔⠨⢑⢐", "⠨⡑⡠⠊"], intervalMs: 150 },
	"square-corners": { frames: ["◰", "◳", "◲", "◱"], intervalMs: 180 },
	toggle: { frames: ["⊶", "⊷"], intervalMs: 250 },
	triangle: { frames: ["◢", "◣", "◤", "◥"], intervalMs: 50 },
	wave: { frames: ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"], intervalMs: 100 },
	waverows: { frames: ["⠖⠉⠉⠑", "⡠⠖⠉⠉", "⣠⡠⠖⠉", "⣄⣠⡠⠖", "⠢⣄⣠⡠", "⠙⠢⣄⣠", "⠉⠙⠢⣄", "⠊⠉⠙⠢", "⠜⠊⠉⠙", "⡤⠜⠊⠉", "⣀⡤⠜⠊", "⢤⣀⡤⠜", "⠣⢤⣀⡤", "⠑⠣⢤⣀", "⠉⠑⠣⢤", "⠋⠉⠑⠣"], intervalMs: 90 },
} as const satisfies Record<string, AgentSpinnerDefinition>;

export type AgentSpinnerName = keyof typeof AGENT_SPINNERS;

export const AGENT_SPINNER_NAMES = Object.keys(AGENT_SPINNERS).sort() as AgentSpinnerName[];
export const AGENT_SPINNER_WIDTH_PRESETS = {
	"width-1": spinnerNamesAtWidth(1),
	"width-2": spinnerNamesAtWidth(2),
	"width-3": spinnerNamesAtWidth(3),
	"width-4": spinnerNamesAtWidth(4),
} as const satisfies Record<string, readonly AgentSpinnerName[]>;
export const AGENT_SPINNER_CYCLE_PRESETS = {
	micro: ["arc", "dots", "dots2", "dots9", "circle-quarters", "grow-horizontal", "grow-vertical", "triangle"],
	needle: ["arrow", "double-arrow", "arc", "circle-halves", "circle-quarters", "square-corners", "triangle"],
	terminal: ["rolling-line", "dqpb", "balloon", "toggle", "noise"],
	"sweep-2": ["snake", "dots-circle", "dots12", "dots14", "fillsweep", "diagswipe"],
	"pulse-3": ["simple-dots", "simple-dots-scrolling", "point", "pulse", "columns", "checkerboard"],
	"ribbon-4": ["wave", "scan", "rain", "sparkle", "cascade", "waverows", "helix"],
} as const satisfies Record<string, readonly AgentSpinnerName[]>;
export const AGENT_SPINNER_PRESETS = {
	...AGENT_SPINNER_WIDTH_PRESETS,
	...AGENT_SPINNER_CYCLE_PRESETS,
} as const satisfies Record<string, readonly AgentSpinnerName[]>;
export type AgentSpinnerPresetName = keyof typeof AGENT_SPINNER_PRESETS;
export const AGENT_SPINNER_PRESET_NAMES = Object.keys(AGENT_SPINNER_PRESETS).sort() as AgentSpinnerPresetName[];
export const AGENT_SPINNER_CYCLE_NAMES = [
	"arc",
	"dots",
	"arrow",
	"circle-quarters",
	"dots2",
	"double-arrow",
	"rolling-line",
	"dots3",
	"simple-dots-scrolling",
	"dots4",
	"triangle",
	"dots5",
	"grow-horizontal",
	"dots6",
	"dqpb",
	"dots7",
	"simple-dots",
	"dots8",
	"balloon",
	"dots9",
	"circle-halves",
	"dots10",
	"point",
	"dots11",
	"square-corners",
	"dots12",
	"toggle",
	"dots13",
	"grow-vertical",
	"dots14",
	"noise",
	"sand",
	"bounce",
	"dots-circle",
	"wave",
	"scan",
	"rain",
	"pulse",
	"snake",
	"sparkle",
	"cascade",
	"columns",
	"orbit",
	"breathe",
	"waverows",
	"checkerboard",
	"helix",
	"fillsweep",
	"diagswipe",
] as const satisfies readonly AgentSpinnerName[];
export const AGENT_SPINNER_CYCLE_NAME = "cycle";
export const DEFAULT_AGENT_SPINNER_NAME = AGENT_SPINNER_CYCLE_NAME;
export const ASCII_AGENT_SPINNER_NAME = "rolling-line" satisfies AgentSpinnerName;
export const AGENT_SPINNER_CYCLE_INTERVAL_MS = 100;
export const DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS = 800;

export function normalizeAgentSpinnerName(value: string | undefined): AgentSpinnerName | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	if (normalized === undefined || normalized.length === 0) return undefined;
	return normalized in AGENT_SPINNERS ? normalized as AgentSpinnerName : undefined;
}

export function normalizeAgentSpinnerSelection(value: string | undefined): AgentSpinnerSelection | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	if (normalized === AGENT_SPINNER_CYCLE_NAME || normalized === "all") return AGENT_SPINNER_CYCLE_NAME;
	const customSelection = normalizeAgentSpinnerCustomSelection(value);
	if (customSelection !== undefined) return customSelection;
	const spinnerName = normalizeAgentSpinnerName(value);
	if (spinnerName !== undefined) return spinnerName;
	return normalizeAgentSpinnerPresetName(normalized);
}

export function normalizeAgentSpinnerPresetName(value: string | undefined): AgentSpinnerPresetName | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	const presetName = normalized?.replace(/^preset:/u, "").replace(/-only$/u, "");
	if (presetName === undefined || presetName.length === 0) return undefined;
	return presetName in AGENT_SPINNER_PRESETS ? presetName as AgentSpinnerPresetName : undefined;
}

export function normalizeAgentSpinnerCustomSelection(value: string | undefined): AgentSpinnerCustomSelection | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	const members = normalized?.replace(/^(custom|cycle):/u, "");
	if (normalized === undefined || members === undefined || members.length === 0 || members === normalized) return undefined;
	return customSelectionFromNames(members.split(/[\s,]+/u));
}

export function normalizeAgentSpinnerCycleDwellMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS;
	if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS;
	return value;
}

export function resolveAgentSpinner(value: string | undefined, options: { readonly unicode?: boolean; readonly cycleDwellMs?: number } = {}): ResolvedAgentSpinner {
	const fallback = options.unicode === false ? ASCII_AGENT_SPINNER_NAME : DEFAULT_AGENT_SPINNER_NAME;
	const name = normalizeAgentSpinnerSelection(value) ?? fallback;
	const cycleDwellMs = normalizeAgentSpinnerCycleDwellMs(options.cycleDwellMs);
	if (name === AGENT_SPINNER_CYCLE_NAME) return cycleAgentSpinner(AGENT_SPINNER_CYCLE_NAME, AGENT_SPINNER_CYCLE_NAMES, cycleDwellMs);
	if (isAgentSpinnerCustomSelection(name)) return cycleAgentSpinner(name, spinnerNamesFromCustomSelection(name), cycleDwellMs);
	const presetName = normalizeAgentSpinnerPresetName(name);
	if (presetName !== undefined) return cycleAgentSpinner(presetName, AGENT_SPINNER_PRESETS[presetName], cycleDwellMs);
	const spinnerName = normalizeAgentSpinnerName(name);
	if (spinnerName === undefined) return cycleAgentSpinner(AGENT_SPINNER_CYCLE_NAME, AGENT_SPINNER_CYCLE_NAMES, cycleDwellMs);
	const spinner = AGENT_SPINNERS[spinnerName];
	return { name: spinnerName, frames: [...spinner.frames], intervalMs: spinner.intervalMs };
}

function isAgentSpinnerCustomSelection(value: AgentSpinnerSelection): value is AgentSpinnerCustomSelection {
	return value.startsWith("custom:");
}

function cycleAgentSpinner(name: AgentSpinnerSelection, spinnerNames: readonly AgentSpinnerName[], cycleDwellMs: number): ResolvedAgentSpinner {
	const frames = spinnerNames.flatMap((spinnerName) => cycleFramesForSpinner(AGENT_SPINNERS[spinnerName], cycleDwellMs));
	return { name, frames: padFrames(frames), intervalMs: AGENT_SPINNER_CYCLE_INTERVAL_MS };
}

function cycleFramesForSpinner(spinner: AgentSpinnerDefinition, cycleDwellMs: number): string[] {
	const frames: string[] = [];
	for (let elapsedMs = 0; elapsedMs < cycleDwellMs; elapsedMs += AGENT_SPINNER_CYCLE_INTERVAL_MS) {
		const frameIndex = Math.floor(elapsedMs / spinner.intervalMs) % spinner.frames.length;
		frames.push(spinner.frames[frameIndex] ?? "");
	}
	return frames;
}

function padFrames(frames: readonly string[]): string[] {
	const width = Math.max(1, ...frames.map((frame) => visibleWidth(frame)));
	return frames.map((frame) => `${frame}${" ".repeat(Math.max(0, width - visibleWidth(frame)))}`);
}

function customSelectionFromNames(values: readonly string[]): AgentSpinnerCustomSelection | undefined {
	const names: AgentSpinnerName[] = [];
	for (const value of values.filter((item) => item.length > 0)) {
		const name = normalizeAgentSpinnerName(value);
		if (name === undefined) return undefined;
		if (!names.includes(name)) names.push(name);
	}
	if (names.length < 2) return undefined;
	return `custom:${names.join(",")}`;
}

function spinnerNamesFromCustomSelection(selection: AgentSpinnerCustomSelection): readonly AgentSpinnerName[] {
	const names: AgentSpinnerName[] = [];
	for (const value of selection.replace(/^custom:/u, "").split(",")) {
		const name = normalizeAgentSpinnerName(value);
		if (name !== undefined) names.push(name);
	}
	return names;
}

function spinnerNamesAtWidth(width: number): readonly AgentSpinnerName[] {
	return AGENT_SPINNER_NAMES.filter((name) => maxSpinnerFrameWidth(name) === width);
}

function maxSpinnerFrameWidth(name: AgentSpinnerName): number {
	return Math.max(...AGENT_SPINNERS[name].frames.map((frame) => visibleWidth(frame)));
}
