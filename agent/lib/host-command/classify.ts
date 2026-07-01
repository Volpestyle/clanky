// Command classification for the host_command tool (ADR-0003), modeled on
// Codex's safe-command fast path (codex-rs shell-command/src/command_safety/)
// with a per-CLI policy registry on top. The Seatbelt sandbox is the hard
// floor; classification only decides two softer things:
//
// - verdict: "allow" auto-runs, "ask" gates on approval (used for registry
//   commands whose side effects the sandbox cannot see, e.g. gh API writes),
//   "deny" never runs (credential-printing commands).
// - network: whether the sandbox profile grants network egress. Network is
//   granted only when every pipeline segment resolves to a known-trusted
//   command or registry entry — one unknown binary in the pipe and the whole
//   run stays offline, so an injected command cannot exfiltrate what it read.
//
// A script this conservative parser cannot tokenize (substitutions,
// redirections, expansions, multi-line) still runs — fully sandboxed, no
// network, no prompts. Codex reaches the same posture via its OnRequest +
// restricted-sandbox auto-allow.

export type CommandVerdict = "allow" | "ask" | "deny";

export interface CommandClassification {
	verdict: CommandVerdict;
	network: boolean;
	parsed: boolean;
	reason?: string;
}

type SegmentKind = "trusted" | "ask" | "deny" | "unknown";

interface SegmentClassification {
	kind: SegmentKind;
	network: boolean;
	reason?: string;
}

// Codex's unconditionally-safe read commands (is_safe_command.rs), plus jq:
// pure stdin/file-to-stdout transforms with no exec or write options.
const SAFE_COMMANDS = new Set([
	"cat",
	"cd",
	"cut",
	"echo",
	"expr",
	"false",
	"grep",
	"head",
	"id",
	"jq",
	"ls",
	"nl",
	"paste",
	"pwd",
	"rev",
	"seq",
	"stat",
	"tail",
	"tr",
	"true",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
]);

// find options that execute commands, delete files, or write output files.
const UNSAFE_FIND_OPTIONS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

// rg options that spawn external programs or decompressors.
const UNSAFE_RIPGREP_FLAGS = new Set(["-z", "--search-zip"]);
const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS = ["--pre", "--hostname-bin"];

// gh subcommands that only read. Everything else on gh is "ask": gh holds an
// authenticated token and its API writes are invisible to the filesystem
// sandbox, so mutation must go through approval.
const GH_READ_SUBCOMMANDS = new Set([
	"pr view",
	"pr diff",
	"pr list",
	"pr checks",
	"pr status",
	"issue view",
	"issue list",
	"issue status",
	"run view",
	"run list",
	"repo view",
	"repo list",
	"release view",
	"release list",
	"gist view",
	"gist list",
	"workflow view",
	"workflow list",
	"auth status",
]);

function executableName(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash === -1 ? word : word.slice(slash + 1);
}

// Codex's is_valid_sed_n_arg: a plain line-print range like `10p` or `1,5p`.
function isValidSedPrintRange(value: string): boolean {
	if (!value.endsWith("p")) return false;
	const parts = value.slice(0, -1).split(",");
	if (parts.length === 0 || parts.length > 2) return false;
	return parts.every((part) => part.length > 0 && /^\d+$/.test(part));
}

function classifyFind(argv: string[]): SegmentClassification {
	const unsafe = argv.slice(1).find((arg) => UNSAFE_FIND_OPTIONS.has(arg));
	if (unsafe === undefined) return { kind: "trusted", network: false };
	return { kind: "unknown", network: false, reason: `find ${unsafe} is not a read` };
}

function classifyRipgrep(argv: string[]): SegmentClassification {
	for (const arg of argv.slice(1)) {
		if (UNSAFE_RIPGREP_FLAGS.has(arg)) return { kind: "unknown", network: false };
		if (UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.some((opt) => arg === opt || arg.startsWith(`${opt}=`))) {
			return { kind: "unknown", network: false };
		}
	}
	return { kind: "trusted", network: false };
}

function classifySed(argv: string[]): SegmentClassification {
	if (argv.length <= 4 && argv[1] === "-n" && argv[2] !== undefined && isValidSedPrintRange(argv[2])) {
		return { kind: "trusted", network: false };
	}
	return { kind: "unknown", network: false };
}

function classifyBase64(argv: string[]): SegmentClassification {
	const writesOutput = argv
		.slice(1)
		.some((arg) => arg === "--output" || arg.startsWith("--output=") || (arg.startsWith("-o") && arg !== "-"));
	return writesOutput ? { kind: "unknown", network: false } : { kind: "trusted", network: false };
}

// gh api is a read only when the method is GET (the default) and no field
// options force a POST body.
function ghApiIsRead(argv: string[]): boolean {
	const args = argv.slice(2);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-X" || arg === "--method") {
			if ((args[index + 1] ?? "").toUpperCase() !== "GET") return false;
			index += 1;
			continue;
		}
		if (arg.startsWith("--method=")) {
			if (arg.slice("--method=".length).toUpperCase() !== "GET") return false;
			continue;
		}
		if (
			arg === "-f" ||
			arg === "-F" ||
			arg === "--field" ||
			arg === "--raw-field" ||
			arg === "--input" ||
			arg.startsWith("--field=") ||
			arg.startsWith("--raw-field=") ||
			arg.startsWith("--input=")
		) {
			return false;
		}
	}
	return true;
}

