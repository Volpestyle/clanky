import { classifyCommand, tokenizeSimpleScript } from "../agent/lib/host-command/classify.ts";
import { isOwnerDrivenTurn, parseApprovalMode, resolveApprovalMode } from "../agent/lib/host-command/mode.ts";
import { buildSandboxedInvocation, buildSeatbeltPolicy } from "../agent/lib/host-command/seatbelt.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- approval mode resolution -------------------------------------------------

assert(parseApprovalMode("yolo") === "yolo", "parseApprovalMode accepts yolo");
assert(parseApprovalMode(" Read-Only ") === "read-only", "parseApprovalMode normalizes case/space");
assert(parseApprovalMode("bogus") === undefined, "parseApprovalMode rejects unknown");
assert(parseApprovalMode(undefined) === undefined, "parseApprovalMode handles undefined");

assert(resolveApprovalMode({}) === "read-only", "default mode is read-only");
assert(resolveApprovalMode({ CLANKY_APPROVAL_MODE: "auto" }) === "auto", "explicit auto");
assert(resolveApprovalMode({ CLANKY_YOLO: "1" }) === "yolo", "CLANKY_YOLO arms yolo");
assert(
	resolveApprovalMode({ CLANKY_YOLO: "1", CLANKY_APPROVAL_MODE: "read-only" }) === "yolo",
	"CLANKY_YOLO wins over mode env",
);

const savedAutoApprove = process.env.CLANKY_AUTO_APPROVE;
process.env.CLANKY_AUTO_APPROVE = "1";
assert(resolveApprovalMode({ CLANKY_AUTO_APPROVE: "1" }) === "auto", "CLANKY_AUTO_APPROVE implies auto");
if (savedAutoApprove === undefined) delete process.env.CLANKY_AUTO_APPROVE;
else process.env.CLANKY_AUTO_APPROVE = savedAutoApprove;

// --- owner-turn detection -------------------------------------------------------

function authWithSurface(surface: string | undefined): Parameters<typeof isOwnerDrivenTurn>[0] {
	if (surface === undefined) return { current: null, initiator: null };
	return {
		current: {
			attributes: { surface },
			authenticator: "clanky-local-user",
			principalId: "james",
			principalType: "user",
		},
		initiator: null,
	};
}

assert(isOwnerDrivenTurn(authWithSurface("face")), "face surface is owner");
assert(isOwnerDrivenTurn(authWithSurface("frontdoor")), "frontdoor surface is owner");
assert(!isOwnerDrivenTurn(authWithSurface("local-face")), "unmarked local-face fails closed");
assert(!isOwnerDrivenTurn(authWithSurface("discord-presence")), "presence surface is not owner");
assert(!isOwnerDrivenTurn(authWithSurface("discord-voice")), "voice surface is not owner");
assert(!isOwnerDrivenTurn(authWithSurface(undefined)), "missing auth fails closed");

// --- tokenizer -------------------------------------------------------------------

assert(
	JSON.stringify(tokenizeSimpleScript("rg -n 'foo bar' src | head -5")) ===
		JSON.stringify([
			["rg", "-n", "foo bar", "src"],
			["head", "-5"],
		]),
	"tokenizer splits pipeline with quoted word",
);
assert(tokenizeSimpleScript("ls $(pwd)") === null, "command substitution is unparseable");
assert(tokenizeSimpleScript("ls > out.txt") === null, "redirection is unparseable");
assert(tokenizeSimpleScript('echo "$HOME"') === null, "expansion inside double quotes is unparseable");
assert(tokenizeSimpleScript("ls &") === null, "background job is unparseable");
assert(tokenizeSimpleScript("ls &&") === null, "trailing operator is unparseable");
assert(tokenizeSimpleScript("") === null, "empty script is unparseable");

// --- classification --------------------------------------------------------------

interface ClassifyExpectation {
	command: string;
	verdict: "allow" | "ask" | "deny";
	network: boolean;
}

