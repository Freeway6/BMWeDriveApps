'use strict';
/**
 * Precondition - is the battery warm enough for fast charging, and what does it cost if not?
 *
 *   - the coldest cell's temperature decides how much power DC charging gets (lib/ev_model.js): the state
 *     (cold, cool, nearly, ready, warm, hot), how fast the cells warm (a line through the last 10 minutes of
 *     readings) and when they reach "warm enough" (setting) at that rate.
 *   - what to expect now and when warm: the DC power at the charge level now, the time to the charge level set,
 *     and what arriving in 10, 20 or 30 minutes would give at the present warming rate.
 *   - learned: the most each charge level x temperature band really took, from the Charge Curve app's charges
 *     (/tmp/i4ev-charge-grid.json) when it is installed; else a typical curve for the i4's battery.
 *   - history: the cells and the outside temperature over the last 6 hours. Read by itself every minute while
 *     the head unit is on and the car is not locked and left (app.json autostart); every 10 s while shown.
 *
 * Read only: the app does not switch preconditioning on. The car does that with route guidance to a DC charger
 * in BMW Maps (where its software has it).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Hv } = require('./ev_hv');
const { watchCar } = require('./ev_signals');
const C = require('./ev_core');
const M = require('./ev_model');
const U = require('./ev_ui');

const { isNum } = C;
const W = 1600, H = 520;
const GRID = '/tmp/i4ev-charge-grid.json';
const BG_MS = 60000, SHOWN_MS = 10000;
const KEEP_H = 6;
const NAMES = { now: 'Now', plan: 'Plan', hist: 'History', diag: 'Diagnostics' };

/** °C per minute: the slope of a line through [t ms, T] points (null with too few, or under 3 minutes). */
function slope(pts) {
    if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < 180000) return null;
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, den = 0;
    pts.forEach((p) => { num += (p[0] - mx) * (p[1] - my); den += (p[0] - mx) * (p[0] - mx); });
    return den > 0 ? num / den * 60000 : null;
}

/** The state of the coldest cell for fast charging: [label, theme colour key, advice]. */
function stateOf(T, warmAt) {
    if (!isNum(T)) return ['NO READING', 'dim', ''];
    if (T < 10) return ['COLD', 'crit', 'DC charging will be slow'];
    if (T < warmAt - 5) return ['COOL', 'warn', 'DC charging will be reduced'];
    if (T < warmAt) return ['NEARLY WARM', 'accent', 'almost full DC power'];
    if (T <= 38) return ['READY', 'go', 'full DC power'];
    if (T <= 45) return ['WARM', 'warn', 'full power, the cooling works hard'];
    return ['HOT', 'crit', 'DC power reduced until it cools'];
}

