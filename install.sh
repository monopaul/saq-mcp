#!/usr/bin/env bash
# Installs the SAQ MCP watcher as a daily launchd agent (macOS only).
# Run once after cloning and building the project.

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
NODE_PATH="$(command -v node)"
PLIST_NAME="com.saq-mcp.watcher"
PLIST_DEST="$HOME_DIR/Library/LaunchAgents/$PLIST_NAME.plist"

echo "→ Install dir : $INSTALL_DIR"
echo "→ node        : $NODE_PATH"
echo "→ plist dest  : $PLIST_DEST"

sed \
  -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
  -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
  -e "s|{{HOME}}|$HOME_DIR|g" \
  "$INSTALL_DIR/com.saq-mcp.watcher.plist.template" \
  > "$PLIST_DEST"

# Unload first in case it's already registered
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "✓ Watcher scheduled daily at 05:30. Logs → ~/.saq-mcp/watcher.*.log"
