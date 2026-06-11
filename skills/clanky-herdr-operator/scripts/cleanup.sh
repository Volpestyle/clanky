#!/usr/bin/env bash
# Close a run's herdr tab and optionally delete its run directory.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: cleanup.sh <run-id> [--rm] [--force]
       cleanup.sh --list

Closes the run's clanky:<run-id> tab (which closes every worker pane in
it). Refuses if any worker is still running unless --force is given.
--rm also deletes the run directory; without it, results stay on disk.
--list shows every run directory under the run root with worker states,
to find orphans.
EOF
	exit 2
}

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "cleanup.sh: HERDR_ENV is not 1; not running inside herdr, refusing to control it" >&2
	exit 1
fi

RUN_ROOT="${CLANKY_HERDR_RUN_ROOT:-$HOME/.clanky/herdr-runs}"
RUN_ID="" RM=0 FORCE=0 LIST=0
while [ $# -gt 0 ]; do
	case "$1" in
		--rm) RM=1; shift ;;
		--force) FORCE=1; shift ;;
		--list) LIST=1; shift ;;
		-*) usage ;;
		*) RUN_ID="$1"; shift ;;
	esac
done

if [ "$LIST" = "1" ]; then
	[ -d "$RUN_ROOT" ] || { echo "no run root at $RUN_ROOT"; exit 0; }
	for run in "$RUN_ROOT"/*/; do
		[ -d "$run" ] || continue
		states=""
		for dir in "$run"workers/*/; do
			[ -d "$dir" ] || continue
			slug="$(basename "$dir")"
			if [ -f "$dir/DONE" ]; then s=done
			elif [ -f "$dir/BLOCKED" ]; then s=blocked
			elif herdr agent get "clanky:$slug" >/dev/null 2>&1; then s=running
			else s=dead; fi
			states="$states $slug=$s"
		done
		echo "$(basename "$run")$states"
	done
	exit 0
fi

[ -n "$RUN_ID" ] || usage
RUN_DIR="$RUN_ROOT/$RUN_ID"

RUNNING=""
if [ -d "$RUN_DIR/workers" ]; then
	for dir in "$RUN_DIR"/workers/*/; do
		slug="$(basename "$dir")"
		if [ ! -f "$dir/DONE" ] && [ ! -f "$dir/BLOCKED" ] \
			&& herdr agent get "clanky:$slug" >/dev/null 2>&1; then
			RUNNING="$RUNNING $slug"
		fi
	done
fi
if [ -n "$RUNNING" ] && [ "$FORCE" != "1" ]; then
	echo "cleanup.sh: still running:$RUNNING — harvest first or pass --force" >&2
	exit 1
fi

# Resolve the tab by label across workspaces; manifest tab ids are not durable.
TAB_LABEL="clanky:$RUN_ID"
TAB_ID="$(herdr workspace list | python3 -c 'import sys,json,subprocess
label = sys.argv[1]
for ws in json.load(sys.stdin)["result"]["workspaces"]:
    out = subprocess.run(["herdr", "tab", "list", "--workspace", ws["workspace_id"]],
                         capture_output=True, text=True)
    if out.returncode != 0:
        continue
    for tab in json.loads(out.stdout)["result"]["tabs"]:
        if tab.get("label") == label:
            print(tab["tab_id"])
            raise SystemExit
' "$TAB_LABEL")"

if [ -n "$TAB_ID" ]; then
	herdr tab close "$TAB_ID" >/dev/null
	echo "closed tab $TAB_LABEL ($TAB_ID)"
else
	echo "no tab labeled $TAB_LABEL found (already closed?)"
fi

if [ "$RM" = "1" ] && [ -d "$RUN_DIR" ]; then
	rm -rf "$RUN_DIR"
	echo "removed $RUN_DIR"
fi
