#!/usr/bin/env python3
"""The German glyph atlases: the kit's label, bold, light and num atlases with the letters German needs added.

    python3 tools/bake_german.py [path/to/Ubuntu[wdth,wght].ttf]     -> i18n/fonts/de/<family>.json

German is written in the Latin script the kit draws, plus Ä Ö Ü ä ö ü ß (and whatever else the catalog and the
apps' texts use). Every glyph the kit's atlases have stays exactly as it is (same pixels, same place, same advance:
checked), so text without umlauts looks and measures the same. Their own cacheKey keeps them apart from other apps'
English atlases in the renderer, which shares atlases between apps by family, size and key.

The way idrive7-apps bakes its Spanish atlases (kit/tools/bake_spanish.py there, MIT). Needs Pillow with raqm
(HarfBuzz advances, as the kit's atlases were baked) and the Ubuntu font (Ubuntu 24.04: apt-get install
fonts-ubuntu). The atlases are committed: building the apps needs neither.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
FAMILIES = ('label', 'bold', 'light', 'num')
GERMAN = 'ÄÖÜäöüß'
OUT = ROOT / 'i18n/fonts/de'


def used_letters(baker):
    """Letters the German texts use that the kit's atlases lack: the catalog, the apps' code and app.json."""
    text = (ROOT / 'i18n/de.json').read_text(encoding='utf-8')
    for p in list((ROOT / 'apps').glob('*/main.js')) + list((ROOT / 'apps').glob('*/app.json')) + list((ROOT / 'lib').glob('*.js')):
        text += p.read_text(encoding='utf-8')
    used = set(GERMAN + text) - set('\n\r\t')
    return ''.join(sorted(ch for ch in used if ch not in baker.TEXT and ord(ch) >= 0xA0 and ord(ch) < 0x2000))


def main():
    font = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path('/usr/share/fonts/truetype/ubuntu/Ubuntu[wdth,wght].ttf')
    if not font.is_file():
        raise SystemExit('Ubuntu font not found; pass the path to Ubuntu[wdth,wght].ttf (apt-get install fonts-ubuntu)')
    from PIL import features
    if not features.check('raqm'):
        raise SystemExit('Pillow has no raqm layout here (libraqm, libfribidi, libharfbuzz): the advances would not match the kit atlases')
    spec = importlib.util.spec_from_file_location('bake_fonts', ROOT / 'kit/tools/bake_fonts.py')
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    baker.FONTDIR = str(font.parent)
    extra = used_letters(baker)
    print('extra letters: ' + extra)
    OUT.mkdir(parents=True, exist_ok=True)
    for family in FAMILIES:
        fname, var, sizes = baker.FAMILIES[family]
        english = json.loads((ROOT / 'kit/runtime/fonts' / (family + '.json')).read_text(encoding='utf-8'))
        baked = []
        for (size, charset), before in zip(sizes, english['sizes']):
            atlas = baker.bake(fname, var, size, charset + extra if charset == baker.TEXT else charset)
            for code, glyph in before['glyphs'].items():
                if atlas['glyphs'][int(code)] != glyph:
                    raise SystemExit('%s %d: glyph %r differs from the kit atlas (another font version?)' % (family, size, chr(int(code))))
            if atlas['atlasH'] > 1024:
                raise SystemExit('%s %d: atlas exceeds 1024 rows' % (family, size))
            baked.append(atlas)
        cache_key = 'de-' + hashlib.sha256(json.dumps(baked, separators=(',', ':')).encode()).hexdigest()[:13]
        data = {'family': family, 'source': fname, 'cacheKey': cache_key, 'sizes': baked}
        out = OUT / (family + '.json')
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        print('%s: sizes %s, %d bytes' % (family, [a['size'] for a in baked], out.stat().st_size))


if __name__ == '__main__':
    main()
