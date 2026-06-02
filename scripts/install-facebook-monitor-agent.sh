#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.sf-lofts-feed.facebook-monitor"
INTERVAL="${1:-21600}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/monitoring/logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/facebook-monitor-run.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/facebook-monitor.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/facebook-monitor.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"

cat <<EOF
Installed $LABEL.
Interval: $INTERVAL seconds
Plist: $PLIST

To stop it:
  launchctl unload "$PLIST"

To run one batch now:
  "$ROOT/scripts/facebook-monitor-run.sh"
EOF
