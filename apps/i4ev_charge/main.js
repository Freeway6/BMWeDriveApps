'use strict';
/**
 * Charge Curve - every charge as the battery saw it.
 *
 *   - recorded by itself (app.json autostart, without its screens): standing still, the battery's current is read
 *     every 20 s; when more than 1.2 kW go in, a charge has started and is read every few seconds (setting) until
 *     less than 0.4 kW go in for 90 s, or the car drives off. Only while the head unit is on: a charge it sleeps
 *     through is closed at the next start with the charge level then (marked partial).
 *   - per charge: the curve (power over charge level, cell temperature), energy into the battery, peak and mean
 *     power, the time each 10 % took (10 -> 80 %), cost from the price set (with charging losses, estimated).
 *   - comparison: each charge against a reference, the one pinned or else the DC charge that was fastest over the
 *     same charge range.
 *   - learning: the most each charge level x cell temperature band has taken on DC (st.grid), also written to
 *     /tmp/i4ev-charge-grid.json for the Precondition app.
 *   - the car locked and left: no reads (they would keep it awake), except for 10 minutes after it was left (a plug
 *     put in after walking away) and while a charge is going on.
 *
 * Values come from the battery unit over UDS (lib/ev_hv.js); speed and vehicle state over SOME/IP.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Hv } = require('./ev_hv');
const { watchCar } = require('./ev_signals');
const C = require('./ev_core');
const { ChargeTracker, between, span, reference } = require('./ev_charge');
const { DemoCharge, demoSessions } = require('./ev_demo');
const M = require('./ev_model');
const U = require('./ev_ui');

const { isNum } = C;
const W = 1600, H = 520;
const SHARED = '/tmp/i4ev-charge-grid.json';
const IDLE_MS = 20000;
const LEFT_GRACE = 10 * 60000;
const LOSS = { DC: 1.05, AC: 1.1 };      // energy from the charger per kWh into the battery (estimate)
const NAMES = { live: 'Now', curve: 'Curve', log: 'Charges', diag: 'Diagnostics' };

/* ---------------- the recorder: runs from the start, with or without the screens ---------------- */
function engine(env) {
    const { log, settings, spec } = env;
    const store = new C.Store(env.dataDir, 'charges.json', { sessions: [], open: null, grid: {}, pick: {}, sign: null, pinned: null }, log);
    const st = store.data;
    const hv = new Hv(env.signals, log, spec.config && spec.config.hv);
    hv.usePick(st.pick);
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'eff', 'lsc']);
    const now = { kwIn: null, v: null, a: null, soc: null, temp: null, energy: null, t: 0 };
    let visible = false, stopped = false, leftSince = 0, lastIdle = 0, lastSoc = 0, lastTemp = 0, lastEnergy = 0, resumed = false, gridDirty = false;
    let wake = null;

    const share = () => {
        try { C.writeJson(SHARED, { t: Date.now(), battery: settings.get('battery'), grid: st.grid }, 0o644); gridDirty = false; } catch (e) { log.warn('shared grid: ' + e); }
    };
    const tracker = new ChargeTracker(st, {
        onStart: (o) => { log.info('charge started at ' + G.fmt(o.soc0, 1) + ' %'); store.save(true); },
        onClose: (s) => {
            log.info('charge ' + s.kind + ' ' + G.fmt(s.soc0, 1) + ' -> ' + G.fmt(s.soc1, 1) + ' %, ' + G.fmt(s.kwh, 1) + ' kWh, peak ' + G.fmt(s.peak, 0) + ' kW (' + s.reason + ')');
            if (s.kind === 'AC' && !settings.get('logAc')) st.sessions.pop();
            st.pick = hv.pick;
            store.save(true);
            share();
        },
    });
    const applySign = () => hv.applySign(settings.get('signMode'), st.sign);
    applySign();
    settings.onChange((k) => { if (k === 'signMode') applySign(); });
    share();

    const cellT = () => {
        if (now.temp && (isNum(now.temp.min) || isNum(now.temp.avg))) return isNum(now.temp.min) ? now.temp.min : now.temp.avg;
        if (live.batt) return isNum(live.batt.min) ? live.batt.min : live.batt.avg;
        return null;
    };

    async function read(open) {
        const p = await hv.power(true, open ? 6000 : 0), t = Date.now();
        if (p) {
            const s = hv.learnSign(p, live.speed);
            if (s) { st.sign = s; store.save(true); }
            now.kwIn = -p.kw; now.v = p.v; now.a = p.a; now.t = t;
        }
        if (!open || t - lastSoc > 10000) { const s = await hv.value('soc'); if (s !== null) { now.soc = s; lastSoc = t; } }
        if (t - lastTemp > (open ? 20000 : 60000)) { const g = await hv.group('temp'); if (g) { now.temp = g; lastTemp = t; } }
        if (!now.energy || t - lastEnergy > (open ? 60000 : 300000)) { const e = await hv.group('energy'); if (e) { now.energy = e; lastEnergy = t; } }
        if (!resumed && now.soc !== null) {
            resumed = true;
            if (tracker.resume(t, now.soc)) log.info('a charge the head unit slept through: closed at ' + G.fmt(now.soc, 1) + ' %');
        }
        if (!p) return;
        const T = cellT();
        const ev = tracker.sample({ t, kwIn: now.kwIn, soc: now.soc, cellT: T, cellTmax: now.temp && now.temp.max, speed: live.speed,
            stored: now.energy && now.energy.stored });
        const o = tracker.open;
        if (ev === 'start' && o) {
            const odo = await hv.value('odo'), dc = await hv.value('dcPlug');
            if (odo !== null) o.odo = odo;
            if (dc === 1) o.dc = true;
        }
        if (o && now.kwIn > 15 && isNum(now.soc) && isNum(T) && M.learn(st.grid, now.soc, T, now.kwIn)) gridDirty = true;
        if (o) store.save(false, 30000);
        if (gridDirty && (!o || Math.random() < 0.05)) share();
    }

    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await hv.init();
        while (!stopped) {
            let wait = 3000;
            try {
                const t = Date.now();
                if (live.left()) { if (!leftSince) leftSince = t; } else leftSince = 0;
                const open = !!tracker.open, moving = isNum(live.speed) && live.speed > 3;
                if (hv.available && !demoOn()) {
                    if (open) { await read(true); wait = (settings.get('sample') || 2) * 1000; }
                    else if (!moving && (!leftSince || t - leftSince < LEFT_GRACE) && (visible || t - lastIdle >= IDLE_MS)) {
                        await read(false); lastIdle = t; wait = visible ? 3000 : IDLE_MS;
                    }
                }
                if (demoOn()) demoTick();
            } catch (e) { log.warn('read: ' + (e && e.message || e)); }
            await sleep(Math.max(500, wait));
        }
    }

    /* ---------- demo: a DC charge going on for 14 minutes, and the charges before it ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !hv.available && !now.t);
    function demoTick() {
        if (!demo) {
            const st0 = { sessions: demoSessions(9), open: null, grid: {}, pinned: null };
            st0.sessions.filter((s) => s.kind === 'DC').forEach((s) => s.points.forEach((p) => M.learn(st0.grid, p[1], p[3], p[2])));
            demo = { st: st0, tr: new ChargeTracker(st0), c: new DemoCharge({ soc0: 11, cellT: 16, charger: 200 }), t0: Date.now() - 14 * 60000 };
            for (let s = 0; s <= 14 * 60; s += 10) { const p = demo.c.at(s / 60); demo.tr.sample({ t: demo.t0 + s * 1000, kwIn: p.kw, soc: p.soc, cellT: p.cellT, cellTmax: p.cellT + 2, speed: 0, stored: p.soc * 0.807 }); }
        }
        const p = demo.c.at((Date.now() - demo.t0) / 60000);
        demo.now = { kwIn: p.kw, soc: p.soc, temp: { min: p.cellT, max: p.cellT + 2, avg: p.cellT + 1 }, energy: { stored: p.soc * 0.807, cap: 80.7 }, t: Date.now() };
        demo.tr.sample({ t: Date.now(), kwIn: p.kw, soc: p.soc, cellT: p.cellT, cellTmax: p.cellT + 2, speed: 0, stored: p.soc * 0.807 });
    }

    loop();
    return {
        ok: true, hv, live, st, store, settings,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        /** What the screens show: the real recorder's, or the demo's. */
        view() {
            if (demoOn()) { if (!demo) demoTick(); return { demo: true, st: demo.st, open: demo.st.open, now: demo.now, link: true }; }
            return { demo: false, st, open: st.open, now, link: hv.available, cellT: cellT(), left: !!leftSince };
        },
        pin(id) { const s = demoOn() && demo ? demo.st : st; s.pinned = s.pinned === id ? null : id; store.save(true); },
        stop() { stopped = true; if (wake) wake(); },
    };
}