function classifyGh(argv: string[]): SegmentClassification {
	const group = argv[1] ?? "";
	const action = argv[2] ?? "";
	if (group === "auth" && action === "token") {
		return { kind: "deny", network: true, reason: "gh auth token prints the GitHub credential" };
	}
	if (group === "search") return { kind: "trusted", network: true };
	if (group === "api") {
		return ghApiIsRead(argv)
			? { kind: "trusted", network: true }
			: { kind: "ask", network: true, reason: `mutating GitHub API call: ${argv.join(" ")}` };
	}
	if (GH_READ_SUBCOMMANDS.has(`${group} ${action}`)) return { kind: "trusted", network: true };
	return { kind: "ask", network: true, reason: `gh ${group} ${action} is not a known read` };
}

// Codex's is_dangerous_to_call_with_exec: force approval on commands whose
// blast radius survives even a workspace-write sandbox.
function isDangerousSegment(argv: string[]): boolean {
	const name = executableName(argv[0] ?? "");
	if (name === "sudo") return true;
	if (name === "rm") {
		const flag = argv[1] ?? "";
		return flag === "-f" || flag === "-rf" || flag === "-fr" || flag === "-r";
	}
	return false;
}

function classifySegment(argv: string[]): SegmentClassification {
	const name = executableName(argv[0] ?? "");
	if (isDangerousSegment(argv)) {
		return { kind: "ask", network: false, reason: `${argv.join(" ")} is destructive` };
	}
	if (SAFE_COMMANDS.has(name)) return { kind: "trusted", network: false };
	if (name === "find") return classifyFind(argv);
	if (name === "rg") return classifyRipgrep(argv);
	if (name === "sed") return classifySed(argv);
	if (name === "base64") return classifyBase64(argv);
	if (name === "gh") return classifyGh(argv);
	return { kind: "unknown", network: false };
}

const REJECT_CHARS = new Set(["$", "`", "\\", "(", ")", "<", ">", "\n", "\r", "#"]);

// Conservative shell tokenizer: plain words, single/double quotes with no
// expansions, and the operators && || ; |. Anything richer returns null and
// the script runs unclassified (sandboxed, offline). Divergence from Codex
// (which parses with tree-sitter-bash) is deliberate: a native parser is a
// heavy dependency, and every mis-parse here fails toward less capability.
export function tokenizeSimpleScript(script: string): string[][] | null {
	const segments: string[][] = [];
	let current: string[] = [];
	let word = "";
	let wordStarted = false;
	let expectSegment = false;

	const endWord = (): void => {
		if (wordStarted) current.push(word);
		word = "";
		wordStarted = false;
	};
	const endSegment = (): boolean => {
		endWord();
		if (current.length === 0) return false;
		segments.push(current);
		current = [];
		expectSegment = true;
		return true;
	};

	let index = 0;
	while (index < script.length) {
		const char = script[index] ?? "";
		if (REJECT_CHARS.has(char)) return null;
		if (char === " " || char === "\t") {
			endWord();
			index += 1;
			continue;
		}
		if (char === "'") {
			const close = script.indexOf("'", index + 1);
			if (close === -1) return null;
			word += script.slice(index + 1, close);
			wordStarted = true;
			index = close + 1;
			continue;
		}
		if (char === '"') {
			const close = script.indexOf('"', index + 1);
			if (close === -1) return null;
			const inner = script.slice(index + 1, close);
			if ([...inner].some((c) => c === "$" || c === "`" || c === "\\")) return null;
			word += inner;
			wordStarted = true;
			index = close + 1;
			continue;
		}
		if (char === "&") {
			if (script[index + 1] !== "&") return null;
			if (!endSegment()) return null;
			index += 2;
			continue;
		}
		if (char === "|") {
			if (!endSegment()) return null;
			index += script[index + 1] === "|" ? 2 : 1;
			continue;
		}
		if (char === ";") {
			if (script[index + 1] === ";") return null;
			if (!endSegment()) return null;
			index += 1;
			continue;
		}
		word += char;
		wordStarted = true;
		expectSegment = false;
		index += 1;
	}
	endWord();
	if (current.length > 0) {
		segments.push(current);
		expectSegment = false;
	}
	if (segments.length === 0 || expectSegment) return null;
	return segments;
}

export function classifyCommand(script: string): CommandClassification {
	const segments = tokenizeSimpleScript(script);
	if (segments === null) {
		return {
			verdict: "allow",
			network: false,
			parsed: false,
			reason: "script too complex to classify; runs fully sandboxed without network",
		};
	}
	const classified = segments.map(classifySegment);
	const denied = classified.find((segment) => segment.kind === "deny");
	if (denied !== undefined) {
		return { verdict: "deny", network: false, parsed: true, reason: denied.reason };
	}
	const allKnown = classified.every((segment) => segment.kind !== "unknown");
	const network = allKnown && classified.some((segment) => segment.network);
	const asked = classified.find((segment) => segment.kind === "ask");
	if (asked !== undefined) {
		return { verdict: "ask", network, parsed: true, reason: asked.reason };
	}
	return { verdict: "allow", network, parsed: true };
}
