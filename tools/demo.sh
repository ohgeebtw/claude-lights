#!/usr/bin/env bash
# Show made-up sessions in every state, for screenshots and testing.
#
#   tools/demo.sh             in your real top bar; real sessions are hidden
#                             while it runs and restored on exit
#   tools/demo.sh --dir DIR   write demo sessions to DIR only (see nested.sh)
#
# Runs until Ctrl+C, then cleans up.
set -euo pipefail

real_dir="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is not set}/claude-lights"
dir="$real_dir"
[[ "${1:-}" == "--dir" ]] && dir="${2:?--dir needs a path}"

mkdir -p -m 700 "$dir"
stash=""
if [[ "$dir" == "$real_dir" ]]; then
    stash="$(mktemp -d)"
    echo "Pause your Claude sessions: a real session puts its light back when it acts."
fi

cleanup() {
    rm -f "$dir"/demo-*.json
    if [[ -n "$stash" ]]; then
        # A session that acted meanwhile already has a fresher file.
        for f in "$stash"/*.json; do
            [[ -e "$f" ]] || continue
            [[ -e "$dir/${f##*/}" ]] && rm -f "$f" || mv "$f" "$dir/"
        done
        rmdir "$stash"
    fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

[[ -n "$stash" ]] && { mv "$dir"/*.json "$stash"/ 2>/dev/null || true; }

now=$(date +%s)
comm=$(cat /proc/$$/comm)
i=0
while IFS='|' read -r state title age; do
    i=$((i + 1))
    printf '{"started":%s,"state":"%s","title":"%s","cwd":"/home/user/project","pid":%s,"comm":"%s","updated":%s,"since":%s,"tasks":["shell: npm run build","subagent: Review migration plan"]}\n' \
        $((now - 3600 + i)) "$state" "$title" $$ "$comm" $((now - age)) $((now - age)) > "$dir/demo-$i.json"
done <<'DATA'
working|Add dark mode to settings page|8
attention|Fix flaky login test|25
background|Migrate CI to new runners|140
done|Refactor payment webhooks|52
error|Bump dependencies|300
DATA

echo "Demo running in $dir. Ctrl+C to stop."
while :; do sleep 1; done