/* ---------------- the screens ---------------- */
function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    let sel = 0;              // the charge shown on Curve and marked on Charges: 0 = the newest
    let scroll = 0;
    const pages = () => ['live', 'curve', 'log'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => { labels(); return render(); });
    const sessions = (v) => v.st.sessions.slice().reverse();          // newest first
    const tU = () => (settings.get('tempUnit') === 'f' ? '°F' : '°C');
    const T = (c) => C.temp(c, settings.get('tempUnit'));
    const fmtT = (c) => (isNum(c) ? G.fmt(T(c), 0) + ' ' + tU() : '--');
    const price = (s) => (s.kind === 'DC' ? settings.get('priceDc') : settings.get('priceAc'));
    const cost = (s) => (isNum(s.kwh) && price(s) > 0 ? s.kwh * LOSS[s.kind] * price(s) : null);

    let actText = '', pinText = '';
    function labels() {
        const p = pg.page(), v = eng.view(), list = sessions(v), s = list[sel];
        const a = p === 'live' ? 'Show last charge' : 'Next charge';
        const b = s && v.st.pinned === s.id ? 'Unpin reference' : 'Pin as reference';
        if (a !== actText) { actText = a; ui.text('BTN_ACT', a); }
        if (b !== pinText) { pinText = b; ui.text('BTN_PIN', b); }
    }
    ui.onClick('BTN_ACT', () => {
        const n = sessions(eng.view()).length;
        if (pg.page() === 'live') { sel = 0; return pg.turn(1); }
        if (n) sel = (sel + 1) % n;
        labels();
        return render();
    });
    ui.onClick('BTN_PIN', () => {
        const s = sessions(eng.view())[sel];
        if (s) eng.pin(s.id);
        labels();
        return render();
    });
    ctx.onScroll((dy) => {
        if (pg.page() !== 'log') return false;
        const n = sessions(eng.view()).length, before = sel;
        sel = G.clamp(sel + (dy > 0 ? 1 : -1), 0, Math.max(0, n - 1));
        return sel !== before;
    });
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);

    /** kW over charge level of a session: [[soc, kw], ...]. */
    const curvePts = (s) => (s && s.points ? s.points.filter((p) => isNum(p[1]) && isNum(p[2])).map((p) => [p[1], p[2]]) : []);
    const expected = (cellT, v, cap) => {
        const pts = [];
        for (let q = 0; q <= 100; q += 2) pts.push([q, M.expectKw(q, cellT, { battery: settings.get('battery'), grid: v.st.grid, charger: cap })]);
        return pts;
    };
    const yMax = (list) => Math.max(100, Math.ceil(Math.max.apply(null, [0].concat(list.map((p) => p[1]))) / 50) * 50 + 20);

    function legend(cv, t, x, y, items) {
        let xx = x;
        items.forEach((it) => {
            if (!it) return;
            cv.fillRect(xx, y - 8, 26, it.dash ? 2 : 4, it.color);
            xx += 34 + cv.text(it.text, xx + 34, y, 18, t.dim);
            xx += 28;
        });
    }

    function drawLive(cv, t, v) {
        const o = v.open, n = v.now || {}, list = sessions(v);
        const r = G.panel(cv, t, 24, 44, 640, 468, 'Now');
        const target = Number(settings.get('target'));
        const charging = !!o;
        const state = !v.link ? ['NO DIAGNOSTIC LINK YET', t.warn] : charging ? ['CHARGING  ' + (o.dc || o.peak > 11.5 ? 'DC' : 'AC'), U.GO] : ['NOT CHARGING', t.dim];
        U.tag(cv, t, r.x + 24, r.y + 92, state[0], state[1], 24);
        const cT = isNum(v.cellT) ? v.cellT : n.temp && n.temp.min;
        if (charging) {
            U.big(cv, t, r.x + 24, r.y + 236, isNum(n.kwIn) ? G.fmt(Math.max(0, n.kwIn), 0) : '--', 'kW', 150, t.text);
            const el = o.t1 - o.t0;
            const peak = o.peak || 0, socNow = isNum(n.soc) ? n.soc : o.soc1;
            // the time left: the expected curve scaled to how this charge goes now, no more than its peak so far (the station)
            let eta = null;
            if (isNum(socNow) && socNow < target) {
                const exp = M.expectKw(socNow, cT, { battery: settings.get('battery'), grid: v.st.grid });
                const f = isNum(n.kwIn) && exp > 1 ? G.clamp(n.kwIn / exp, 0.3, 1.3) : 1;
                const m = M.chargeMinutes(socNow, target, cT, { battery: settings.get('battery'), grid: v.st.grid, charger: peak > 5 ? peak : null });
                eta = m ? (m.min - M.RAMP_MIN) / f : null;
            }
            const rows = [
                ['Charge', G.fmt(socNow, 1) + ' %   from ' + G.fmt(o.soc0, 1) + ' %'],
                ['Added', G.fmt(o.kwh, 1) + ' kWh   ' + C.dur(el)],
                ['Cells', isNum(cT) ? fmtT(cT) + (n.temp && isNum(n.temp.max) ? ' - ' + fmtT(n.temp.max) : '') : '--'],
                ['To ' + target + ' %', socNow >= target ? 'reached' : isNum(eta) ? 'about ' + C.dur(eta * 60000) + '  (' + C.when(Date.now() + eta * 60000) + ')' : '--'],
                ['Peak', G.fmt(peak, 0) + ' kW at ' + G.fmt(o.peakSoc, 0) + ' %'],
            ];
            rows.forEach((x, i) => U.row(cv, t, r.x + 24, r.w - 48, r.y + 290 + i * 38, x[0], x[1]));
        } else {
            U.big(cv, t, r.x + 24, r.y + 236, isNum(n.soc) ? G.fmt(n.soc, 0) : '--', '%', 150, t.text);
            const last = list[0];
            const rows = [
                ['Energy in the battery', n.energy && isNum(n.energy.stored) ? G.fmt(n.energy.stored, 1) + ' of ' + G.fmt(n.energy.cap, 1) + ' kWh' : '--'],
                ['Cells', isNum(cT) ? fmtT(cT) + (n.temp && isNum(n.temp.max) ? ' - ' + fmtT(n.temp.max) : '') : '--'],
                ['Last charge', last ? C.when(last.t0) + '   ' + last.kind + ' ' + G.fmt(last.soc0, 0) + ' -> ' + G.fmt(last.soc1, 0) + ' %' : 'none yet'],
                ['', v.link ? 'Plug in: the charge is recorded by itself' : 'Waiting for the battery unit'],
            ];
            rows.forEach((x, i) => U.row(cv, t, r.x + 24, r.w - 48, r.y + 290 + i * 44, x[0], x[1], i === 3 ? t.dim : null));
        }
        // the curve: this charge (or the last), its reference, and what the model expects at the cells' temperature now
        const s = o ? Object.assign({}, o, { points: o.points }) : list[0];
        const ref = reference(v.st.sessions, s, v.st.pinned);
        const rr = G.panel(cv, t, 688, 44, 888, 468, o ? 'This charge' : s ? 'Last charge  ' + C.when(s.t0) : 'Curve');
        const own = curvePts(s), refPts = curvePts(ref), exp = expected(isNum(cT) ? cT : 25, v, null);
        U.chart(cv, t, rr.x + 16, rr.y + 70, rr.w - 32, rr.h - 92, {
            xMin: 0, xMax: 100, xStep: 10, yMin: 0, yMax: yMax(own.concat(refPts, exp)), xUnit: '%', yUnit: 'kW',
            series: [{ pts: exp, color: t.dim, width: 1.5, dash: true }, { pts: refPts, color: t.cold || '#5aa9ff', width: 2.5 },
                { pts: own, color: U.GO, width: 3.5, fill: 0.14 }],
            empty: 'No charge recorded yet',
        });
        legend(cv, t, rr.x + 220, rr.y + 40, [{ text: o ? 'this charge' : 'last', color: U.GO }, ref && { text: 'reference ' + C.when(ref.t0), color: t.cold || '#5aa9ff' },
            { text: 'expected at ' + fmtT(isNum(cT) ? cT : 25), color: t.dim, dash: true }]);
    }

    function drawCurve(cv, t, v) {
        const list = sessions(v);
        if (sel >= list.length) sel = 0;
        const s = list[sel];
        const r = G.panel(cv, t, 24, 44, 560, 468, s ? (sel === 0 ? 'Newest charge' : 'Charge ' + (sel + 1) + ' of ' + list.length) : 'Curve');
        if (!s) { U.note(cv, t, r.x, r.y, r.w, r.h, 'No charge recorded yet.\nPlug in and leave the head unit on:\nthe charge is recorded by itself.'); return; }
        const ref = reference(v.st.sessions, s, v.st.pinned);
        const c = cost(s), sp = span(s), rsp = ref ? span(ref) : null;
        // the reference over the same span, when it has it
        const refMin = sp && ref ? between(ref, sp.a, sp.b) : null;
        const rows = [
            ['When', C.when(s.t0) + '   ' + C.dur(s.t1 - s.t0)],
            ['Type', s.kind + (s.partial ? '  (head unit slept, partly)' : '')],
            ['Charge', G.fmt(s.soc0, 1) + ' -> ' + G.fmt(s.soc1, 1) + ' %'],
            ['Energy', G.fmt(s.kwh, 1) + ' kWh' + (isNum(c) ? '   about ' + G.fmt(c, 2) + ' EUR' : '')],
            ['Peak / mean', G.fmt(s.peak, 0) + ' / ' + G.fmt(s.avg, 0) + ' kW'],
            [sp ? sp.a + ' -> ' + sp.b + ' %' : 'Time per span', sp && isNum(sp.min) ? G.fmt(sp.min, 0) + ' min' + (isNum(refMin) ? '   reference ' + G.fmt(refMin, 0) + ' min' : '') : '--'],
            ['Cells', fmtT(s.temp0) + ' -> ' + fmtT(s.temp1) + (isNum(s.tmax) ? '  (max ' + fmtT(s.tmax) + ')' : '')],
            ['Reference', ref ? C.when(ref.t0) + (v.st.pinned === ref.id ? ' (pinned)' : '') + (rsp && isNum(rsp.min) ? '   ' + rsp.a + '-' + rsp.b + ' %: ' + G.fmt(rsp.min, 0) + ' min' : '') : 'none'],
        ];
        rows.forEach((x, i) => U.row(cv, t, r.x + 24, r.w - 48, r.y + 92 + i * 46, x[0], x[1], x[0] === 'Reference' && ref ? t.cold : null));
        const rr = G.panel(cv, t, 608, 44, 968, 468, 'Power and cell temperature over charge level');
        const own = curvePts(s), refPts = curvePts(ref);
        const lo = Math.max(0, Math.floor(Math.min(s.soc0, ref ? ref.soc0 : 100) / 10) * 10), hi = Math.min(100, Math.ceil(Math.max(s.soc1, ref ? ref.soc1 : 0) / 10) * 10);
        const xMin = hi - lo >= 20 ? lo : 0, xMax = hi - lo >= 20 ? hi : 100;
        U.chart(cv, t, rr.x + 16, rr.y + 60, rr.w - 32, 258, {
            xMin, xMax, xStep: 10, yMin: 0, yMax: yMax(own.concat(refPts)), xUnit: '%', yUnit: 'kW',
            series: [{ pts: refPts, color: t.cold || '#5aa9ff', width: 2.5 }, { pts: own, color: U.GO, width: 3.5, fill: 0.14 }],
        });
        const temps = (x) => (x && x.points ? x.points.filter((p) => isNum(p[1]) && isNum(p[3])).map((p) => [p[1], T(p[3])]) : []);
        const tp = temps(s), tr = temps(ref), all = tp.concat(tr).map((p) => p[1]);
        const tl = all.length ? Math.floor(Math.min.apply(null, all) / 5) * 5 : 0, th = all.length ? Math.ceil(Math.max.apply(null, all) / 5) * 5 + 5 : 40;
        U.chart(cv, t, rr.x + 16, rr.y + 322, rr.w - 32, 136, {
            xMin, xMax, xStep: 10, yMin: tl, yMax: Math.max(th, tl + 10), yStep: 10, xUnit: '%', yUnit: tU(),
            series: [{ pts: tr, color: t.cold || '#5aa9ff', width: 2 }, { pts: tp, color: t.warn, width: 2.5 }],
        });
        legend(cv, t, rr.x + 520, rr.y + 40, [{ text: 'this charge', color: U.GO }, ref && { text: 'reference', color: t.cold || '#5aa9ff' }, { text: 'cells', color: t.warn }]);
    }

    function drawLog(cv, t, v) {
        const list = sessions(v);
        const total = list.reduce((a, s) => a + (s.kwh || 0), 0), money = list.reduce((a, s) => a + (cost(s) || 0), 0);
        const r = G.panel(cv, t, 24, 44, 1552, 468, list.length ? list.length + ' charges   ' + G.fmt(total, 0) + ' kWh   about ' + G.fmt(money, 0) + ' EUR' : 'Charges');
        if (!list.length) { U.note(cv, t, r.x, r.y, r.w, r.h, 'No charge recorded yet'); return; }
        const rows = Math.floor((r.h - 100) / 40);
        if (sel >= list.length) sel = 0;
        scroll = G.clamp(sel - Math.floor(rows / 2), 0, Math.max(0, list.length - rows));
        const y0 = r.y + 64;
        const shown = list.slice(scroll, scroll + rows);
        cv.roundRect(r.x + 12, y0 + 30 + (sel - scroll) * 40, r.w - 24, 40, 6, U.withAlpha(t.sel || t.accent, 0.22));
        G.table(cv, t, r.x + 24, y0, r.w - 48, [
            { label: 'When', w: 190 }, { label: 'Type', w: 80 }, { label: 'Charge', w: 170 }, { label: 'Energy', w: 150, align: 'right' },
            { label: 'Peak', w: 130, align: 'right' }, { label: 'Mean', w: 130, align: 'right' }, { label: 'Time per span', w: 220, align: 'right' },
            { label: 'Cells', w: 170, align: 'right' }, { label: 'Cost', w: 150, align: 'right' }],
        shown.map((s) => {
            const m = span(s), c = cost(s), pinned = v.st.pinned === s.id;
            return [(pinned ? '* ' : '') + C.when(s.t0), { text: s.kind, color: s.kind === 'DC' ? U.GO : null }, G.fmt(s.soc0, 0) + ' -> ' + G.fmt(s.soc1, 0) + ' %',
                G.fmt(s.kwh, 1) + ' kWh', G.fmt(s.peak, 0) + ' kW', G.fmt(s.avg, 0) + ' kW', m && isNum(m.min) ? m.a + '-' + m.b + ' %: ' + C.dur(m.min * 60000) : '--',
                fmtT(s.temp0) + ' -> ' + fmtT(s.temp1), isNum(c) ? G.fmt(c, 2) + ' EUR' : '--'];
        }), { rowH: 40, size: 22, stripe: true });
        cv.scroll = { y: y0 + 30 };
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'live') drawLive(cv, t, v);
        else if (p === 'curve') drawCurve(cv, t, v);
        else if (p === 'log') drawLog(cv, t, v);
        else U.diagPage(cv, t, eng.hv, eng.live, [['grid cells learned', String(Object.keys(v.st.grid || {}).length)], ['speed', G.fmt(eng.live.speed, 1) + ' km/h'], ['vehicle state', String(eng.live.cond)]]);
        pg.header(cv, t, [U.demoBadge(v.demo), v.open && { text: 'CHARGING', color: U.GO }]);
        return ui.image('MAIN_GFX', cv);
    }
    labels();
    ctx.loop('MAIN', 2, render);
    settings.onChange(() => { labels(); });
    return render();
}

mgu.run({
    background(bg) { return engine(bg); },
    async start(ctx) {
        const eng = ctx.background && ctx.background.ok ? ctx.background : engine(ctx);
        startUi(ctx, eng).catch((e) => ctx.log.warn('first frame: ' + e));
    },
});