function engine(env) {
    const { log, settings, spec } = env;
    const store = new C.Store(env.dataDir, 'precond.json', { hist: [], pick: {} }, log);
    const st = store.data;
    const hv = new Hv(env.signals, log, spec.config && spec.config.hv);
    hv.usePick(st.pick);
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'eff'], { battOffset: () => settings.get('battOffset') });
    const now = { temp: null, tempT: 0, soc: null, socT: 0, kw: null, kwT: 0, src: null };
    const recent = [];            // [t, coldest cell] of the last 10 minutes
    let visible = false, stopped = false, wake = null, grid = null, gridT = 0;

    /** The cells: the battery unit's (lowest, highest, average), else the car's own battery temperature signal. */
    const cells = () => {
        if (now.temp && Date.now() - now.tempT < 5 * 60000) return now.temp;
        if (live.batt && Date.now() - live.battT < 5 * 60000) return { min: isNum(live.batt.min) ? live.batt.min : live.batt.avg, max: live.batt.max, avg: live.batt.avg, car: true };
        return null;
    };
    function keep(t) {
        const c = cells();
        if (!c) return;
        recent.push([t, c.min]);
        while (recent.length && t - recent[0][0] > 10 * 60000) recent.shift();
        const last = st.hist[st.hist.length - 1];
        if (!last || t - last[0] >= 55000) {
            st.hist.push([t, round(c.min), round(c.max), round(live.ambient), round(now.soc)]);
            while (st.hist.length && t - st.hist[0][0] > KEEP_H * 3600000) st.hist.shift();
            st.pick = hv.pick;
            store.save(false, 300000);
        }
    }
    const round = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);

    async function read() {
        const t = Date.now();
        const g = await hv.group('temp');
        if (g && (isNum(g.min) || isNum(g.avg))) { now.temp = { min: isNum(g.min) ? g.min : g.avg, max: g.max, avg: isNum(g.avg) ? g.avg : (isNum(g.min) && isNum(g.max) ? (g.min + g.max) / 2 : null) }; now.tempT = t; }
        if (t - now.socT > (visible ? 30000 : 300000)) { const s = await hv.value('soc'); if (s !== null) { now.soc = s; now.socT = t; } }
        if (visible) { const p = await hv.power(true, 10000); if (p) { now.kw = p.kw; now.kwT = t; } }
        keep(t);
    }
    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await hv.init();
        while (!stopped) {
            try {
                if (Date.now() - gridT > 60000) { const j = C.readJson(GRID, null); grid = j && j.grid ? j.grid : null; gridT = Date.now(); }
                if (demoOn()) demoTick();
                else if (hv.available && !live.left()) await read();
                else if (live.batt) keep(Date.now());           // the car's own signal costs nothing
            } catch (e) { log.warn('read: ' + (e && e.message || e)); }
            await sleep(visible || demoOn() ? SHOWN_MS : BG_MS);
        }
    }

    /* ---------- demo: on the way to a charger, the cells warming from 9 °C ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !hv.available && !now.tempT && !live.batt);
    function demoTick() {
        const t = Date.now();
        if (!demo) {
            demo = { t0: t - 25 * 60000, hist: [], recent: [] };
            for (let m = -150; m <= 0; m++) {
                const tt = t + m * 60000, warm = Math.max(0, m + 25);
                const T = m < -25 ? 7 + Math.sin(m / 40) * 0.6 : 7 + warm * 0.42;
                demo.hist.push([tt, round(T), round(T + 2.4), round(3 + Math.sin(m / 70)), round(m < -60 ? 41 : 41 - (m + 60) * 0.3)]);
                if (m > -10) demo.recent.push([tt, T]);
            }
        }
        const m = (t - demo.t0) / 60000, T = 7 + m * 0.42;
        demo.now = { temp: { min: T, max: T + 2.4, avg: T + 1.2 }, soc: Math.max(5, 23.5 - m * 0.05), kw: 24, ambient: 3, speed: 112 };
        demo.recent.push([t, T]);
        while (demo.recent.length && t - demo.recent[0][0] > 10 * 60000) demo.recent.shift();
        if (t - demo.hist[demo.hist.length - 1][0] >= 55000) demo.hist.push([t, round(T), round(T + 2.4), 3, round(demo.now.soc)]);
    }

    loop();
    return {
        ok: true, hv, live,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        readNow() { if (wake) wake(); },
        view() {
            if (demoOn()) {
                if (!demo) demoTick();
                return { demo: true, cells: demo.now.temp, soc: demo.now.soc, kw: demo.now.kw, ambient: demo.now.ambient, speed: demo.now.speed,
                    rate: slope(demo.recent), hist: demo.hist, grid: null, link: true };
            }
            const c = cells();
            return { demo: false, cells: c, soc: now.soc, kw: Date.now() - now.kwT < 30000 ? now.kw : null, ambient: live.ambient, speed: live.speed,
                rate: slope(recent), hist: st.hist, grid, link: hv.available, left: live.left() };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const pages = () => ['now', 'plan', 'hist'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    const tU = () => (settings.get('tempUnit') === 'f' ? '°F' : '°C');
    const T = (c) => C.temp(c, settings.get('tempUnit'));
    const fmtT = (c, d) => (isNum(c) ? G.fmt(T(c), d || 0) + ' ' + tU() : '--');
    const rateT = (r) => (isNum(r) ? (r > 0 ? '+' : '') + G.fmt(settings.get('tempUnit') === 'f' ? r * 1.8 : r, 2) + ' ' + tU() + '/min' : '--');
    const opts = (v) => ({ battery: settings.get('battery'), grid: v.grid, charger: Number(settings.get('charger')) });
    ui.onClick('BTN_ACT', () => { eng.readNow(); return render(); });
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    const col = (t, k) => (k === 'go' ? U.GO : t[k] || t.text);

    /** The cells on a scale from -10 to 50 °C, coloured by what DC charging gets there. */
    function scale(cv, t, x, y, w, c, warmAt) {
        const lo = -10, hi = 50, X = (v) => x + G.clamp((v - lo) / (hi - lo), 0, 1) * w;
        const zones = [[lo, 10, t.crit], [10, warmAt - 5, t.warn], [warmAt - 5, warmAt, t.accent], [warmAt, 38, U.GO], [38, 45, t.warn], [45, hi, t.crit]];
        zones.forEach((z) => cv.fillRect(X(z[0]), y, Math.max(0, X(z[1]) - X(z[0]) - 2), 16, U.withAlpha(z[2], 0.55)));
        if (c && isNum(c.min)) {
            const a = X(c.min), b = X(isNum(c.max) ? c.max : c.min);
            cv.roundRect(a - 3, y - 10, Math.max(6, b - a + 6), 36, 4, U.withAlpha('#ffffff', 0.18));
            cv.fillRect(a - 2, y - 14, 4, 44, '#ffffff');
        }
        [-10, 0, 10, 20, 30, 40, 50].forEach((v) => cv.text(fmtT(v), X(v), y + 46, 18, t.dim, { align: 'center' }));
    }

    function drawNow(cv, t, v) {
        const warmAt = settings.get('warmAt'), c = v.cells, Tm = c ? c.min : null;
        const s = stateOf(Tm, warmAt);
        const r = G.panel(cv, t, 24, 44, 760, 468, 'Battery cells');
        U.tag(cv, t, r.x + 24, r.y + 92, s[0], col(t, s[1]), 26);
        if (s[2]) cv.text(s[2], r.x + r.w - 24, r.y + 92, 22, t.dim, { align: 'right' });
        U.big(cv, t, r.x + 24, r.y + 226, isNum(Tm) ? G.fmt(T(Tm), 1) : '--', tU(), 120, col(t, s[1]));
        cv.text('COLDEST CELL' + (c && c.car ? '  (the car\'s own value)' : ''), r.x + 28, r.y + 258, 18, t.dim, { font: 'bold', spacing: 1.5 });
        scale(cv, t, r.x + 24, r.y + 296, r.w - 48, c, warmAt);
        const rate = v.rate, toWarm = isNum(Tm) && isNum(rate) && rate > 0.05 && Tm < warmAt ? (warmAt - Tm) / rate : null;
        const rows = [
            ['Highest cell', c ? fmtT(c.max, 1) : '--'],
            ['Warming', isNum(rate) ? (rate > 0.05 ? rateT(rate) + (isNum(toWarm) ? '   ' + fmtT(warmAt) + ' in ' + C.dur(toWarm * 60000) : '') : rate < -0.05 ? 'cooling ' + rateT(rate) : 'not warming') : 'measuring (3 min)'],
            ['Outside', fmtT(v.ambient)],
        ];
        rows.forEach((x, i) => U.row(cv, t, r.x + 24, r.w - 48, r.y + 384 + i * 36, x[0], x[1]));

        // what DC charging gives now, and when warm
        const rr = G.panel(cv, t, 808, 44, 768, 468, 'DC charging from ' + (isNum(v.soc) ? G.fmt(v.soc, 0) + ' %' : '--'));
        const target = Number(settings.get('target')), o = opts(v), warmT = Math.max(warmAt, 30);
        const kwNow = isNum(v.soc) && isNum(Tm) ? M.expectKw(v.soc, Tm, o) : null, kwWarm = isNum(v.soc) ? M.expectKw(v.soc, warmT, o) : null;
        const mNow = isNum(Tm) ? M.chargeMinutes(v.soc, target, Tm, o) : null, mWarm = M.chargeMinutes(v.soc, target, warmT, o);
        cv.text('NOW', rr.x + 24, rr.y + 92, 20, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text('WARM', rr.x + 404, rr.y + 92, 20, t.dim, { font: 'bold', spacing: 1.5 });
        U.big(cv, t, rr.x + 24, rr.y + 190, isNum(kwNow) ? G.fmt(kwNow, 0) : '--', 'kW', 96, col(t, s[1]));
        U.big(cv, t, rr.x + 404, rr.y + 190, isNum(kwWarm) ? G.fmt(kwWarm, 0) : '--', 'kW', 96, U.GO);
        const lost = mNow && mWarm ? mNow.min - mWarm.min : null;
        const rows2 = [
            ['To ' + target + ' % now', mNow ? C.dur(mNow.min * 60000) : '--'],
            ['To ' + target + ' % warm', mWarm ? C.dur(mWarm.min * 60000) : '--'],
            ['Cold costs', isNum(lost) ? (lost >= 1 ? C.dur(lost * 60000) : 'nothing') : '--'],
        ];
        rows2.forEach((x, i) => U.row(cv, t, rr.x + 24, rr.w - 48, rr.y + 250 + i * 40, x[0], x[1], i === 2 && lost >= 5 ? t.warn : null));
        // what to do
        const charging = isNum(v.kw) && v.kw < -1.2 && (!isNum(v.speed) || v.speed < 1);
        const tip = charging ? 'Charging now: ' + G.fmt(-v.kw, 0) + ' kW into the battery'
            : !isNum(Tm) ? (v.link ? 'Waiting for the battery unit' : 'No diagnostic link yet')
                : Tm >= warmAt ? 'Ready for full power'
                    : isNum(rate) && rate > 0.05 ? 'The battery is warming: keep the route guidance to the charger'
                        : 'Start route guidance to a DC charger in BMW Maps:\nthe car warms the battery on the way';
        tip.split('\n').forEach((l, k) => cv.text(l, rr.x + 24, rr.y + 398 + k * 30, 22, charging || Tm >= warmAt ? U.GO : t.text));
        cv.text(v.grid ? 'learned from your charges where known' : 'typical i4 curve (Charge Curve learns this car\'s)', rr.x + 24, rr.y + rr.h - 20, 16, t.dim);
    }

    function drawPlan(cv, t, v) {
        const warmAt = settings.get('warmAt'), c = v.cells, Tm = c ? c.min : null, o = opts(v), target = Number(settings.get('target'));
        const r = G.panel(cv, t, 24, 44, 900, 468, 'Expected DC power over charge level');
        const curve = (temp) => { const pts = []; for (let q = 0; q <= 100; q += 2) pts.push([q, M.expectKw(q, temp, o)]); return pts; };
        const warmT = Math.max(warmAt, 30), now = isNum(Tm) ? curve(Tm) : [], warm = curve(warmT);
        const ch = U.chart(cv, t, r.x + 16, r.y + 60, r.w - 32, r.h - 76, {
            xMin: 0, xMax: 100, xStep: 10, yMin: 0, yMax: Math.max(100, Math.ceil(Math.max.apply(null, warm.map((p) => p[1])) / 50) * 50 + 10), xUnit: '%', yUnit: 'kW',
            series: [{ pts: warm, color: U.GO, width: 2.5, dash: true }, { pts: now, color: t.cold || '#5aa9ff', width: 3.5, fill: 0.12 }],
        });
        if (isNum(v.soc)) { const x = ch.X(v.soc); cv.fillRect(x - 1, ch.py, 2, ch.ph, U.withAlpha('#ffffff', 0.5)); cv.text('now ' + G.fmt(v.soc, 0) + ' %', x + 6, ch.py + 18, 18, t.text); }
        cv.fillRect(r.x + 500, r.y + 32, 26, 4, t.cold || '#5aa9ff'); cv.text('cells at ' + fmtT(Tm), r.x + 534, r.y + 40, 18, t.dim);
        cv.fillRect(r.x + 700, r.y + 33, 26, 2, U.GO); cv.text('warm (' + fmtT(warmT) + ')', r.x + 734, r.y + 40, 18, t.dim);

        // arriving in 10 / 20 / 30 minutes at the warming rate now (the charge falling about 0.4 % a minute when driving)
        const rr = G.panel(cv, t, 948, 44, 628, 468, 'Arriving in ...');
        const rate = isNum(v.rate) ? v.rate : 0, driving = isNum(v.speed) && v.speed > 5;
        const rows = [0, 10, 20, 30].map((m) => {
            const Ta = isNum(Tm) ? Math.min(Math.max(Tm, 35), Tm + rate * m) : null;
            const soc = isNum(v.soc) ? Math.max(3, v.soc - (driving ? 0.4 * m : 0)) : null;
            const kw = isNum(Ta) && isNum(soc) ? M.expectKw(soc, Ta, o) : null, mm = isNum(Ta) && isNum(soc) ? M.chargeMinutes(soc, target, Ta, o) : null;
            return [m ? m + ' min' : 'now', fmtT(Ta), isNum(soc) ? G.fmt(soc, 0) + ' %' : '--', isNum(kw) ? G.fmt(kw, 0) + ' kW' : '--', mm ? C.dur(mm.min * 60000) : '--'];
        });
        G.table(cv, t, rr.x + 24, rr.y + 70, rr.w - 48, [{ label: 'Arrive', w: 110 }, { label: 'Cells', w: 110, align: 'right' }, { label: 'Charge', w: 100, align: 'right' },
            { label: 'Power', w: 120, align: 'right' }, { label: 'To ' + target + ' %', w: 140, align: 'right' }], rows, { rowH: 52, size: 26 });
        cv.text(rate > 0.05 ? 'at ' + rateT(rate) + ', as the cells warm now' : 'the cells are not warming now', rr.x + 24, rr.y + 360, 20, t.dim);
        cv.text('Charging warms them as well (included).', rr.x + 24, rr.y + 392, 20, t.dim);
    }

    function drawHist(cv, t, v) {
        const r = G.panel(cv, t, 24, 44, 1552, 468, 'Cells and outside, last ' + KEEP_H + ' hours');
        const h = v.hist || [], t1 = Date.now(), t0 = t1 - KEEP_H * 3600000;
        const X = (tt) => (tt - t1) / 3600000;
        const minS = h.filter((p) => isNum(p[1])).map((p) => [X(p[0]), T(p[1])]), maxS = h.filter((p) => isNum(p[2])).map((p) => [X(p[0]), T(p[2])]);
        const amb = h.filter((p) => isNum(p[3])).map((p) => [X(p[0]), T(p[3])]);
        const all = minS.concat(maxS, amb).map((p) => p[1]);
        const lo = all.length ? Math.floor(Math.min.apply(null, all) / 5) * 5 - 5 : 0;
        const hi = Math.max(all.length ? Math.ceil(Math.max.apply(null, all) / 5) * 5 + 5 : 40, Math.ceil(T(settings.get('warmAt')) / 5) * 5 + 5);
        U.chart(cv, t, r.x + 16, r.y + 60, r.w - 32, r.h - 76, {
            xMin: X(t0), xMax: 0, xStep: 1, xFmt: (x) => (x === 0 ? 'now' : G.fmt(x, 0) + ' h'), yMin: lo, yMax: hi, yStep: 5, yUnit: tU(),
            series: [{ pts: amb, color: t.dim, width: 2, dash: true }, { pts: maxS, color: t.warn, width: 2 }, { pts: minS, color: t.cold || '#5aa9ff', width: 3 }],
            marks: [{ y: T(settings.get('warmAt')), color: U.GO, label: 'warm enough' }],
            empty: 'No readings yet: read every minute while the head unit is on',
        });
        [['coldest cell', t.cold || '#5aa9ff'], ['highest cell', t.warn], ['outside', t.dim]].forEach((l, i) => { cv.fillRect(r.x + 560 + i * 220, r.y + 33, 26, 4, l[1]); cv.text(l[0], r.x + 594 + i * 220, r.y + 40, 18, t.dim); });
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'now') drawNow(cv, t, v);
        else if (p === 'plan') drawPlan(cv, t, v);
        else if (p === 'hist') drawHist(cv, t, v);
        else U.diagPage(cv, t, eng.hv, eng.live, [['learned grid', v.grid ? Object.keys(v.grid).length + ' cells' : 'none (Charge Curve not installed or nothing learned)'],
            ['car battery temp', JSON.stringify(eng.live.batt)], ['vehicle state', String(eng.live.cond)]]);
        const st = stateOf(v.cells ? v.cells.min : null, settings.get('warmAt'));
        pg.header(cv, t, [U.demoBadge(v.demo), v.cells && { text: st[0], color: col(t, st[1]) }]);
        return ui.image('MAIN_GFX', cv);
    }
    ctx.loop('MAIN', 2, render);
    return render();
}

mgu.run({
    background(bg) { return engine(bg); },
    async start(ctx) {
        const eng = ctx.background && ctx.background.ok ? ctx.background : engine(ctx);
        startUi(ctx, eng).catch((e) => ctx.log.warn('first frame: ' + e));
    },
});
