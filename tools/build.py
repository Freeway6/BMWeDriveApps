#!/usr/bin/env python3
"""Build the apps: copies the shared lib/*.js into each app's folder (the kit packs an app folder's own .js
files, flat), then runs the kit's build (kit/tools/build.py) for it.

    python3 tools/build.py                       # every app in apps/
    python3 tools/build.py i4ev_charge           # one
    python3 tools/build.py --preview-only        # without BMW's oap-sdk: for tools/preview.sh, not installable

On the head unit the MGU Store runs this (mgu-repo.json) with the oap-sdk it generated from a stock app in
oap-sdk/; the copies of lib/ in apps/<id>/ are build output (.gitignore).
"""
import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'lib')
APPS = os.path.join(ROOT, 'apps')
sys.path.insert(0, os.path.join(ROOT, 'kit', 'tools'))
import build as kit  # noqa: E402  (kit/tools/build.py)


def stage_lib(app_id):
    adir = os.path.join(APPS, app_id)
    for f in sorted(os.listdir(LIB)):
        if f.endswith('.js'):
            shutil.copy(os.path.join(LIB, f), os.path.join(adir, f))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--language', default='en')
    p.add_argument('--preview-only', action='store_true')
    p.add_argument('apps', nargs='*')
    a = p.parse_args()
    ids = a.apps or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    for i in ids:
        stage_lib(i)
        kit.build(i, a.language, preview_only=a.preview_only)


if __name__ == '__main__':
    main()
