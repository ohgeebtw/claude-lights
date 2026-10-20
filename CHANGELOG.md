# Changelog

All notable changes to Claude Lights. Versions match the extension's
`metadata.json` version.

## 6 - 2026-10-21

### Added

- The menu lists what a blue ring is waiting for, such as
  `shell: npm run build`, under the session.

### Fixed

- A session kept a blue ring after its background work had finished: tasks
  Claude Code still listed as completed, stopped or failed counted as running,
  and a background agent finishing after the turn didn't update the light.
  The hook now ignores finished tasks and also listens to SubagentStop.

## 5 - 2026-10-19

### Added

- Yellow, green and red pulse until you have seen them, meaning you focused
  the session's terminal window or jumped to it from the menu. Lights in the
  menu pulse too.
- Green ring: Claude replied while background work keeps running. It pulses
  until seen, then turns into the still blue ring.
- Reorder sessions by dragging a row's grip handle in the menu. The top bar
  follows.
- The menu shows how long a session has been in its current state, not since
  its last event.

### Fixed

- Claude Code's idle notification, about a minute after a turn, turned a blue
  ring, yellow or red light green. It now only ends a "working" light, for
  turns interrupted with Esc.

## 4 - 2026-10-18

### Added

- `tools/nested.sh`: try the extension in a nested GNOME Shell window without
  logging out, with demo sessions and test terminals.
- `tools/demo.sh`: made-up sessions in every state, for screenshots.
- `CLAUDE_LIGHTS_DIR` environment variable to point the extension at another
  state directory.

### Fixed

- README: the blue ring showed as a filled blue dot. The legend now uses
  images of the real lights.
- README screenshot shows all five states.

## 3 - 2026-10-18

### Added

- Click a session in the menu to bring its terminal window to the front,
  matched by the session title in the window title. Sessions in background
  terminal tabs can't be found.

## 2 - 2026-10-18

### Added

- Blue ring state: the turn ended, but background commands or agents are still
  running. Read from the `background_tasks` list of Claude Code's Stop event.
- Session titles in the menu: the generated title your terminal shows, or the
  name set with `/rename` or `--name`. Falls back to the folder name.
- Screenshot in the README.

### Fixed

- A session showed green while it was still waiting on background commands
  or agents.
- A session showed "working" after its turn ended because tool events from a
  background agent reset the state. Agent activity after the turn now shows
  the blue ring, and an agent's permission prompt still shows yellow.

## 1 - 2026-10-18

### Added

- One top bar light per Claude Code session: blue working, yellow needs you,
  green done, red API error.
- Click menu with each session's folder, state and time in that state.
- Automatic cleanup of sessions whose Claude process exited without a
  SessionEnd event.
- `install.sh` and `uninstall.sh` that merge and remove only Claude Lights'
  own hook entries in `settings.json`, with a backup.
