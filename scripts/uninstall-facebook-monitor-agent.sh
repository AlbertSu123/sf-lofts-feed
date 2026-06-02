#!/bin/sh
set -eu

LABEL="com.sf-lofts-feed.facebook-monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Uninstalled $LABEL."
