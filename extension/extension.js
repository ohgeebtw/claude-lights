// Claude Lights: one top bar light per running Claude Code session.
// Session state files are written by the Claude Code hook in hook/.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const LABELS = {
    working: 'working',
    attention: 'needs you',
    background: 'background work running',
    done: 'done',
    error: 'error',
};
// Catches sessions whose Claude process died without a SessionEnd hook.
const POLL_SECONDS = 5;

const decoder = new TextDecoder();

async function readText(file) {
    const [bytes] = await file.load_contents_async(null);
    return decoder.decode(bytes);
}

async function isAlive(record) {
    if (!Number.isInteger(record.pid))
        return true;
    try {
        const comm = await readText(Gio.File.new_for_path(`/proc/${record.pid}/comm`));
        // A reused PID belongs to a different program.
        return !record.comm || comm.trim() === record.comm;
    } catch {
        return false;
    }
}

async function readSessions(dir) {
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    } catch {
        return [];
    }
    const sessions = [];
    for (;;) {
        const infos = await enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, null);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const file = dir.get_child(name);
            let record;
            try {
                record = JSON.parse(await readText(file));
            } catch {
                continue; // Removed between listing and reading.
            }
            if (!record || !(record.state in LABELS) || typeof record.started !== 'number')
                continue;
            if (!await isAlive(record)) {
                file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
                continue;
            }
            sessions.push(record);
        }
    }
    enumerator.close(null);
    return sessions.sort((a, b) => a.started - b.started);
}

function elapsed(since) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - since));
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}

function sessionName(record) {
    if (typeof record.title === 'string' && record.title)
        return record.title;
    if (typeof record.cwd === 'string' && record.cwd)
        return GLib.path_get_basename(record.cwd);
    return '?';
}

// Claude Code sets the terminal title to the session title, prefixed with a
// status glyph such as "✳ ". Prefer an exact match after the glyph.
function findTerminalWindow(title) {
    if (typeof title !== 'string' || !title)
        return null;
    const windows = global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(win => win && !win.skip_taskbar);
    const strip = t => (t ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    return windows.find(win => strip(win.get_title()) === title) ??
        windows.find(win => (win.get_title() ?? '').includes(title)) ??
        null;
}

function makeDot(state) {
    return new St.Widget({
        style_class: `claude-lights-dot claude-lights-${state}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export default class ClaudeLightsExtension extends Extension {
    enable() {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_runtime_dir(), 'claude-lights']));
        GLib.mkdir_with_parents(this._dir.get_path(), 0o700);

        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._button.add_child(this._box);
        this._button.visible = false;
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._queueRefresh());
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._queueRefresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._queueRefresh();
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._pending)
            GLib.source_remove(this._pending);
        this._monitor?.cancel();
        this._button?.destroy();
        this._timer = null;
        this._pending = null;
        this._monitor = null;
        this._button = null;
        this._box = null;
        this._dir = null;
    }

    // Coalesces bursts of file events into one refresh.
    _queueRefresh() {
        if (this._pending)
            return;
        this._pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._pending = null;
            this._refresh().catch(e => console.error(`${this.metadata.name}: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const generation = this._generation = (this._generation ?? 0) + 1;
        const sessions = await readSessions(this._dir);
        // Disabled meanwhile, or a newer refresh started.
        if (!this._button || generation !== this._generation)
            return;

        this._box.destroy_all_children();
        this._button.menu.removeAll();
        this._button.visible = sessions.length > 0;

        for (const s of sessions) {
            this._box.add_child(makeDot(s.state));
            const item = new PopupMenu.PopupMenuItem(
                `${sessionName(s)}: ${LABELS[s.state]} (${elapsed(s.updated ?? s.started)})`);
            item.insert_child_at_index(makeDot(s.state), 0);
            item.connect('activate', () => {
                const win = findTerminalWindow(s.title);
                if (win)
                    Main.activateWindow(win);
                else
                    Main.notify(this.metadata.name, `No window titled "${sessionName(s)}" found`);
            });
            this._button.menu.addMenuItem(item);
        }
    }
}
