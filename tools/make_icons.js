'use strict';
/**
 * make_icons.js - the four apps' tile icons (140 x 140, white line art on transparent with one accent, in the
 * HMI's style), drawn with the kit's canvas: node tools/make_icons.js  -> apps/<id>/icon.png
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const W = '#ffffff', A = '#2fd27a', B = '#2a8cff';
const out = (id, c) => { fs.writeFileSync(path.join(__dirname, '..', 'apps', id, 'icon.png'), c.png()); console.log('apps/' + id + '/icon.png'); };

/** A battery lying down: body outline and its tip. */
function battery(c, x, y, w, h) {
    c.strokeRoundRect(x, y, w, h, 10, 6, W);
    c.roundRect(x + w + 2, y + h * 0.32, 9, h * 0.36, 3, W);
}

// Charge Curve: a charge curve rising and falling over a battery's charge axis, with a bolt
(() => {
    const c = new Canvas(140, 140);
    c.line(20, 116, 124, 116, 5, W);
    c.line(22, 118, 22, 22, 5, W);
    c.polyline([[26, 104], [36, 44], [50, 38], [64, 52], [80, 66], [98, 84], [118, 104]], 6, A);
    // the bolt: two slanted strokes, each a convex quad
    c.quad([[96, 12], [110, 12], [96, 44], [82, 44]], W);
    c.quad([[84, 38], [104, 38], [84, 78], [82, 78]], W);
    out('i4ev_charge', c);
})();

// Precondition: a thermometer next to a battery, a warming arc
(() => {
    const c = new Canvas(140, 140);
    c.strokeRoundRect(26, 18, 26, 76, 13, 6, W);
    c.circle(39, 104, 19, W);
    c.circle(39, 104, 11, A);
    c.fillRect(35, 48, 8, 50, A);
    battery(c, 66, 64, 54, 34);
    c.arc(93, 52, 26, 32, -70, 70, A, { round: true });
    out('i4ev_precond', c);
})();

// Recuperation: an arrow going round and back into a battery
(() => {
    const c = new Canvas(140, 140);
    battery(c, 40, 74, 56, 36);
    c.roundRect(48, 82, 18, 20, 3, A);
    c.arc(70, 66, 40, 48, -110, 120, W, { round: true });
    // the arrow head at the arc's end (120°: lower right), pointing back towards the battery
    c.quad([[108, 96], [120, 74], [96, 80], [104, 86]], A);
    out('i4ev_regen', c);
})();

// Efficiency Coach: a gauge with its green band low and the needle in it
(() => {
    const c = new Canvas(140, 140);
    const rad = (d) => d * Math.PI / 180, pt = (r, a) => [70 + Math.sin(rad(a)) * r, 80 - Math.cos(rad(a)) * r];
    c.arc(70, 80, 46, 54, -135, 135, W, { round: true });
    c.arc(70, 80, 46, 54, -135, -45, A, { round: true });
    for (let a = -135; a <= 135; a += 45) { const p0 = pt(34, a), p1 = pt(40, a); c.line(p0[0], p0[1], p1[0], p1[1], 4, W); }
    const n = pt(40, -80);
    c.line(70, 80, n[0], n[1], 6, W);
    c.circle(70, 80, 9, W);
    c.fillRect(44, 116, 52, 6, W);
    out('i4ev_coach', c);
})();
