#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIMIT="${FACEBOOK_MONITOR_LIMIT:-60}"
NEXT_MD="${FACEBOOK_MONITOR_NEXT_MD:-monitoring/facebook-next.md}"
WATCH_HTML="${FACEBOOK_MONITOR_WATCH_HTML:-monitoring/facebook-watch.html}"
WATCH_MD="${FACEBOOK_MONITOR_WATCH_MD:-monitoring/facebook-watch.md}"
OPEN_SCRIPT="${FACEBOOK_MONITOR_OPEN_SCRIPT:-monitoring/facebook-open-watch.sh}"
GROUP_WATCH_HTML="${FACEBOOK_MONITOR_GROUP_WATCH_HTML:-monitoring/facebook-group-watch.html}"
GROUP_WATCH_MD="${FACEBOOK_MONITOR_GROUP_WATCH_MD:-monitoring/facebook-group-watch.md}"
GROUP_OPEN_SCRIPT="${FACEBOOK_MONITOR_GROUP_OPEN_SCRIPT:-monitoring/facebook-open-groups.sh}"
REVIEW_HTML="${FACEBOOK_MONITOR_REVIEW_HTML:-monitoring/facebook-review.html}"
RUN_JSON="${FACEBOOK_MONITOR_RUN_JSON:-/tmp/sf-lofts-facebook-monitor-run.json}"

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
"$NODE_BIN" scripts/facebook-monitor.mjs run \
  --groups \
  --housing-only \
  --next "$NEXT_MD" \
  --review "$REVIEW_HTML" \
  --watch "$WATCH_MD" \
  --html "$WATCH_HTML" \
  --script "$OPEN_SCRIPT" \
  --group-watch "$GROUP_WATCH_MD" \
  --group-watch-html "$GROUP_WATCH_HTML" \
  --group-watch-script "$GROUP_OPEN_SCRIPT" \
  --limit "$LIMIT" \
  --open-group-watch >"$RUN_JSON"

if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Facebook housing loop is ready." with title "SF Lofts Feed" subtitle "Downloads imported, review scored, group sweep refreshed."' >/dev/null 2>&1 || true
fi
