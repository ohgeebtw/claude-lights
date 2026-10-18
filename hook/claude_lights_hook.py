#!/usr/bin/env python3
"""Claude Code hook for Claude Lights.

Reads a hook event from stdin and records the session's state in
$XDG_RUNTIME_DIR/claude-lights/<session_id>.json, which the GNOME Shell
extension renders as one top bar light per session.

States: working, attention, done, error. SessionEnd removes the file.
Stdlib only. Never fails the hook: every error exits 0 silently.
"""
import json
import os
import re
import sys
import time

ATTENTION_NOTIFICATIONS = {
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
}
ATTENTION_TOOLS = {"AskUserQuestion", "ExitPlanMode"}
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def state_dir():
    # XDG_RUNTIME_DIR is private to the user (0700). No /tmp fallback:
    # a shared directory would allow symlink tricks by other users.
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime or not os.path.isdir(runtime):
        return None
    return os.path.join(runtime, "claude-lights")


def read_proc(pid, name):
    with open(f"/proc/{pid}/{name}", "rb") as f:
        return f.read()


def claude_process():
    """Return (pid, comm) of the Claude Code process running this hook."""
    pid = os.getppid()
    while pid > 1:
        try:
            comm = read_proc(pid, "comm").decode(errors="replace").strip()
            argv = read_proc(pid, "cmdline").split(b"\0")
            names = {os.path.basename(a.decode(errors="replace")) for a in argv[:2]}
            if comm == "claude" or "claude" in names or "cli.js" in names:
                return pid, comm
            stat = read_proc(pid, "stat").decode(errors="replace")
            pid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return None, None


def state_for(data):
    event = data.get("hook_event_name")
    if event == "SessionStart":
        return "done"
    if event in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PermissionDenied"):
        return "working"
    if event == "PreToolUse":
        return "attention" if data.get("tool_name") in ATTENTION_TOOLS else "working"
    if event == "PermissionRequest":
        return "attention"
    if event == "Notification":
        kind = data.get("notification_type")
        if kind in ATTENTION_NOTIFICATIONS:
            return "attention"
        if kind == "idle_prompt":
            return "done"
        return None
    if event == "Stop":
        return "done"
    if event == "StopFailure":
        return "error"
    return None


def main():
    data = json.load(sys.stdin)
    session_id = data.get("session_id")
    directory = state_dir()
    if not isinstance(session_id, str) or not SESSION_ID.match(session_id) or not directory:
        return
    path = os.path.join(directory, f"{session_id}.json")

    if data.get("hook_event_name") == "SessionEnd":
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return

    state = state_for(data)
    if state is None:
        return

    os.makedirs(directory, mode=0o700, exist_ok=True)
    now = time.time()
    try:
        with open(path) as f:
            record = json.load(f)
        if not isinstance(record, dict):
            raise ValueError
    except (OSError, ValueError):
        record = {"started": now}
    pid, comm = claude_process()
    cwd = data.get("cwd")
    record.update(
        state=state,
        cwd=cwd if isinstance(cwd, str) else record.get("cwd", ""),
        pid=pid,
        comm=comm,
        updated=now,
    )
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    os.replace(tmp, path)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
