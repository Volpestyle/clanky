#!/usr/bin/env bash
# Spawn one Clanky worker as a named herdr agent pane inside a run tab.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: spawn.sh --slug <task-slug> --task "<one-line summary>" \
                (--prompt "<text>" | --prompt-file <path>) \
                [--run <run-id>] [--cwd <dir>] [-- <worker argv...>]

Spawns one worker agent named clanky:<slug> into the run's herdr tab.
Default worker is clanky (Discord gateway off). In a custom argv, the
token {KICKOFF} is replaced with the kickoff message; without the token
the kickoff is appended as the final argument.

Prints RUN_ID, RUN_DIR, AGENT, PANE_ID lines on success. Pass the same
--run to later spawns to group workers into one run.
EOF
	exit 2
}

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "spawn.sh: HERDR_ENV is not 1; not running inside herdr, refusing to control it" >&2
	exit 1
fi

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ROOT="${CLANKY_HERDR_RUN_ROOT:-$HOME/.clanky/herdr-runs}"

RUN_ID="" SLUG="" TASK="" PROMPT="" PROMPT_FILE="" WORKER_CWD="$PWD"
ARGV=()
while [ $# -gt 0 ]; do
	case "$1" in
		--run) RUN_ID="$2"; shift 2 ;;
		--slug) SLUG="$2"; shift 2 ;;
		--task) TASK="$2"; shift 2 ;;
		--prompt) PROMPT="$2"; shift 2 ;;
		--prompt-file) PROMPT_FILE="$2"; shift 2 ;;
		--cwd) WORKER_CWD="$2"; shift 2 ;;
		--) shift; ARGV=("$@"); break ;;
		*) usage ;;
	esac
done

[ -n "$SLUG" ] && [ -n "$TASK" ] || usage
if [ -z "$PROMPT" ] && [ -z "$PROMPT_FILE" ]; then usage; fi
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
	echo "spawn.sh: slug must be lowercase kebab-case ([a-z0-9-])" >&2
	exit 2
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
EOF

KICKOFF="You are Clanky's worker $AGENT_NAME. Read $WORKER_DIR/prompt.md and do the task it describes, following its completion protocol exactly. Work autonomously."

if [ ${#ARGV[@]} -eq 0 ]; then
	if command -v clanky >/dev/null 2>&1; then
		ARGV=(env CLANKY_CHAT_GATEWAY_OWNER=off clanky --message "{KICKOFF}")
	else
		REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
		ARGV=(env CLANKY_CHAT_GATEWAY_OWNER=off pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/agents/clanky/src/bin.ts" --message "{KICKOFF}")
	fi
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
