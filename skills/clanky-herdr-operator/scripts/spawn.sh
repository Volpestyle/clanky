#!/usr/bin/env bash
# Spawn one worker as a named herdr agent pane inside a run tab.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: spawn.sh --slug <task-slug> --task "<one-line summary>" \
				(--prompt "<text>" | --prompt-file <path>) \
				[--run <run-id>] [--cwd <dir>] [--harness clanky|claude|codex|opencode|custom] \
				[-- <worker argv...>]

Spawns one worker agent named clanky:<slug> into the run's herdr tab.
CLANKY_CODING_HARNESSES allowlists usable harnesses. Default worker uses
CLANKY_CODING_HARNESS from the environment or .env.local, or clanky when unset.
Claude/Codex/OpenCode can launch through native CLIs or Ollama CLI integrations.
In a custom argv, the token {KICKOFF} is replaced with the kickoff message;
without the token the kickoff is appended as the final argument.

Prints RUN_ID, RUN_DIR, AGENT, PANE_ID lines on success. Pass the same
--run to later spawns to group workers into one run.
EOF
	exit 2
}

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "spawn.sh: HERDR_ENV is not 1; not running inside herdr, refusing to control it" >&2
	exit 1
fi

# -P: resolve symlinks so the repo-root fallback works when the skill is
# invoked through a symlinked skills dir (e.g. ~/.claude/skills)
SKILL_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO_ROOT="$(cd -P "$SKILL_DIR/../.." && pwd -P)"
ENV_FILE="$REPO_ROOT/.env.local"
WORKER_SKILL_PATH="$(cd -P "$SKILL_DIR/../clanky-herdr-worker" && pwd -P)/SKILL.md"
RUN_ROOT="${CLANKY_HERDR_RUN_ROOT:-$HOME/.clanky/herdr-runs}"

config_value() {
	local key="$1"
	local existing="${!key-}"
	if [ -n "$existing" ]; then
		printf '%s' "$existing"
		return
	fi
	[ -f "$ENV_FILE" ] || return 0
	python3 - "$ENV_FILE" "$key" <<'PY'
import re, sys
path, key = sys.argv[1:3]
with open(path) as f:
    for raw in f:
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", raw.rstrip("\n"))
        if not match or match.group(1) != key:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
            if raw.strip().split("=", 1)[1].strip().startswith('"'):
                value = value.replace('\\"', '"')
        print(value, end="")
        break
PY
}

RUN_ID="" SLUG="" TASK="" PROMPT="" PROMPT_FILE="" WORKER_CWD="$PWD" HARNESS=""
ARGV=()
while [ $# -gt 0 ]; do
	case "$1" in
		--run) RUN_ID="$2"; shift 2 ;;
		--slug) SLUG="$2"; shift 2 ;;
		--task) TASK="$2"; shift 2 ;;
		--prompt) PROMPT="$2"; shift 2 ;;
		--prompt-file) PROMPT_FILE="$2"; shift 2 ;;
		--cwd) WORKER_CWD="$2"; shift 2 ;;
		--harness) HARNESS="$2"; shift 2 ;;
		--) shift; ARGV=("$@"); break ;;
		*) usage ;;
	esac
done

[ -n "$SLUG" ] && [ -n "$TASK" ] || usage
if [ -z "$PROMPT" ] && [ -z "$PROMPT_FILE" ]; then usage; fi
if [ -z "$HARNESS" ]; then HARNESS="$(config_value CLANKY_CODING_HARNESS)"; fi
[ -n "$HARNESS" ] || HARNESS="clanky"
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
	echo "spawn.sh: slug must be lowercase kebab-case ([a-z0-9-])" >&2
	exit 2
fi
case "$HARNESS" in
	clanky | claude | codex | opencode | custom) ;;
	*)
		echo "spawn.sh: unknown --harness '$HARNESS' (expected clanky, claude, codex, opencode, or custom)" >&2
		exit 2
		;;
esac
ALLOWED_HARNESSES="$(config_value CLANKY_CODING_HARNESSES)"
if [ -n "$ALLOWED_HARNESSES" ]; then
	if ! python3 - "$HARNESS" "$ALLOWED_HARNESSES" <<'PY'
import re, sys
harness, raw = sys.argv[1:3]
if re.sub(r"[^a-z0-9]+", "", raw.lower()) == "all":
    raise SystemExit(0)
allowed = []
valid = {"clanky", "claude", "codex", "opencode", "custom"}
for token in re.split(r"[\s,]+", raw.strip()):
    if not token:
        continue
    normalized = re.sub(r"[^a-z0-9]+", "", token.lower())
    if normalized not in valid:
        raise SystemExit(f"unknown coding harness '{token}' in allowlist")
    allowed.append(normalized)
