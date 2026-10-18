# Changelog

All notable changes to Claude Lights. Versions match the extension's
`metadata.json` version.

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