const expectations: ClassifyExpectation[] = [
	{ command: "rg -n pattern agent/", verdict: "allow", network: false },
	{ command: "cat package.json | jq .scripts", verdict: "allow", network: false },
	{ command: "sed -n 1,50p file.ts", verdict: "allow", network: false },
	{ command: "sed -i s/a/b/ file.ts", verdict: "allow", network: false },
	{ command: "gh pr diff 42", verdict: "allow", network: true },
	{ command: "gh pr diff 42 | rg TODO", verdict: "allow", network: true },
	// one unknown binary in the pipe drops network for the whole run
	{ command: "gh pr diff 42 | exfiltool", verdict: "allow", network: false },
	{ command: "rg --pre evil . | gh api repos/o/r", verdict: "allow", network: false },
	{ command: "gh api repos/o/r/pulls", verdict: "allow", network: true },
	{ command: "gh api -X POST repos/o/r/issues", verdict: "ask", network: true },
	{ command: "gh api --method=DELETE repos/o/r", verdict: "ask", network: true },
	{ command: "gh pr create --title x", verdict: "ask", network: true },
	{ command: "gh auth token", verdict: "deny", network: false },
	{ command: "gh auth status", verdict: "allow", network: true },
	{ command: "gh search code needle", verdict: "allow", network: true },
	{ command: "rm -rf /tmp/x", verdict: "ask", network: false },
	{ command: "sudo ls", verdict: "ask", network: false },
	// unparseable scripts run sandboxed and offline without prompting
	{ command: "for f in *.ts; do wc -l $f; done", verdict: "allow", network: false },
	{ command: "find . -name '*.ts' -delete", verdict: "allow", network: false },
];

for (const expectation of expectations) {
	const result = classifyCommand(expectation.command);
	assert(
		result.verdict === expectation.verdict && result.network === expectation.network,
		`classify(${JSON.stringify(expectation.command)}) => ${result.verdict}/${String(result.network)}, want ${expectation.verdict}/${String(expectation.network)}`,
	);
}

// --- seatbelt profile composition -------------------------------------------------

const cwd = process.cwd();

const readOnly = buildSeatbeltPolicy({ level: "read-only", network: false, cwd });
assert(readOnly.policy.includes("(deny default)"), "read-only policy denies by default");
assert(readOnly.policy.includes("(allow file-read*)"), "read-only policy allows reads");
assert(!readOnly.policy.includes("(allow file-write*\n"), "read-only policy has no write section");
assert(readOnly.policy.includes('(deny file-read* (regex #"/\\.env(\\..+)?$"))'), "read-only denies .env reads");
assert(!readOnly.policy.includes("network-outbound)"), "offline policy grants no network");
assert(readOnly.params.length === 0, "read-only policy has no dir params");

const workspace = buildSeatbeltPolicy({ level: "workspace-write", network: false, cwd });
assert(workspace.policy.includes("(allow file-write*\n"), "workspace policy has a write section");
assert(workspace.params.some(([key]) => key === "WRITABLE_ROOT_0"), "workspace policy passes writable root param");
assert(workspace.policy.includes("\\.git(/.*)?$"), "workspace policy protects .git");

const networked = buildSeatbeltPolicy({ level: "read-only", network: true, cwd });
assert(networked.policy.includes("(allow network-outbound)"), "networked policy allows outbound");
assert(networked.policy.includes("com.apple.SecurityServer"), "networked policy includes TLS mach services");

const invocation = buildSandboxedInvocation({ level: "read-only", network: false, cwd }, "ls");
assert(invocation.sandboxed, "read-only invocation is sandboxed");
assert(invocation.argv[0] === "/usr/bin/sandbox-exec", "invocation runs through sandbox-exec");
assert(invocation.argv.includes("--"), "invocation separates policy from command");
assert(invocation.env.CLANKY_SANDBOX === "seatbelt", "sandbox marker env is set");
assert(invocation.env.CLANKY_SANDBOX_NETWORK_DISABLED === "1", "offline marker env is set");
assert(invocation.env.DISCORD_TOKEN === undefined && invocation.env.CLANKY_RELAY_TOKEN === undefined, "child env is allowlisted");

const yoloInvocation = buildSandboxedInvocation({ level: "danger-full-access", network: true, cwd }, "ls");
assert(!yoloInvocation.sandboxed, "danger-full-access runs without sandbox-exec");
assert(yoloInvocation.argv[0] === "/bin/bash", "danger-full-access still runs through bash -c");
assert(yoloInvocation.env.CLANKY_SANDBOX === undefined, "danger-full-access sets no sandbox marker");

console.log("host-command-smoke: ok");