if harness not in allowed:
    raise SystemExit(f"coding harness '{harness}' is not allowed; allowed harnesses: {', '.join(allowed)}")
PY
	then
		exit 2
	fi
fi

AGENT_NAME="clanky:$SLUG"
if herdr agent get "$AGENT_NAME" >/dev/null 2>&1; then
	echo "spawn.sh: agent $AGENT_NAME already exists; pick another slug or clean up the old run" >&2
	exit 1
fi

[ -n "$RUN_ID" ] || RUN_ID="run-$(date +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$RUN_ROOT/$RUN_ID"
WORKER_DIR="$RUN_DIR/workers/$SLUG"
MANIFEST="$RUN_DIR/manifest.json"
mkdir -p "$WORKER_DIR"

if [ -n "$PROMPT_FILE" ]; then
	cp "$PROMPT_FILE" "$WORKER_DIR/prompt.md"
else
	printf '%s\n' "$PROMPT" > "$WORKER_DIR/prompt.md"
fi
cat >> "$WORKER_DIR/prompt.md" <<EOF

---

## Completion protocol (required)

Work autonomously. Do not ask the user questions; make reasonable choices
and note them in your result.

- On success: write your complete result to $WORKER_DIR/result.md,
  then create the empty file $WORKER_DIR/DONE, then print the line
  CLANKY_WORKER_DONE.
- If you cannot proceed: write what you need to $WORKER_DIR/result.md,
  then create the empty file $WORKER_DIR/BLOCKED, then print the line
  CLANKY_WORKER_BLOCKED and stay running to receive an answer.
- If you were blocked and received an answer: delete the BLOCKED file
  and continue.

## Worker skill

Before doing the task, read and follow this Clanky Herdr worker skill:
$WORKER_SKILL_PATH

Do not load Clanky coding skill package paths from this prompt. If this process
is the Clanky runtime, use Clanky's configured skills; otherwise use your own
agent/runtime's native coding behavior.
EOF
cat >> "$WORKER_DIR/prompt.md" <<EOF
If the skill file is unavailable, say so in result.md and continue with best
judgment.
EOF

KICKOFF="You are Clanky's worker $AGENT_NAME in a visible Herdr pane. Read $WORKER_DIR/prompt.md and do the task it describes, including the referenced worker/runtime instructions and completion protocol. Work autonomously."

use_ollama_launcher() {
	local id="$1" prefix launcher_var model_var launcher model
	case "$id" in
		claude) prefix="CLAUDE" ;;
		codex) prefix="CODEX" ;;
		opencode) prefix="OPENCODE" ;;
		*) return 1 ;;
	esac
	launcher_var="CLANKY_CODING_HARNESS_${prefix}_LAUNCHER"
	model_var="CLANKY_CODING_HARNESS_${prefix}_MODEL"
	launcher="$(config_value "$launcher_var")"
	model="$(config_value "$model_var")"
	[ -n "$launcher" ] || launcher="default"
	case "$launcher" in
		"" | default | native) return 1 ;;
		ollama | local) ;;
		*)
			echo "spawn.sh: unknown ${launcher_var}='$launcher' (expected default or ollama)" >&2
			exit 2
			;;
	esac
	if ! command -v ollama >/dev/null 2>&1; then
		echo "spawn.sh: harness $id is configured for Ollama, but ollama is not on PATH" >&2
		exit 1
	fi
	ARGV=(ollama launch "$id" --yes)
	if [ -n "$model" ]; then ARGV+=(--model "$model"); fi
	case "$id" in
		claude) ARGV+=(-- --dangerously-skip-permissions "{KICKOFF}") ;;
		codex) ARGV+=(-- --dangerously-bypass-approvals-and-sandbox "{KICKOFF}") ;;
		opencode) ARGV+=(-- run "{KICKOFF}") ;;
	esac
	return 0
}

