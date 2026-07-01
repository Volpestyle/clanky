import { realpathSync } from "node:fs";
import { homedir } from "node:os";

// macOS Seatbelt profile composition for the host_command tool (ADR-0003),
// ported from Codex (Apache-2.0): codex-rs/sandboxing/src/seatbelt.rs,
// seatbelt_base_policy.sbpl, and seatbelt_network_policy.sbpl. The profile is
// text-concatenated in a fixed order (base, read, write, deny-reads, network)
// and directory roots are passed as -DNAME=path parameters rather than
// inlined, so paths never need quoting inside the policy.

export type SandboxLevel = "read-only" | "workspace-write" | "danger-full-access";

export interface SandboxSpec {
	level: SandboxLevel;
	network: boolean;
	cwd: string;
}

export interface SandboxedInvocation {
	argv: string[];
	env: Record<string, string>;
	sandboxed: boolean;
}

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

// Inspired by Chrome's sandbox policy via Codex's seatbelt_base_policy.sbpl.
// Closed by default; file read/write and network are appended per run.
const SEATBELT_BASE_POLICY = `(version 1)

; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; process-info
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; sysctls permitted.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable.")
)

; Java reads CPU info through a sysctl that is misclassified as a write.
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

; IOKit
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient")
)

; needed to look up user info
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
)

; Needed for python multiprocessing on MacOS for the SemLock
(allow ipc-posix-sem)

; Needed for PyTorch/libomp on macOS to register OpenMP runtimes.
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))

(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
)

; allow openpty()
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
; PTYs created before entering seatbelt may lack the extension; allow ioctl
; on those slave ttys so interactive shells detect a TTY and remain functional.
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

; allow readonly user preferences
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow user-preference-read)`;

// Appended only when network egress is granted (Codex seatbelt_network_policy.sbpl):
// safe AF_SYSTEM sockets plus the mach services TLS and DNS resolution need.
const SEATBELT_NETWORK_POLICY = `; allow only safe AF_SYSTEM sockets used for local platform services.
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)
  )
)

(allow mach-lookup
    ; Used by platform helpers that resolve user directory locations.
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.system.opendirectoryd.membership")

    ; Communicate with the security server for TLS certificate information.
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.networkd")
    (global-name "com.apple.ocspd")
    (global-name "com.apple.trustd.agent")

    ; Read network configuration.
    (global-name "com.apple.SystemConfiguration.DNSConfiguration")
    (global-name "com.apple.SystemConfiguration.configd")
)

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable")
)`;

// Clanky addition beyond Codex: even with full-disk read, credential material
// must not be readable into the transcript. The brain ingests untrusted input
// (Discord, web, repo contents), so an injected `cat ~/.ssh/id_ed25519` or
// `cat .env.local` has to hit the OS floor, not model discipline.
const SECRET_DENY_RULES = `; deny reads of credential material regardless of the read policy above
(deny file-read* (regex #"/\\.env(\\..+)?$"))
(deny file-read* (regex #"/\\.ssh(/.*)?$"))
(deny file-read* (regex #"/\\.aws(/.*)?$"))
(deny file-write* (regex #"/\\.env(\\..+)?$"))
(deny file-write* (regex #"/\\.ssh(/.*)?$"))
(deny file-write* (regex #"/\\.aws(/.*)?$"))`;

function escapeForSbplRegex(path: string): string {
	return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveRealPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

interface WritePolicy {
	section: string;
	params: Array<[string, string]>;
}

// Workspace-write roots: cwd plus scratch space, with the cwd's version
// control metadata carved back out (Codex protects .git under every writable
// root so a sandboxed run cannot rewrite history or hooks).
function buildWritePolicy(spec: SandboxSpec): WritePolicy {
	if (spec.level !== "workspace-write") return { section: "", params: [] };
	const roots: string[] = [resolveRealPath(spec.cwd)];
	for (const scratch of ["/tmp", process.env.TMPDIR ?? ""]) {
		if (scratch.length === 0) continue;
		const resolved = resolveRealPath(scratch);
		if (!roots.includes(resolved)) roots.push(resolved);
	}
	const params: Array<[string, string]> = [];
	const components: string[] = [];
	for (const [index, root] of roots.entries()) {
		const param = `WRITABLE_ROOT_${index}`;
		params.push([param, root]);
		if (index === 0) {
			const gitRegex = `^${escapeForSbplRegex(root)}/\\.git(/.*)?$`;
			components.push(`(require-all (subpath (param "${param}")) (require-not (regex #"${gitRegex}")))`);
		} else {
			components.push(`(subpath (param "${param}"))`);
		}
	}
	return { section: `(allow file-write*\n${components.join("\n")}\n)`, params };
}

export function buildSeatbeltPolicy(spec: SandboxSpec): { policy: string; params: Array<[string, string]> } {
	const readPolicy = "; allow read-only file operations\n(allow file-read*)";
	const write = buildWritePolicy(spec);
	const networkPolicy = spec.network
		? `(allow network-outbound)\n(allow network-inbound)\n${SEATBELT_NETWORK_POLICY}`
		: "";
	const sections = [SEATBELT_BASE_POLICY, readPolicy, write.section, SECRET_DENY_RULES, networkPolicy];
	return { policy: sections.filter((section) => section.length > 0).join("\n"), params: write.params };
}

const CHILD_ENV_PASSTHROUGH = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"] as const;
const STANDARD_PATH_ENTRIES = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

// The brain's PATH depends on how it was launched (face-owned spawn, launchd,
// a bare terminal), so merge the standard tool prefixes in rather than trust
// it to include Homebrew.
function childPath(): string {
	const inherited = (process.env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
	const merged = [...inherited];
	for (const entry of STANDARD_PATH_ENTRIES) {
		if (!merged.includes(entry)) merged.push(entry);
	}
	return merged.join(":");
}

// The child env is built fresh, never inherited: the brain's process.env holds
// Discord tokens and API keys that must not reach a host shell (Codex does the
// same with env_clear). Applies to every level including danger-full-access.
function buildChildEnv(spec: SandboxSpec): Record<string, string> {
	const env: Record<string, string> = {
		PATH: childPath(),
		HOME: homedir(),
		SHELL: "/bin/bash",
		TERM: "dumb",
		NO_COLOR: "1",
		PAGER: "cat",
		GH_PAGER: "cat",
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
	};
	for (const name of CHILD_ENV_PASSTHROUGH) {
		const value = process.env[name];
		if (value !== undefined && value.length > 0) env[name] = value;
	}
	if (spec.level !== "danger-full-access") {
		env.CLANKY_SANDBOX = "seatbelt";
		if (!spec.network) env.CLANKY_SANDBOX_NETWORK_DISABLED = "1";
	}
	return env;
}

export function buildSandboxedInvocation(spec: SandboxSpec, commandScript: string): SandboxedInvocation {
	const shellArgv = ["/bin/bash", "-c", commandScript];
	const env = buildChildEnv(spec);
	if (spec.level === "danger-full-access") {
		return { argv: shellArgv, env, sandboxed: false };
	}
	const { policy, params } = buildSeatbeltPolicy(spec);
	const argv = [
		SANDBOX_EXEC_PATH,
		"-p",
		policy,
		...params.map(([key, value]) => `-D${key}=${value}`),
		"--",
		...shellArgv,
	];
	return { argv, env, sandboxed: true };
}
