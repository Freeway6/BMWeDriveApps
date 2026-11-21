#!/bin/sh
# Offline preview without a car or BMW's SDK: builds each app (--preview-only) and saves every page it draws
# with demo data as PNG in preview/<id>/ (kit/tools/preview.js runs the app on a stubbed head unit).
#
#   tools/preview.sh                 # every app
#   tools/preview.sh i4ev_charge     # one
set -e
cd "$(dirname "$0")/.."
apps="$*"
[ -n "$apps" ] || apps=$(ls apps)
for id in $apps; do
    python3 tools/build.py --preview-only "$id" >/dev/null
    rm -rf "preview/$id"
    # the first page after 3 s of demo data, then each page in turn (Next page), and the diagnostics page
    node kit/tools/preview.js "dist/$id" "preview/$id" wait=3 render BTN_PAGE wait=1 render BTN_PAGE wait=1 render \
        BTN_PAGE wait=1 render --set diagPage=false 2>&1 | grep '^frame' || true
done
