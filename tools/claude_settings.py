#!/usr/bin/env python3
"""Add or remove the Claude Lights hook in Claude Code's settings.json.

Usage: claude_settings.py install <hook-path> | uninstall

Only entries whose command runs claude_lights_hook.py are touched.
A backup is written next to settings.json before any change.
"""
import json
import os
import shlex
import shutil
import sys

MARKER = "claude_lights_hook.py"
EVENTS = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "Stop",
    "StopFailure",
]


def settings_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(base, "settings.json")


def strip(hooks):
    """Remove our hook entries; drop groups and events left empty."""
    for event in list(hooks):
        groups = []
        for group in hooks[event]:
            kept = [h for h in group.get("hooks", []) if MARKER not in h.get("command", "")]
            if kept:
                groups.append({**group, "hooks": kept})
        if groups:
            hooks[event] = groups
        else:
            del hooks[event]


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("install", "uninstall"):
        sys.exit(__doc__)
    action = sys.argv[1]
    path = settings_path()

    try:
        with open(path) as f:
            settings = json.load(f)
    except FileNotFoundError:
        if action == "uninstall":
            return
        settings = {}
    else:
        shutil.copy2(path, path + ".claude-lights.bak")

    hooks = settings.setdefault("hooks", {})
    strip(hooks)
    if action == "install":
        command = "python3 " + shlex.quote(sys.argv[2])
        for event in EVENTS:
            hooks.setdefault(event, []).append(
                {"hooks": [{"type": "command", "command": command, "timeout": 5}]})
    if not hooks:
        del settings["hooks"]

    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".claude-lights.tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"{action}ed hooks in {path}")


if __name__ == "__main__":
    main()
