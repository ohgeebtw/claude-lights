#!/usr/bin/env bash
# Install Claude Lights for the current user: hook, Claude Code settings, GNOME extension.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="claude-lights@ohgeebtw.github.io"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
hook_dir="$data/claude-lights"
ext_dir="$data/gnome-shell/extensions/$uuid"

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

install -d -m 700 "$hook_dir"
install -m 755 "$repo/hook/claude_lights_hook.py" "$hook_dir/"
python3 "$repo/tools/claude_settings.py" install "$hook_dir/claude_lights_hook.py"

install -d "$ext_dir"
install -m 644 "$repo"/extension/{extension.js,metadata.json,stylesheet.css} "$ext_dir/"

if gnome-extensions enable "$uuid" 2>/dev/null; then
    echo "Extension enabled."
else
    # GNOME on Wayland only discovers new extensions at login.
    python3 - "$uuid" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
                     capture_output=True, text=True, check=True).stdout.strip()
enabled = ast.literal_eval(raw.removeprefix("@as "))
if uuid not in enabled:
    enabled.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(enabled)],
                   check=True)
PY
    echo "Extension installed. Log out and back in to load it."
fi
