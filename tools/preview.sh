#!/bin/sh
# Offline preview without a car or BMW's SDK: builds each app (--preview-only) and saves every page it draws
# with demo data as PNG in preview/<id>/page-<n>.png (kit/tools/preview.js runs the app on a stubbed head unit),
# and the pages without data (demo off, diagnostics page on) in preview/<id>-empty/.
#
#   tools/preview.sh                 # every app
#   tools/preview.sh b58_coach       # one
set -e
cd "$(dirname "$0")/.."
apps="$*"
[ -n "$apps" ] || apps=$(ls apps)
# the first page after 3 s, then the next five in turn (Next page wraps round after the last)
steps='wait=3 render BTN_PAGE wait=1 render BTN_PAGE wait=1 render BTN_PAGE wait=1 render BTN_PAGE wait=1 render BTN_PAGE wait=1 render'
for id in $apps; do
    python3 tools/build.py --preview-only "$id" >/dev/null
    for v in demo empty; do
        dir="preview/$id"; set --
        [ "$v" = empty ] && { dir="preview/$id-empty"; set -- --set demo=off --set diagPage=true; }
        rm -rf "$dir" "$dir.tmp"
        node kit/tools/preview.js "dist/$id" "$dir.tmp" "$@" $steps >/dev/null 2>&1 || true
        # each page's frame after its wait (the frames between are the redraw right after the button)
        mkdir -p "$dir"
        k=1
        for f in 1 3 5 7 9 11; do
            [ -f "$dir.tmp/main_gfx-$f.png" ] && mv "$dir.tmp/main_gfx-$f.png" "$dir/page-$k.png"
            k=$((k + 1))
        done
        rm -rf "$dir.tmp"
    done
    echo "$id: $(ls "preview/$id" | wc -l) pages, $(ls "preview/$id-empty" | wc -l) without data"
done
