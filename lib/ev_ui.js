'use strict';
/**
 * ev_ui.js - what the four apps' screens share: page tabs and buttons, label/value rows, the Diagnostics page.
 *
 *   const pg = pager(ctx, () => ['live', 'curve', 'log'], NAMES, render);
 *   pg.page() -> 'live'      pg.header(cv, t, [badge])      pg.turn(2)
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { isNum, when, fmt } = require('./ev_core');

const GO = '#2fd27a';

/**
 * Pages turned with the bar buttons BTN_PAGE / BTN_PREV, or a tap on their tab. list() can change (a
 * Diagnostics page that is switched on); NAMES: id -> tab label.
 */
function pager(ctx, list, names, render) {
    let i = 0;
    const pages = () => list();
    const fix = () => { const n = pages().length; if (i >= n) i = 0; return n; };
    const turn = (n) => { const len = pages().length; i = ((n % len) + len) % len; return render(); };
    ctx.ui.onClick('BTN_PAGE', () => { fix(); return turn(i + 1); });
    ctx.ui.onClick('BTN_PREV', () => { fix(); return turn(i - 1); });
    ctx.onTab((k) => turn(k));
    return {
        page: () => { fix(); return pages()[i]; },
        index: () => { fix(); return i; },
        turn,
        header: (cv, t, badges) => { fix(); G.frame(cv, t, pages().map((p) => names[p] || p), i, badges || []); },
    };
}

/** Label left, value right, on one line. */
function row(cv, t, x, w, y, label, value, color) {
    cv.text(String(label).toUpperCase(), x, y, 20, t.dim, { font: 'bold', spacing: 1.2 });
    cv.text(value, x + w, y, 26, color || (value === '--' ? t.dim : t.text), { font: 'bold', align: 'right' });
}

/** A big number with its unit after it; returns the width drawn. */
function big(cv, t, x, y, text, unit, size, color, align) {
    const has = text !== '--' && text != null;
    const s = has ? String(text) : '--';
    const w = cv.textWidth(s, size, { font: 'num' }), uw = unit ? cv.textWidth(' ' + unit, Math.round(size * 0.32), { font: 'bold' }) : 0;
    const x0 = align === 'right' ? x - w - uw : align === 'center' ? x - (w + uw) / 2 : x;
    cv.text(s, x0, y, size, has ? color || t.text : t.dim, { font: 'num' });
    if (unit) cv.text(' ' + unit, x0 + w, y, Math.round(size * 0.32), t.dim, { font: 'bold' });
    return w + uw;
}

const num = (v, d, unit) => (isNum(v) ? fmt(v, d) + (unit ? ' ' + unit : '') : '--');
const signed = (v, d, unit) => (isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) + (unit ? ' ' + unit : '') : '--');

/** A text in the middle of a rect, dim (no data yet, explanations). Several lines: \n. */
function note(cv, t, x, y, w, h, text, color) {
    const lines = String(text).split('\n');
    lines.forEach((l, k) => cv.text(l, x + w / 2, y + h / 2 + (k - (lines.length - 1) / 2) * 32 + 8, 22, color || t.dim, { align: 'center' }));
}

/** Tag with a coloured dot, e.g. state: READY. */
function tag(cv, t, x, y, text, color, size) {
    const s = size || 24;
    cv.circle(x + s * 0.35, y - s * 0.34, s * 0.28, color);
    return cv.text(text, x + s * 0.9, y, s, color, { font: 'bold', spacing: 1.2 }) + s * 0.9;
}

/**
 * Diagnostics page: every UDS reply the app got (unit, identifier, bytes, value or why not) and the SOME/IP
 * values it saw, to check and adjust the identifiers on this car (app.json config.hv).
 */
