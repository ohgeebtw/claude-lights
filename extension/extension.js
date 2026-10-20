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

// Keys are the states the hook writes; `replied` is display only.
const LABELS = {
    working: 'working',
    attention: 'needs you',
    background: 'background work running',
    replied: 'replied, background work running',
    done: 'done',
    error: 'error',
};
// These pulse until you have looked at the session's terminal: each means
// Claude replied, asked or failed. Working and the blue ring stay still.
const PULSE_STATES = new Set(['attention', 'replied', 'done', 'error']);
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
        if (record.comm && comm.trim() !== record.comm)
            return false;
        // Fields after the ")" that ends the command name: state is first,
        // the controlling terminal fifth. A stopped process (Ctrl+Z) whose
        // terminal was closed lingers forever but will never act again.
        const stat = await readText(Gio.File.new_for_path(`/proc/${record.pid}/stat`));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return !(['T', 't'].includes(fields[0]) && fields[4] === '0');
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
            if (!record || !(record.state in LABELS) || record.state === 'replied' ||
                typeof record.started !== 'number')
                continue;
            if (!await isAlive(record)) {
                file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
                continue;
            }
            sessions.push({...record, id: name.slice(0, -'.json'.length)});
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
const stripGlyph = t => (t ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

function titleMatches(win, title) {
    return typeof title === 'string' && title !== '' &&
        (win?.get_title() ?? '').includes(title);
}

function findTerminalWindow(title) {
    if (typeof title !== 'string' || !title)
        return null;
    const windows = global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(win => win && !win.skip_taskbar);
    return windows.find(win => stripGlyph(win.get_title()) === title) ??
        windows.find(win => titleMatches(win, title)) ??
        null;
}

function stateSince(record) {
    return record.since ?? record.updated ?? record.started;
}

function makeDot(state) {
    return new St.Widget({
        style_class: `claude-lights-dot claude-lights-${state}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Call once the dot is attached to the stage: a transition needs the
// stage's frame clock to run.
function startPulse(dot) {
    const transition = new Clutter.PropertyTransition({
        property_name: 'opacity',
        duration: 700,
        progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        auto_reverse: true,
        repeat_count: -1,
    });
    transition.set_from(255);
    transition.set_to(60);
    dot.add_transition('pulse', transition);
}

export default class ClaudeLightsExtension extends Extension {
    enable() {
        // CLAUDE_LIGHTS_DIR lets tools/nested.sh point a test shell at demo data.
        this._dir = Gio.File.new_for_path(GLib.getenv('CLAUDE_LIGHTS_DIR') ||
            GLib.build_filenamev([GLib.get_user_runtime_dir(), 'claude-lights']));
        GLib.mkdir_with_parents(this._dir.get_path(), 0o700);

        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._button.add_child(this._box);
        this._button.visible = false;
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._sessions = [];
        // Session ids in display order; new sessions are appended.
        this._order = [];
        // Session id -> time you last looked at its terminal.
        this._seen = new Map();
        // Session id -> menu label, updated in place between rebuilds.
        this._labels = new Map();
        // Session id -> {item, dot}, for reordering in place while dragging.
        this._rows = new Map();
        this._drag = null;
        this._focusId = global.display.connect('notify::focus-window', () => {
            if (this._markFocusedSeen())
                this._render();
        });

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
        if (this._focusId)
            global.display.disconnect(this._focusId);
        this._drag?.grab.dismiss();
        this._monitor?.cancel();
        this._button?.destroy();
        this._timer = null;
        this._pending = null;
        this._focusId = null;
        this._monitor = null;
        this._button = null;
        this._box = null;
        this._dir = null;
        this._sessions = null;
        this._order = null;
        this._seen = null;
        this._labels = null;
        this._rows = null;
        this._drag = null;
        this._signature = null;
        this._loaded = false;
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

        const ids = new Set(sessions.map(s => s.id));
        for (const id of this._seen.keys()) {
            if (!ids.has(id))
                this._seen.delete(id);
        }
        this._order = this._order.filter(id => ids.has(id));
        for (const s of sessions) {
            if (!this._order.includes(s.id))
                this._order.push(s.id);
        }
        // Whatever happened before the extension loaded counts as seen.
        if (!this._loaded) {
            this._loaded = true;
            for (const s of sessions)
                this._seen.set(s.id, stateSince(s));
        }
        this._sessions = sessions.sort(
            (a, b) => this._order.indexOf(a.id) - this._order.indexOf(b.id));
        this._markFocusedSeen();
        this._render();
    }

    // Marks the sessions shown in the focused window as seen. Returns true
    // if that stopped a pulse.
    _markFocusedSeen() {
        const win = global.display.focus_window;
        let changed = false;
        for (const s of this._sessions) {
            if (titleMatches(win, s.title)) {
                changed ||= this._pulses(s);
                this._seen.set(s.id, Date.now() / 1000);
            }
        }
        return changed;
    }

    _isUnseen(s) {
        return stateSince(s) > (this._seen.get(s.id) ?? 0);
    }

    // A ring you haven't seen yet means Claude replied while background
    // work keeps running.
    _displayState(s) {
        return s.state === 'background' && this._isUnseen(s) ? 'replied' : s.state;
    }

    _pulses(s) {
        return PULSE_STATES.has(this._displayState(s)) && this._isUnseen(s);
    }

    _signatureOf() {
        return this._sessions
            .map(s => `${s.id}:${this._displayState(s)}:${this._pulses(s)}`).join('|');
    }

    _render() {
        // A rebuild would destroy the row being dragged; catch up on drop.
        if (this._drag)
            return;
        // Rebuilding unchanged dots would restart their pulse animation, so
        // rebuild only when order, states or pulses change.
        const signature = this._signatureOf();
        if (signature !== this._signature) {
            this._signature = signature;
            this._box.destroy_all_children();
            this._button.menu.removeAll();
            this._labels.clear();
            this._rows.clear();
            for (const s of this._sessions) {
                const dot = makeDot(this._displayState(s));
                const {item, menuDot} = this._makeItem(s);
                this._box.add_child(dot);
                this._button.menu.addMenuItem(item);
                if (this._pulses(s)) {
                    startPulse(dot);
                    startPulse(menuDot);
                }
                this._rows.set(s.id, {item, dot});
            }
            this._button.visible = this._sessions.length > 0;
        }
        for (const s of this._sessions) {
            const labels = this._labels.get(s.id);
            labels?.main.set_text(this._itemText(s));
            labels?.tasks.set_text(this._tasksText(s));
            if (labels)
                labels.tasks.visible = labels.tasks.text !== '';
        }
    }

    // What a ring is waiting for, as reported by Claude Code.
    _tasksText(s) {
        if (s.state !== 'background' || !Array.isArray(s.tasks))
            return '';
        return s.tasks.filter(t => typeof t === 'string').join('\n');
    }

    _itemText(s) {
        return `${sessionName(s)}: ${LABELS[this._displayState(s)]} (${elapsed(stateSince(s))})`;
    }

    // Press the handle, drag the row up or down, release. Rows and top bar
    // lights move live; a grab keeps pointer events coming during the drag.
    _makeHandle(id, item) {
        const handle = new St.Bin({
            style_class: 'claude-lights-handle',
            child: new St.Icon({icon_name: 'list-drag-handle-symbolic', style_class: 'popup-menu-icon'}),
            reactive: true,
            track_hover: true,
        });
        handle.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._drag = {id, item, grab: global.stage.grab(handle)};
            item.add_style_class_name('claude-lights-dragging');
            return Clutter.EVENT_STOP;
        });
        handle.connect('motion-event', (_actor, event) => {
            if (this._drag?.id !== id)
                return Clutter.EVENT_PROPAGATE;
            this._dragTo(event.get_coords()[1]);
            return Clutter.EVENT_STOP;
        });
        handle.connect('button-release-event', () => {
            if (this._drag?.id !== id)
                return Clutter.EVENT_PROPAGATE;
            this._endDrag();
            return Clutter.EVENT_STOP;
        });
        // The menu closed or was rebuilt mid-drag: drop the grab, or the
        // lights would never update again.
        handle.connect('destroy', () => {
            if (this._drag?.id !== id)
                return;
            this._drag.grab.dismiss();
            this._drag = null;
        });
        return handle;
    }

    _dragTo(pointerY) {
        const {id} = this._drag;
        const from = this._order.indexOf(id);
        // Target: the row whose vertical span holds the pointer.
        let to = from;
        this._order.forEach((otherId, index) => {
            const row = this._rows.get(otherId)?.item;
            if (!row)
                return;
            const [, y] = row.get_transformed_position();
            const [, height] = row.get_transformed_size();
            if (pointerY >= y && pointerY < y + height)
                to = index;
        });
        if (to === from)
            return;
        this._order.splice(from, 1);
        this._order.splice(to, 0, id);
        const {item, dot} = this._rows.get(id);
        this._button.menu.box.set_child_at_index(item, to);
        this._box.set_child_at_index(dot, to);
    }

    _endDrag() {
        const {item, grab} = this._drag;
        grab.dismiss();
        item.remove_style_class_name('claude-lights-dragging');
        this._drag = null;
        this._sessions.sort((a, b) => this._order.indexOf(a.id) - this._order.indexOf(b.id));
        // Catch up on refreshes skipped during the drag.
        this._render();
    }

    _makeItem(s) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const menuDot = makeDot(this._displayState(s));
        item.add_child(menuDot);
        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({text: this._itemText(s)});
        const tasks = new St.Label({style_class: 'claude-lights-tasks', text: this._tasksText(s)});
        tasks.visible = tasks.text !== '';
        text.add_child(label);
        text.add_child(tasks);
        item.add_child(text);
        item.label_actor = label;
        this._labels.set(s.id, {main: label, tasks});

        item.add_child(this._makeHandle(s.id, item));

        item.connect('activate', () => {
            const win = findTerminalWindow(s.title);
            if (!win) {
                Main.notify(this.metadata.name, `No window titled "${sessionName(s)}" found`);
                return;
            }
            this._seen.set(s.id, Date.now() / 1000);
            Main.activateWindow(win);
            this._render();
        });
        return {item, menuDot};
    }
}