if [ ${#ARGV[@]} -eq 0 ]; then
	case "$HARNESS" in
		clanky)
			if command -v clanky >/dev/null 2>&1; then
				ARGV=(clanky worker "{KICKOFF}")
			else
				echo "spawn.sh: harness clanky requires clanky on PATH or an explicit argv after --" >&2
				exit 1
			fi
			;;
		claude)
			if use_ollama_launcher claude; then
				:
			elif command -v claude >/dev/null 2>&1; then
				ARGV=(claude --dangerously-skip-permissions "{KICKOFF}")
			else
				echo "spawn.sh: harness claude requires claude on PATH, an Ollama launcher config, or an explicit argv after --" >&2
				exit 1
			fi
			;;
		codex)
			if use_ollama_launcher codex; then
				:
			elif command -v codex >/dev/null 2>&1; then
				ARGV=(codex --dangerously-bypass-approvals-and-sandbox "{KICKOFF}")
			else
				echo "spawn.sh: harness codex requires codex on PATH, an Ollama launcher config, or an explicit argv after --" >&2
				exit 1
			fi
			;;
		opencode)
			if use_ollama_launcher opencode; then
				:
			elif command -v opencode >/dev/null 2>&1; then
				ARGV=(opencode run "{KICKOFF}")
			else
				echo "spawn.sh: harness opencode requires opencode on PATH, an Ollama launcher config, or an explicit argv after --" >&2
				exit 1
			fi
			;;
		custom)
			CUSTOM_COMMAND="$(config_value CLANKY_CODING_HARNESS_COMMAND)"
			if [ -z "$CUSTOM_COMMAND" ]; then
				echo "spawn.sh: harness custom requires CLANKY_CODING_HARNESS_COMMAND or an explicit argv after --" >&2
				exit 1
			fi
			while IFS= read -r arg; do ARGV+=("$arg"); done < <(python3 - "$CUSTOM_COMMAND" <<'EOF'
import json, shlex, sys
value = sys.argv[1].strip()
args = json.loads(value) if value.startswith("[") else shlex.split(value)
if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
    raise SystemExit("custom harness command JSON must be an array of strings")
for arg in args:
    print(arg)
EOF
)
			;;
		esac
fi
if [ ${#ARGV[@]} -eq 0 ]; then
	echo "spawn.sh: worker argv is empty" >&2
	exit 1
fi
HAS_TOKEN=0
for i in "${!ARGV[@]}"; do
	if [ "${ARGV[$i]}" = "{KICKOFF}" ]; then
		ARGV[$i]="$KICKOFF"
		HAS_TOKEN=1
	fi
done
[ "$HAS_TOKEN" = "1" ] || ARGV+=("$KICKOFF")

WORKSPACE_ID="$(herdr pane list | python3 -c 'import sys,json
panes = json.load(sys.stdin)["result"]["panes"]
focused = [p for p in panes if p.get("focused")]
print((focused or panes)[0]["workspace_id"])')"

TAB_LABEL="clanky:$RUN_ID"
TAB_ID="$(herdr tab list --workspace "$WORKSPACE_ID" | python3 -c 'import sys,json
label = sys.argv[1]
tabs = json.load(sys.stdin)["result"]["tabs"]
match = [t for t in tabs if t.get("label") == label]
print(match[0]["tab_id"] if match else "")' "$TAB_LABEL")"
if [ -z "$TAB_ID" ]; then
	TAB_ID="$(herdr tab create --workspace "$WORKSPACE_ID" --label "$TAB_LABEL" --no-focus \
		| python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["tab"]["tab_id"])')"
fi

PANE_ID="$(herdr agent start "$AGENT_NAME" --cwd "$WORKER_CWD" --tab "$TAB_ID" --no-focus -- "${ARGV[@]}" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["pane_id"])')"

# Display-only pane title so humans and remote clients see the task at a glance.
herdr pane report-metadata "$PANE_ID" --source clanky-orchestrator --title "$TASK" >/dev/null 2>&1 || true

SPAWNED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$MANIFEST" "$RUN_ID" "$RUN_DIR" "$WORKSPACE_ID" "$TAB_ID" "$TAB_LABEL" \
	"$AGENT_NAME" "$SLUG" "$TASK" "$WORKER_CWD" "$PANE_ID" "$SPAWNED_AT" "${ARGV[@]}" <<'EOF'
import json, os, sys
(path, run_id, run_dir, workspace_id, tab_id, tab_label,
 name, slug, task, cwd, pane_id, spawned_at) = sys.argv[1:13]
argv = sys.argv[13:]
if os.path.exists(path):
    with open(path) as f:
        manifest = json.load(f)
else:
    manifest = {"run_id": run_id, "created_at": spawned_at,
                "orchestrator": "clanky", "run_dir": run_dir, "workers": []}
manifest["workspace_id"] = workspace_id
manifest["tab_id"] = tab_id
manifest["tab_label"] = tab_label
manifest["workers"].append({
    "name": name, "slug": slug, "task": task, "cwd": cwd, "argv": argv,
    "pane_id_at_spawn": pane_id, "spawned_at": spawned_at,
})
with open(path, "w") as f:
    json.dump(manifest, f, indent=1)
EOF

echo "RUN_ID=$RUN_ID"
echo "RUN_DIR=$RUN_DIR"
echo "AGENT=$AGENT_NAME"
echo "PANE_ID=$PANE_ID"
