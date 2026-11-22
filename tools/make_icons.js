'use strict';
/**
 * make_icons.js - the four apps' tile icons (140 x 140, white line art on transparent with one accent, in the
 * HMI's style), drawn with the kit's canvas: node tools/make_icons.js  -> apps/<id>/icon.png
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const W = '#ffffff', A = '#2fd27a', R = '#e4002b';
const out = (id, c) => { fs.writeFileSync(path.join(__dirname, '..', 'apps', id, 'icon.png'), c.png()); console.log('apps/' + id + '/icon.png'); };

// Motor-Check: an inline six (cam cover, block with six cylinders, oil pan) and a check mark
(() => {
    const c = new Canvas(140, 140);
    c.roundRect(26, 22, 88, 12, 4, W);
    c.strokeRoundRect(16, 40, 108, 44, 8, 6, W);
    for (let i = 0; i < 6; i++) c.arc(31 + i * 15.6, 62, 3.5, 7.5, 0, 360, W);
    c.quad([[30, 90], [110, 90], [100, 110], [40, 110]], W);
    c.circle(108, 106, 22, A);
    c.line(97, 106, 105, 114, 6, W);
    c.line(105, 114, 120, 97, 6, W);
    out('b58_health', c);
})();

// Sprit-Check: a fuel pump with its display, hose and nozzle, and a drop
(() => {
    const c = new Canvas(140, 140);
    c.strokeRoundRect(24, 28, 52, 84, 8, 6, W);
    c.roundRect(34, 38, 32, 22, 3, W);
    c.fillRect(16, 112, 68, 7, W);
    c.polyline([[76, 52], [94, 52], [104, 64], [104, 96], [96, 104], [88, 98]], 6, W);
    c.quad([[96, 40], [108, 40], [104, 54], [92, 54]], W);
    // the drop: a round bottom and a point
    c.circle(118, 34, 11, A);
    c.triangle([[107, 31], [129, 31], [118, 12]], A);
    out('b58_fuel', c);
})();

// Pull-Check: power over engine speed, rising fast to its plateau, under a dashed target
(() => {
    const c = new Canvas(140, 140);
    c.line(20, 116, 124, 116, 5, W);
    c.line(22, 118, 22, 22, 5, W);
    for (let x = 52; x < 120; x += 16) c.line(x, 34, x + 9, 34, 4, W);
    c.polyline([[28, 108], [40, 84], [52, 56], [64, 42], [84, 38], [104, 40], [120, 46]], 7, R);
    c.triangle([[34, 44], [46, 22], [56, 46]], W);
    c.fillRect(42, 44, 6, 22, W);
    out('b58_pull', c);
})();

// Verbrauchs-Coach: a gauge with its green band low and the needle in it, over a drop
(() => {
    const c = new Canvas(140, 140);
    const rad = (d) => d * Math.PI / 180, pt = (r, a) => [70 + Math.sin(rad(a)) * r, 74 - Math.cos(rad(a)) * r];
    c.arc(70, 74, 46, 54, -135, 135, W, { round: true });
    c.arc(70, 74, 46, 54, -135, -45, A, { round: true });
    for (let a = -135; a <= 135; a += 45) { const p0 = pt(34, a), p1 = pt(40, a); c.line(p0[0], p0[1], p1[0], p1[1], 4, W); }
    const n = pt(38, -80);
    c.line(70, 74, n[0], n[1], 6, W);
    c.circle(70, 74, 8, W);
    c.circle(70, 116, 10, W);
    c.triangle([[60, 113], [80, 113], [70, 96]], W);
    out('b58_coach', c);
})();
