import { visibleWidth } from "@earendil-works/pi-tui";

// Frame data ported from expo-agent-spinners (MIT © eronred):
// /Users/james/dev/expo-agent-spinners/src/components/spinners
export type AgentSpinnerDefinition = {
	readonly frames: readonly string[];
	readonly intervalMs: number;
};

export type AgentSpinnerSelection = AgentSpinnerName | typeof AGENT_SPINNER_CYCLE_NAME;

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
	clock: { frames: ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"], intervalMs: 100 },
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
	earth: { frames: ["🌍", "🌎", "🌏"], intervalMs: 180 },
	fillsweep: { frames: ["⣀⣀", "⣤⣤", "⣶⣶", "⣿⣿", "⣿⣿", "⣿⣿", "⣶⣶", "⣤⣤", "⣀⣀", "⠀⠀", "⠀⠀"], intervalMs: 100 },
	"grow-horizontal": { frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"], intervalMs: 120 },
	"grow-vertical": { frames: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"], intervalMs: 120 },
	hearts: { frames: ["🩷", "🧡", "💛", "💚", "💙", "🩵", "💜", "🤎", "🖤", "🩶", "🤍"], intervalMs: 120 },
	helix: { frames: ["⢌⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉", "⢎⣉⢎⣉", "⣉⡱⣉⡱", "⣉⢎⣉⢎", "⡱⣉⡱⣉"], intervalMs: 80 },
	moon: { frames: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"], intervalMs: 80 },
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
	speaker: { frames: ["🔈", "🔉", "🔊", "🔉"], intervalMs: 160 },
	"square-corners": { frames: ["◰", "◳", "◲", "◱"], intervalMs: 180 },
	toggle: { frames: ["⊶", "⊷"], intervalMs: 250 },
	triangle: { frames: ["◢", "◣", "◤", "◥"], intervalMs: 50 },
	wave: { frames: ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"], intervalMs: 100 },
	waverows: { frames: ["⠖⠉⠉⠑", "⡠⠖⠉⠉", "⣠⡠⠖⠉", "⣄⣠⡠⠖", "⠢⣄⣠⡠", "⠙⠢⣄⣠", "⠉⠙⠢⣄", "⠊⠉⠙⠢", "⠜⠊⠉⠙", "⡤⠜⠊⠉", "⣀⡤⠜⠊", "⢤⣀⡤⠜", "⠣⢤⣀⡤", "⠑⠣⢤⣀", "⠉⠑⠣⢤", "⠋⠉⠑⠣"], intervalMs: 90 },
	weather: { frames: ["☀️", "🌤", "⛅️", "🌥", "☁️", "🌧", "🌨", "⛈"], intervalMs: 100 },
} as const satisfies Record<string, AgentSpinnerDefinition>;

export type AgentSpinnerName = keyof typeof AGENT_SPINNERS;

export const AGENT_SPINNER_NAMES = Object.keys(AGENT_SPINNERS).sort() as AgentSpinnerName[];
export const AGENT_SPINNER_CYCLE_NAMES = [
	"dots",
	"dots2",
	"dots3",
	"dots4",
	"dots5",
	"dots6",
	"dots7",
	"dots8",
	"dots9",
	"dots10",
	"dots11",
	"dots12",
	"dots13",
	"dots14",
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
	"dqpb",
	"rolling-line",
	"simple-dots",
	"simple-dots-scrolling",
	"arc",
	"balloon",
	"circle-halves",
	"circle-quarters",
	"point",
	"square-corners",
	"toggle",
	"triangle",
	"grow-horizontal",
	"grow-vertical",
	"noise",
	"arrow",
	"double-arrow",
	"hearts",
	"clock",
	"earth",
	"moon",
	"speaker",
	"weather",
] as const satisfies readonly AgentSpinnerName[];
export const AGENT_SPINNER_CYCLE_NAME = "cycle";
export const DEFAULT_AGENT_SPINNER_NAME = AGENT_SPINNER_CYCLE_NAME;
export const ASCII_AGENT_SPINNER_NAME = "rolling-line" satisfies AgentSpinnerName;
const CYCLE_INTERVAL_MS = 100;
const CYCLE_DWELL_MS = 1_200;

export function normalizeAgentSpinnerName(value: string | undefined): AgentSpinnerName | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	if (normalized === undefined || normalized.length === 0) return undefined;
	return normalized in AGENT_SPINNERS ? normalized as AgentSpinnerName : undefined;
}

export function normalizeAgentSpinnerSelection(value: string | undefined): AgentSpinnerSelection | undefined {
	const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
	if (normalized === AGENT_SPINNER_CYCLE_NAME || normalized === "all") return AGENT_SPINNER_CYCLE_NAME;
	return normalizeAgentSpinnerName(value);
}

export function resolveAgentSpinner(value: string | undefined, options: { readonly unicode?: boolean } = {}): ResolvedAgentSpinner {
	const fallback = options.unicode === false ? ASCII_AGENT_SPINNER_NAME : DEFAULT_AGENT_SPINNER_NAME;
	const name = normalizeAgentSpinnerSelection(value) ?? fallback;
	if (name === AGENT_SPINNER_CYCLE_NAME) return cycleAgentSpinner();
	const spinner = AGENT_SPINNERS[name];
	return { name, frames: [...spinner.frames], intervalMs: spinner.intervalMs };
}

function cycleAgentSpinner(): ResolvedAgentSpinner {
	const frames = AGENT_SPINNER_CYCLE_NAMES.flatMap((name) => cycleFramesForSpinner(AGENT_SPINNERS[name]));
	return { name: AGENT_SPINNER_CYCLE_NAME, frames: padFrames(frames), intervalMs: CYCLE_INTERVAL_MS };
}

function cycleFramesForSpinner(spinner: AgentSpinnerDefinition): string[] {
	const frames: string[] = [];
	for (let elapsedMs = 0; elapsedMs < CYCLE_DWELL_MS; elapsedMs += CYCLE_INTERVAL_MS) {
		const frameIndex = Math.floor(elapsedMs / spinner.intervalMs) % spinner.frames.length;
		frames.push(spinner.frames[frameIndex] ?? "");
	}
	return frames;
}

function padFrames(frames: readonly string[]): string[] {
	const width = Math.max(1, ...frames.map((frame) => visibleWidth(frame)));
	return frames.map((frame) => `${frame}${" ".repeat(Math.max(0, width - visibleWidth(frame)))}`);
}
