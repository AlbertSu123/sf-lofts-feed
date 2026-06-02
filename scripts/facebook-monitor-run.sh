#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIMIT="${FACEBOOK_MONITOR_LIMIT:-60}"
WATCH_HTML="${FACEBOOK_MONITOR_WATCH_HTML:-monitoring/facebook-watch.html}"
WATCH_MD="${FACEBOOK_MONITOR_WATCH_MD:-monitoring/facebook-watch.md}"
OPEN_SCRIPT="${FACEBOOK_MONITOR_OPEN_SCRIPT:-monitoring/facebook-open-watch.sh}"

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found; install Node or set NODE_BIN before running facebook-monitor-run.sh" >&2
  exit 1
fi

cd "$ROOT"
"$NODE_BIN" scripts/facebook-monitor.mjs watch \
  --html "$WATCH_HTML" \
  --out "$WATCH_MD" \
  --script "$OPEN_SCRIPT" \
  --limit "$LIMIT" >/tmp/sf-lofts-facebook-monitor-watch.json

open "$ROOT/$WATCH_HTML"

if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Facebook housing watch batch is ready." with title "SF Lofts Feed" subtitle "Open the batch, capture promising posts, then score the inbox."' >/dev/null 2>&1 || true
fi