function diagPage(cv, t, hv, live, extra, scrollY) {
    const r = G.panel(cv, t, 24, 44, 1552, 468, 'Diagnose: Batteriesteuergerät und Signale');
    const y0 = r.y + 70 - (scrollY || 0);
    cv.clip(r.x, r.y + 48, r.w, r.h - 52);
    const rows = (hv ? hv.raws() : []).map((x) => [x.label, x.ok ? fmt(x.value, 3) : '--', x.ok ? '' : x.why || '', (x.bytes || '').slice(0, 64), when(x.t)]);
    G.table(cv, t, r.x + 24, y0, r.w - 48, [
        { label: 'Gerät DID', w: 190 }, { label: 'Wert', w: 170, align: 'right' }, { label: '', w: 260 },
        { label: 'Antwort', w: 760, size: 18 }, { label: 'Um', w: 120, align: 'right' }],
    rows, { rowH: 34, size: 20, empty: hv && hv.available ? 'Noch keine Antworten' : 'Keine Diagnoseverbindung (Vorschau, oder die Headunit startet noch)' });
    let y = y0 + 40 + Math.max(1, rows.length) * 34 + 30;
    const lines = [];
    if (hv) lines.push(['Stromrichtung', (hv.powerSign() > 0 ? '+1' : '-1') + (hv.sign ? ' (gelernt / eingestellt)' : ' (app.json)')], ['Abfragen', String(hv.reads)]);
    Object.keys((live && live.raw) || {}).forEach((k) => lines.push([k, live.raw[k]]));
    (extra || []).forEach((e) => lines.push(e));
    lines.forEach((l) => { cv.text(String(l[0]).toUpperCase(), r.x + 24, y, 18, t.dim, { font: 'bold' }); cv.text(String(l[1]).slice(0, 110), r.x + 300, y, 18, t.text); y += 30; });
    cv.noclip();
    return y + (scrollY || 0) - y0;
}

/**
 * G.chart with its y unit above the axis labels (G.chart puts it where the top label is) and room for it:
 * the same arguments; returns what G.chart returns ({ X, Y, px, py, pw, ph }).
 */
function chart(cv, t, x, y, w, h, g) {
    const unit = g.yUnit, padTop = g.padTop == null ? 30 : g.padTop;
    // the axes' numbers with a decimal comma
    const dec = (v) => fmt(v, Math.abs(v % 1) > 1e-9 ? 1 : 0);
    const r = G.chart(cv, t, x, y, w, h, Object.assign({ xFmt: dec, yFmt: dec }, g, { yUnit: null, padTop }));
    if (unit) cv.text(unit, x + 4, y + 12, 15, t.dim, { font: 'bold' });
    return r;
}

/**
 * Vertical bars, one per item, in x, y, w, h: items [{ label, value, text, sub, color }] (value null: an empty
 * slot), the value's text over each bar, label and sub under it. o.max: the scale's top (else the largest), o.mark:
 * a value drawn as a line across (e.g. the average) with o.markLabel.
 */
function bars(cv, t, x, y, w, h, items, o) {
    o = o || {};
    const vals = items.map((i) => i.value).filter(isNum), max = o.max || (vals.length ? Math.max.apply(null, vals.concat(isNum(o.mark) ? [o.mark] : [])) * 1.15 : 1);
    const n = items.length, slot = w / n, bw = Math.min(110, slot * 0.62), base = y + h - 56, top = y + 34;
    const Y = (v) => base - (base - top) * Math.max(0, Math.min(1, v / max));
    cv.fillRect(x, base, w, 1.5, U_tick(t));
    items.forEach((it, i) => {
        const cx = x + slot * (i + 0.5);
        if (isNum(it.value)) {
            const c = it.color ? t[it.color] || it.color : t.accent;
            cv.roundRect(cx - bw / 2, Y(it.value), bw, base - Y(it.value), 4, withAlpha(c, 0.85));
            cv.text(it.text != null ? it.text : fmt(it.value, 1), cx, Y(it.value) - 10, 24, t.text, { align: 'center', font: 'bold' });
        } else cv.text('--', cx, base - 10, 22, t.dim, { align: 'center' });
        cv.text(it.label, cx, base + 28, 19, t.text, { align: 'center' });
        if (it.sub) cv.text(it.sub, cx, base + 50, 16, t.dim, { align: 'center' });
    });
    if (isNum(o.mark)) {
        cv.fillRect(x, Math.round(Y(o.mark)), w, 2, withAlpha('#ffffff', 0.55));
        if (o.markLabel) cv.text(o.markLabel + ' ' + fmt(o.mark, 1), x + w + 10, Y(o.mark) + 6, 18, t.dim);
    }
}
const U_tick = (t) => withAlpha(t.tick || '#ffffff', 0.6);

/** Badges in the header: DEMO, and the app's own (e.g. CHARGING). */
const demoBadge = (on) => on && { text: 'DEMO', color: 'warn' };

module.exports = { GO, pager, row, big, num, signed, fmt, note, tag, chart, bars, diagPage, demoBadge, withAlpha };
