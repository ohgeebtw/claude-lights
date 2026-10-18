#!/usr/bin/env bash
# Remove Claude Lights: GNOME extension, Claude Code hooks, hook script, state files.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="claude-lights@ohgeebtw.github.io"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

gnome-extensions disable "$uuid" 2>/dev/null || true
rm -rf "$data/gnome-shell/extensions/$uuid"
python3 "$repo/tools/claude_settings.py" uninstall
rm -rf "$data/claude-lights"
[[ -n "${XDG_RUNTIME_DIR:-}" ]] && rm -rf "$XDG_RUNTIME_DIR/claude-lights"
echo "Claude Lights removed."
