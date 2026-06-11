#!/usr/bin/env bash
# Report (and optionally wait for) the state of every worker in a run.
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: harvest.sh <run-id> [--wait] [--timeout <secs>] [--results]

Prints one "<slug> <state>" line per worker. States:
  done     DONE sentinel file exists; result.md is ready
  blocked  BLOCKED sentinel file exists; worker is waiting for input
  running  no sentinel yet, agent pane still alive
  dead     no sentinel and the agent pane is gone (died silently)

--wait      poll every 5s until no worker is running (or timeout, default 1800s)
--results   after the state lines, print each worker's result.md

Exit 0 when every worker is done; exit 1 otherwise.
EOF
	exit 2
}

if [ "${HERDR_ENV:-}" != "1" ]; then
	echo "harvest.sh: HERDR_ENV is not 1; not running inside herdr, refusing to control it" >&2
	exit 1
fi

RUN_ROOT="${CLANKY_HERDR_RUN_ROOT:-$HOME/.clanky/herdr-runs}"
RUN_ID="" WAIT=0 TIMEOUT=1800 RESULTS=0
while [ $# -gt 0 ]; do
	case "$1" in
		--wait) WAIT=1; shift ;;
		--timeout) TIMEOUT="$2"; shift 2 ;;
		--results) RESULTS=1; shift ;;
		-*) usage ;;
		*) RUN_ID="$1"; shift ;;
	esac
done
[ -n "$RUN_ID" ] || usage

RUN_DIR="$RUN_ROOT/$RUN_ID"
if [ ! -d "$RUN_DIR/workers" ]; then
	echo "harvest.sh: no run at $RUN_DIR" >&2
	exit 1
fi

worker_state() {
	local dir="$1" slug="$2"
	if [ -f "$dir/DONE" ]; then
		echo done
	elif [ -f "$dir/BLOCKED" ]; then
		echo blocked
	elif herdr agent get "clanky:$slug" >/dev/null 2>&1; then
		echo running
	else
		echo dead
	fi
}

DEADLINE=$(( $(date +%s) + TIMEOUT ))
while :; do
	RUNNING=0
	STATES=""
	for dir in "$RUN_DIR"/workers/*/; do
		slug="$(basename "$dir")"
		state="$(worker_state "$dir" "$slug")"
		STATES="$STATES$slug $state"$'\n'
		[ "$state" = "running" ] && RUNNING=$((RUNNING + 1))
	done
	if [ "$WAIT" != "1" ] || [ "$RUNNING" -eq 0 ]; then
		break
	fi
	if [ "$(date +%s)" -ge "$DEADLINE" ]; then
		echo "harvest.sh: timeout after ${TIMEOUT}s with $RUNNING worker(s) still running" >&2
		break
	fi
	sleep 5
done

printf '%s' "$STATES"

if [ "$RESULTS" = "1" ]; then
	for dir in "$RUN_DIR"/workers/*/; do
		slug="$(basename "$dir")"
		echo
		echo "## $slug ($(worker_state "$dir" "$slug")) — $dir"
		if [ -f "$dir/result.md" ]; then
			cat "$dir/result.md"
		else
			echo "(no result.md)"
		fi
	done
fi

if printf '%s' "$STATES" | grep -qv ' done$'; then
	exit 1
fi
exit 0
