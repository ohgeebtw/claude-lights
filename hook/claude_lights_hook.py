#!/usr/bin/env python3
"""Claude Code hook for Claude Lights.

Reads a hook event from stdin and records the session's state in
$XDG_RUNTIME_DIR/claude-lights/<session_id>.json, which the GNOME Shell
extension renders as one top bar light per session.

States: working, attention, background (turn ended but background tasks
are still running), done, error. SessionEnd removes the file.
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
# Events after which the session title may have changed. Claude Code renames
# sessions mid-turn too, and the terminal title follows at once.
TITLE_EVENTS = {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure"}
TITLE_TAIL_BYTES = 256 * 1024
AI_TITLE = re.compile(rb'"type":"ai-title","aiTitle":("(?:[^"\\]|\\.)*")')
# Written by /rename; hooks only see it with the next prompt.
CUSTOM_TITLE = re.compile(rb'"type":"custom-title","customTitle":("(?:[^"\\]|\\.)*")')
# Background tasks in these states no longer keep a session busy.
FINISHED_TASK_STATES = {"completed", "failed", "killed", "stopped", "cancelled", "canceled"}
# Watchers that wait indefinitely for outside events, such as comments on an
# artifact. They are not work you wait for.
PASSIVE_TASK = re.compile(r"^live updates for artifact\b", re.I)


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
    """Return (pid, comm, tty) of the Claude Code process running this hook.

    tty is the controlling terminal number, 0 when there is none.
    """
    pid = os.getppid()
    while pid > 1:
        try:
            comm = read_proc(pid, "comm").decode(errors="replace").strip()
            argv = read_proc(pid, "cmdline").split(b"\0")
            names = {os.path.basename(a.decode(errors="replace")) for a in argv[:2]}
            # Fields after the ")" that ends the name: state, ppid, pgrp,
            # session, tty_nr.
            fields = read_proc(pid, "stat").decode(errors="replace").rsplit(")", 1)[1].split()
            if comm == "claude" or "claude" in names or "cli.js" in names:
                return pid, comm, int(fields[4])
            pid = int(fields[1])
        except (OSError, ValueError, IndexError):
            break
    return None, None, None


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
        return "background" if running_tasks(data) else "done"
    if event == "StopFailure":
        return "error"
    return None


def running_tasks(data, exclude_agent=None):
    """Background tasks from a Stop or SubagentStop event that still run."""
    tasks = data.get("background_tasks")
    if not isinstance(tasks, list):
        return []
    return [
        t for t in tasks
        if isinstance(t, dict)
        and t.get("status") not in FINISHED_TASK_STATES
        and not (isinstance(t.get("description"), str) and PASSIVE_TASK.match(t["description"]))
        and not (exclude_agent and t.get("id") == exclude_agent)
    ]


def task_summary(tasks):
    """Short descriptions for the menu, such as "shell: tail logs"."""
    summary = []
    for t in tasks[:5]:
        kind = t.get("type") if isinstance(t.get("type"), str) else "task"
        text = t.get("description") or t.get("command") or t.get("name") or ""
        summary.append(f"{kind}: {text}"[:80] if isinstance(text, str) and text else kind)
    return summary


def transcript_titles(transcript_path):
    """Return the latest (custom, generated) titles from the transcript tail."""
    if not isinstance(transcript_path, str):
        return None, None
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TITLE_TAIL_BYTES))
            tail = f.read()
    except OSError:
        return None, None

    def latest(pattern):
        matches = pattern.findall(tail)
        try:
            title = json.loads(matches[-1]) if matches else None
        except ValueError:
            return None
        return title[:200] if isinstance(title, str) and title else None

    return latest(CUSTOM_TITLE), latest(AI_TITLE)


def session_title(data, record):
    """Custom title (/rename, --name) wins over the generated one."""
    custom = data.get("session_title")
    generated = None
    if data.get("hook_event_name") in TITLE_EVENTS:
        logged, generated = transcript_titles(data.get("transcript_path"))
        custom = custom or logged
    if isinstance(custom, str) and custom:
        record["custom_title"] = custom[:200]
    return record.get("custom_title") or generated or record.get("title")


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

    pid, comm, tty = claude_process()
    # Headless runs (claude -p from scripts and tools) have no terminal to
    # look at, so they get no light.
    if tty == 0:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return

    state = state_for(data)
    if state is None and data.get("hook_event_name") != "SubagentStop":
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

    event = data.get("hook_event_name")
    if event == "UserPromptSubmit":
        record["turn_active"] = True
    elif event in ("Stop", "StopFailure"):
        record["turn_active"] = False
    # Subagent tool events after the main turn ended are background work,
    # not Claude working on your prompt.
    if data.get("agent_id") and state == "working" and record.get("turn_active") is False:
        state = "background"
    if event == "Stop":
        record["tasks"] = task_summary(running_tasks(data))
    # A background agent finished after the turn: if nothing else runs, the
    # session is done. Claude may not wake up to fire another Stop.
    if event == "SubagentStop":
        if record.get("turn_active") is not False or record.get("state") != "background":
            return
        remaining = running_tasks(data, exclude_agent=data.get("agent_id"))
        record["tasks"] = task_summary(remaining)
        state = "background" if remaining else "done"
    # The idle notification is a fallback for turns that ended without a Stop
    # (Esc). It must not hide a ring, a pending question or an error.
    if event == "Notification" and data.get("notification_type") == "idle_prompt" \
            and record.get("state") not in (None, "working"):
        return

    cwd = data.get("cwd")
    if record.get("state") != state or "since" not in record:
        record["since"] = now
    record.update(
        state=state,
        cwd=cwd if isinstance(cwd, str) else record.get("cwd", ""),
        title=session_title(data, record),
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
