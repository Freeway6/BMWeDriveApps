#!/usr/bin/env python3
"""Build the apps, in German: copies the shared lib/*.js into each app's folder (the kit packs an app folder's own
.js files, flat), then runs the kit's build (kit/tools/build.py) for it as a German package.

    python3 tools/build.py                       # every app in apps/
    python3 tools/build.py i4ev_charge           # one
    python3 tools/build.py --preview-only        # without BMW's oap-sdk: for tools/preview.sh, not installable

German, with kit/ as it is: the build sees a copy of the kit (dist/.kit-de) with the German glyph atlases
(i18n/fonts/de, umlauts added: tools/bake_german.py) over its own and i18n/de.json as its catalog, which
translates the texts the kit draws itself (Settings, Back, On / Off, ...). The apps' own texts are German in
their code and app.json. The package keeps the app's version (the kit would add "-de.1" to it, and the Store
would then see an update that never ends).

On the head unit the MGU Store runs this (mgu-repo.json) with the oap-sdk it generated from a stock app in
oap-sdk/; the copies of lib/ in apps/<id>/ (lib_*.js) and dist/ are build output (.gitignore).
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'lib')
APPS = os.path.join(ROOT, 'apps')
LANGUAGE = 'de'
sys.path.insert(0, os.path.join(ROOT, 'kit', 'tools'))
import build as kit  # noqa: E402  (kit/tools/build.py)
import localize  # noqa: E402  (kit/tools/localize.py)


def stage_lib(app_id):
    adir = os.path.join(APPS, app_id)
    for f in sorted(os.listdir(LIB)):
        if f.endswith('.js'):
            shutil.copy(os.path.join(LIB, f), os.path.join(adir, f))


def stage_kit():
    """dist/.kit-de: the kit's runtime with the German atlases and catalog, and the parts of it the build reads."""
    st = os.path.join(ROOT, 'dist', '.kit-' + LANGUAGE)
    shutil.rmtree(st, ignore_errors=True)
    os.makedirs(os.path.join(st, 'tools'))
    shutil.copytree(os.path.join(ROOT, 'kit', 'runtime'), os.path.join(st, 'runtime'))
    shutil.copytree(os.path.join(ROOT, 'kit', 'platform'), os.path.join(st, 'platform'))
    shutil.copytree(os.path.join(ROOT, 'kit', 'tools', 'oapgen'), os.path.join(st, 'tools', 'oapgen'))
    fonts = os.path.join(ROOT, 'i18n', 'fonts', LANGUAGE)
    for f in os.listdir(fonts):
        shutil.copy(os.path.join(fonts, f), os.path.join(st, 'runtime', 'fonts', f))
    # the catalog: only the German one (the kit's others are not needed in these packages)
    loc = os.path.join(st, 'runtime', 'locales')
    for f in os.listdir(loc):
        os.remove(os.path.join(loc, f))
    shutil.copy(os.path.join(ROOT, 'i18n', LANGUAGE + '.json'), os.path.join(loc, LANGUAGE + '.json'))
    kit.KIT = st
    localize.LOCALES = Path(loc)
    localize.package_version = lambda version, language: version
    return st


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--preview-only', action='store_true')
    p.add_argument('apps', nargs='*')
    a = p.parse_args()
    ids = a.apps or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    stage_kit()
    for i in ids:
        stage_lib(i)
        kit.build(i, LANGUAGE, preview_only=a.preview_only)


if __name__ == '__main__':
    main()
