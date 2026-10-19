#!/usr/bin/env bash
# Try the current extension code without logging out: starts a nested GNOME
# Shell window with the extension and demo sessions loaded. Close the window
# to stop. Run again after every code change (GNOME caches extension code).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="claude-lights@ohgeebtw.github.io"
ext_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
export CLAUDE_LIGHTS_DIR="$XDG_RUNTIME_DIR/claude-lights-demo"

# The nested shell loads the installed copy; the real top bar keeps the old
# code until the next login.
install -d "$ext_dir"
install -m 644 "$repo"/extension/{extension.js,metadata.json,stylesheet.css} "$ext_dir/"

major=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if (( major >= 49 )); then flag=--devkit; else flag=--nested; fi

mkdir -p -m 700 "$CLAUDE_LIGHTS_DIR"
trap 'pkill -f "demo.sh --dir $CLAUDE_LIGHTS_DIR" 2>/dev/null; rm -rf "$CLAUDE_LIGHTS_DIR"' EXIT

dbus-run-session -- bash -c '
    display=claude-lights-nested
    MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 gnome-shell '"$flag"' --wayland --wayland-display=$display &
    shell=$!
    # The socket appears before the shell accepts clients.
    gdbus wait --session --timeout 30 org.gnome.Shell || true
    sleep 2
    gnome-extensions enable '"$uuid"' 2>/dev/null || true
    # Started after the shell, so the demo lights count as new and pulse.
    "'"$repo"'/tools/demo.sh" --dir "$CLAUDE_LIGHTS_DIR" >/dev/null &
    # Terminals titled like demo sessions, so clicking a session in the menu
    # has a window to jump to.
    if command -v ghostty >/dev/null; then
        for title in "Fix flaky login test" "Refactor payment webhooks"; do
            WAYLAND_DISPLAY=$display ghostty --gtk-single-instance=false --title="$title" >/dev/null 2>&1 &
        done
    fi
    wait $shell
'
