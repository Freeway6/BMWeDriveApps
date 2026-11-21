'use strict';
/**
 * Efficiency Coach - what this car really uses, and what changes it.
 *
 *   - consumption from the battery's own energy (lib/ev_hv.js: E5C7 stored kWh, else charge level x usable kWh)
 *     read every 10 s while driving, against the distance from the speed signal: net, so recuperation is in it,
 *     and so are the climate and everything else the battery feeds - what the range really depends on.
 *   - now: the last few km against what the car usually takes at the same speeds (lib/ev_coach.js: learned from
 *     every drive by speed band), the range left at that rate.
 *   - what changes it: consumption per speed band, outside temperature band, driving mode, climate on or off.
 *   - drives: each with its consumption and how it compares with the usual at its speeds.
 *
 * Read by itself while the car is driven (app.json autostart), nothing while it stands parked or is locked and left.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Hv } = require('./ev_hv');
const { watchCar, MODE_LABEL } = require('./ev_signals');
const C = require('./ev_core');
const { TripClock } = require('./ev_trip');
const { Coach, lastKm, SPEED_LABELS, TEMP_LABELS, MIN_V, CHUNK_KM, CHUNK_H } = require('./ev_coach');
const { DemoDrive } = require('./ev_demo');
const { BATTERIES } = require('./ev_model');
const U = require('./ev_ui');

const { isNum } = C;
const W = 1600, H = 520;
const MAX_SLICES = 720;          // the drive going on (about 2 hours of 10 s readings)
const NAMES = { coach: 'Jetzt', speed: 'Tempo', cond: 'Bedingungen', trips: 'Fahrten', diag: 'Diagnose' };

function recorder(st, opts) {
    const coach = new Coach(st);
    const slices = [];
    let prev = null;
    const trips = new TripClock(st, {
        make: () => ({ kwh: 0, cmpKwh: 0, expKwh: 0, amb: opts.ambient(), modes: {} }),
        onOpen: () => { slices.length = 0; prev = null; },
        summary: (o) => ({ id: o.id, t0: o.t0, t1: o.t1, km: Math.round(o.km * 100) / 100, kwh: Math.round(o.kwh * 1000) / 1000,
            cons: o.km > 0.5 ? Math.round(o.kwh / o.km * 1000) / 10 : null, v: o.movingMs > 0 ? Math.round(o.km / (o.movingMs / 3600000)) : null,
            amb: isNum(o.amb) ? Math.round(o.amb) : null, mode: Object.keys(o.modes).sort((a, b) => o.modes[b] - o.modes[a])[0] || null,
            vs: o.expKwh > 0.2 ? Math.round((o.cmpKwh / o.expKwh - 1) * 1000) / 1000 : null, reason: o.reason }),
        onClose: (s) => { if (opts.onClose && s) opts.onClose(s); },
    });
    return {
        coach, trips, slices,
        speed(t, v) { trips.speed(t, v); },
        /** A reading of the energy in the battery (kWh) at t, with the conditions then. */
        energy(t, e, cond) {
            const o = trips.open;
            if (!o || !isNum(e)) { prev = null; return; }
            if (prev && t > prev.t && t - prev.t < 90000) {
                const kwh = prev.e - e, km = o.km - prev.km, h = (t - prev.t) / 3600000;
                // (more than 0.3 kWh back within a reading: not driving, the battery was charged)
                if (kwh > -0.3) {
                    const s = { t, km, kwh, h, v: km / h, amb: cond.amb, mode: cond.mode, climate: cond.climate };
                    // the drive against the usual: each piece as it goes into the bins, with what it usually takes
                    // (worked out before the piece itself is in them)
                    const pending = (coach.chunk ? [coach.chunk] : []).map((c) => ({ km: c.km + km, h: c.h + h, kwh: c.kwh + kwh }))[0] || { km, h, kwh };
                    const done = pending.km >= CHUNK_KM || pending.h >= CHUNK_H;
                    const ex = done && pending.h > 0 && pending.km / pending.h >= MIN_V ? coach.expected([pending]) : null;
                    coach.slice(s);
                    if (isNum(ex)) { o.expKwh += ex; o.cmpKwh += pending.kwh; }
                    o.kwh += kwh;
                    if (cond.mode) o.modes[cond.mode] = (o.modes[cond.mode] || 0) + km;
                    slices.push(s);
                    if (slices.length > MAX_SLICES) slices.shift();
                }
            }
            prev = { t, e, km: o.km };
        },
        check(t) { trips.check(t); },
    };
}

function engine(env) {
    const { log, settings, spec } = env;
    const fresh = () => ({ trips: [], open: null, bins: null, pick: {} });
    const store = new C.Store(env.dataDir, 'coach.json', fresh(), log);
    const st = store.data;
    const hv = new Hv(env.signals, log, spec.config && spec.config.hv);
    hv.usePick(st.pick);
    let rec = null;
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'fes', 'climate'], { onSpeed: (v) => { if (rec && !demoOn()) rec.speed(Date.now(), v); } });
    rec = recorder(st, {
        ambient: () => live.ambient,
        onClose: (s) => { log.info('drive ' + G.fmt(s.km, 1) + ' km, ' + G.fmt(s.cons, 1) + ' kWh/100 km'); st.pick = hv.pick; store.save(true); },
    });
    const now = { e: null, cap: null, t: 0 };
    let visible = false, stopped = false, wake = null;

    /** kWh in the battery now: its own figure, else the charge level x usable kWh. */
    async function energy() {
        const g = await hv.group('energy');
        if (g && isNum(g.stored)) { if (isNum(g.cap)) now.cap = g.cap; return g.stored; }
        const soc = await hv.value('soc');
        return soc === null ? null : soc / 100 * (now.cap || BATTERIES[settings.get('battery')].usable);
    }
    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await hv.init();
        while (!stopped) {
            let wait = 5000;
            const t0 = Date.now();
            try {
                rec.check(t0);
                if (demoOn()) { demoTick(); wait = 500; }
                else if (hv.available && !live.left() && (rec.trips.open || visible || live.driving())) {
                    const e = await energy();
                    if (isNum(e)) { now.e = e; now.t = Date.now(); rec.energy(now.t, e, { amb: live.ambient, mode: live.mode, climate: live.climate }); }
                    if (rec.trips.open) store.save(false, 120000);
                    wait = (settings.get('sample') || 10) * 1000 - (Date.now() - t0);
                }
            } catch (e) { log.warn('read: ' + (e && e.message || e)); }
            await sleep(Math.max(200, wait));
        }
    }

    /* ---------- demo: drives in all seasons, then one going on ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !hv.available && !now.t);
    function demoTick() {
        const t = Date.now();
        if (!demo) {
            const dst = fresh();
            let amb = 10;
            const r = recorder(dst, { ambient: () => amb });
            let tt = t - 40 * 86400000;
            [-3, 4, 9, 14, 19, 24, 31, 6, 12, 2].forEach((a, k) => {
                amb = a;
                const d = new DemoDrive(20 + k, { ambient: a, soc0: 80 });
                for (let i = 0; i < 2400; i++) {
                    const s = d.step(1);
                    r.speed(tt, s.speed);
                    if (i % 10 === 0) r.energy(tt, d.stored, { amb: a, mode: s.mode, climate: a < 16 || a > 24 });
                    tt += 1000;
                }
                for (let i = 0; i < 400; i++) { r.speed(tt, 0); tt += 1000; }
                r.check(tt);
                tt += 3.5 * 86400000;
            });
            amb = 8;
            const d = new DemoDrive(7, { ambient: 8 });
            tt = t - 15 * 60000;
            for (let i = 0; i < 15 * 60 * 2; i++) {
                const s = d.step(0.5);
                r.speed(tt, s.speed);
                if (i % 20 === 0) r.energy(tt, d.stored, { amb: 8, mode: s.mode, climate: true });
                tt += 500;
            }
            demo = { st: dst, r, d, lastE: tt };
        }
        const s = demo.d.step(0.5);
        demo.r.speed(t, s.speed);
        if (t - demo.lastE >= 10000) { demo.lastE = t; demo.r.energy(t, demo.d.stored, { amb: 8, mode: s.mode, climate: true }); }
        demo.now = { e: demo.d.stored, speed: s.speed, mode: s.mode };
    }

    loop();
    return {
        ok: true, hv, live,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        view() {
            if (demoOn()) { if (!demo) demoTick(); return { demo: true, st: demo.st, r: demo.r, e: demo.now.e, amb: 8, mode: demo.now.mode, link: true }; }
            return { demo: false, st, r: rec, e: now.e, amb: live.ambient, mode: live.mode, link: hv.available };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['coach', 'speed', 'cond', 'trips'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    const unit = () => settings.get('distUnit');
    const dU = () => (unit() === 'mi' ? 'mi' : 'km');
    const D = (km) => C.dist(km, unit());
    const cU = () => C.consUnit(unit());
    const CO = (k) => C.cons(k, unit());
    const fmtC = (k) => (isNum(CO(k)) ? F(CO(k), unit() === 'mi' ? 2 : 1) : '--');
    const tU = () => (settings.get('tempUnit') === 'f' ? '°F' : '°C');
    const fmtT = (c) => (isNum(c) ? F(C.temp(c, settings.get('tempUnit')), 0) + ' ' + tU() : '--');
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    const vsText = (x) => (!isNum(x) ? '' : Math.abs(x) < 0.03 ? 'wie üblich' : F(Math.abs(x) * 100, 0) + ' % ' + (x < 0 ? 'weniger' : 'mehr') + ' als üblich');
    const vsColor = (t, x) => (!isNum(x) ? t.dim : x <= -0.03 ? U.GO : x >= 0.08 ? t.warn : t.text);

    /** kWh/100 km along the drive over windows of 1 km: { own: [[km, cons]], usual: [[km, cons as usual]] }. */
    function along(slices, coach) {
        const own = [], usual = [];
        let km = 0, w = [];
        slices.forEach((s) => {
            km += s.km; w.push(s);
            const wkm = w.reduce((a, x) => a + x.km, 0);
            if (wkm >= 1) {
                own.push([km, w.reduce((a, x) => a + x.kwh, 0) / wkm * 100]);
                const ex = coach.expected(w);
                if (isNum(ex)) usual.push([km, ex / wkm * 100]);
                w = [];
            }
        });
        return { own, usual };
    }

    function drawCoach(cv, t, v) {
        const r = v.r, o = r.trips.open, win = settings.get('window') || 5;
        const w = lastKm(r.slices, win), cons = w.km >= Math.min(1, win) ? w.kwh / w.km * 100 : null;
        const cmp = r.coach.compare(w.slices), exp = cmp ? cmp.exp : null, vs = cmp && cmp.exp > 0 && isNum(cons) ? cmp.own / cmp.exp - 1 : null;
        const p = G.panel(cv, t, 24, 44, 760, 468, 'Jetzt: die letzten ' + F(D(win), 0) + ' ' + dU());
        U.tag(cv, t, p.x + 24, p.y + 92, !o ? 'KEINE FAHRT' : isNum(vs) ? vsText(vs).toUpperCase() : 'LERNT DEIN AUTO', vsColor(t, vs), 24);
        U.big(cv, t, p.x + 24, p.y + 226, fmtC(cons), cU(), 120, isNum(vs) ? vsColor(t, vs) : t.text);
        const usualNow = isNum(exp) && w.km > 0 ? exp / w.km * 100 : null;
        const tripCons = o && o.km > 0.5 ? o.kwh / o.km * 100 : null;
        const rows = [
            ['Üblich bei diesem Tempo', isNum(usualNow) ? fmtC(usualNow) + ' ' + cU() : 'lernt noch'],
            ['Diese Fahrt', o ? F(D(o.km), 1) + ' ' + dU() + '   ' + F(o.kwh, 2) + ' kWh   ' + fmtC(tripCons) + ' ' + cU() : '--'],
            ['Reichweite so', isNum(v.e) && isNum(cons) && cons > 1 ? F(D(v.e / cons * 100), 0) + ' ' + dU() + '   (' + F(v.e, 1) + ' kWh übrig)' : '--'],
            ['Außen   Modus', fmtT(v.amb) + '   ' + (v.mode ? MODE_LABEL[v.mode] || v.mode : '--')],
        ];
        rows.forEach((x, i) => U.row(cv, t, p.x + 24, p.w - 48, p.y + 300 + i * 42, x[0], x[1]));
        const rr = G.panel(cv, t, 808, 44, 768, 468, o ? 'Diese Fahrt, je ' + dU() : 'Fahrt');
        const al = along(r.slices, r.coach), pts = al.own.map((q) => [D(q[0]), CO(q[1])]), usual = al.usual.map((q) => [D(q[0]), CO(q[1])]);
        const ys = pts.concat(usual).map((q) => q[1]).filter(isNum);
        U.chart(cv, t, rr.x + 16, rr.y + 60, rr.w - 32, rr.h - 76, {
            xMin: 0, xMax: Math.max(5, Math.ceil(pts.length ? pts[pts.length - 1][0] : 5)), yMin: 0, yMax: ys.length ? Math.ceil(Math.max.apply(null, ys) / 10) * 10 + 5 : 40,
            xUnit: dU(), yUnit: cU(), series: [{ pts: usual, color: t.dim, width: 2, dash: true }, { pts, color: U.GO, width: 3, fill: 0.12 }],
            empty: o ? 'Der erste km' : 'Losfahren: wird von selbst aufgezeichnet',
        });
        cv.fillRect(rr.x + 440, rr.y + 32, 26, 4, U.GO); cv.text('diese Fahrt', rr.x + 474, rr.y + 40, 18, t.dim);
        cv.fillRect(rr.x + 600, rr.y + 33, 26, 2, t.dim); cv.text('üblich', rr.x + 634, rr.y + 40, 18, t.dim);
    }

    function drawSpeed(cv, t, v) {
        const b = v.st.bins, c = v.r.coach;
        const p = G.panel(cv, t, 24, 44, 1552, 468, 'Verbrauch nach Tempo (km/h)');
        const vals = b.speed.map((x) => c.cons(x));
        const tot = b.speed.reduce((a, x) => ({ km: a.km + x.km, kwh: a.kwh + x.kwh }), { km: 0, kwh: 0 });
        const avg = tot.km > 2 ? tot.kwh / tot.km * 100 : null;
        U.bars(cv, t, p.x + 24, p.y + 50, 1100, p.h - 70, b.speed.map((x, i) => ({ label: SPEED_LABELS[i], value: CO(vals[i]), text: fmtC(vals[i]),
            sub: x.km >= 1 ? F(D(x.km), 0) + ' ' + dU() : '', color: i >= 5 ? 'warn' : i <= 1 ? 'cold' : U.GO })), { mark: CO(avg) });
        // out of town (from 90 km/h up): the biggest step between two speed bands with enough driven, what going one
        // band slower saves (in town the speed is not the choice)
        let best = null;
        for (let i = vals.length - 1; i >= 4; i--) if (isNum(vals[i]) && isNum(vals[i - 1]) && vals[i] > vals[i - 1] && (!best || vals[i] - vals[i - 1] > best.d)) best = { i, d: vals[i] - vals[i - 1] };
        const x = p.x + 1160;
        cv.text(cU(), x, p.y + 92, 20, t.dim, { font: 'bold' });
        const lines = best ? ['Bei ' + SPEED_LABELS[best.i] + ' km/h braucht dein Auto', fmtC(vals[best.i]) + ', bei ' + SPEED_LABELS[best.i - 1] + ' km/h ' + fmtC(vals[best.i - 1]) + ':',
            F(best.d / vals[best.i] * 100, 0) + ' % weniger, etwa ' + F(best.d / vals[best.i] * 100, 0) + ' % mehr Reichweite.'] : ['Jeder Balken füllt sich, sobald', 'du ' + F(D(2), 0) + ' ' + dU() + ' in diesem Tempo gefahren bist.'];
        lines.forEach((l, k) => cv.text(l, x, p.y + 150 + k * 34, 22, k === 0 && best ? t.text : t.text));
        cv.text('Linie: dein Schnitt ' + fmtC(avg) + ' ' + cU(), x, p.y + 290, 20, t.dim);
        if (isNum(b.stand.h) && b.stand.h > 0.05) cv.text('Im Stand (Stau, Warten): ' + F(b.stand.kwh / b.stand.h, 1) + ' kW', x, p.y + 324, 20, t.dim);
        cv.text('Netto-Energie: Rekuperation ist eingerechnet.', x, p.y + 358, 20, t.dim);
    }

    function drawCond(cv, t, v) {
        const b = v.st.bins, c = v.r.coach;
        const p = G.panel(cv, t, 24, 44, 900, 468, 'Nach Außentemperatur (' + tU() + ')');
        const tl = settings.get('tempUnit') === 'f' ? ['< 32', '32-50', '50-68', '68-86', '86+'] : TEMP_LABELS;
        U.bars(cv, t, p.x + 24, p.y + 50, p.w - 48, p.h - 70, b.temp.map((x, i) => ({ label: tl[i], value: CO(c.cons(x)), text: fmtC(c.cons(x)),
            sub: x.km >= 1 ? F(D(x.km), 0) + ' ' + dU() : '', color: i <= 1 ? 'cold' : i >= 4 ? 'warn' : U.GO })));
        const q = G.panel(cv, t, 948, 44, 628, 468, 'Nach Modus und Klima');
        const modes = ['eco', 'comfort', 'sport'].map((m) => ({ label: MODE_LABEL[m], value: CO(c.cons(b.mode[m])), text: fmtC(c.cons(b.mode[m])),
            sub: b.mode[m] && b.mode[m].km >= 1 ? F(D(b.mode[m].km), 0) + ' ' + dU() : '', color: m === 'eco' ? U.GO : m === 'sport' ? 'warn' : 'cold' }));
        const clim = [{ label: 'Klima an', value: CO(c.cons(b.climate.on)), text: fmtC(c.cons(b.climate.on)), sub: b.climate.on.km >= 1 ? F(D(b.climate.on.km), 0) + ' ' + dU() : '', color: 'warn' },
            { label: 'Klima aus', value: CO(c.cons(b.climate.off)), text: fmtC(c.cons(b.climate.off)), sub: b.climate.off.km >= 1 ? F(D(b.climate.off.km), 0) + ' ' + dU() : '', color: U.GO }];
        U.bars(cv, t, q.x + 24, q.y + 50, q.w - 48, q.h - 70, modes.concat(clim));
    }

    function drawTrips(cv, t, v) {
        const list = v.st.trips.slice().reverse();
        const tot = list.reduce((a, s) => ({ km: a.km + s.km, kwh: a.kwh + s.kwh }), { km: 0, kwh: 0 });
        const p = G.panel(cv, t, 24, 44, 1552, 468, list.length ? list.length + ' Fahrten   ' + F(D(tot.km), 0) + ' ' + dU() + '   ' + F(tot.kwh, 0) + ' kWh   ' + fmtC(tot.km > 0 ? tot.kwh / tot.km * 100 : null) + ' ' + cU() : 'Fahrten');
        const rows = Math.floor((p.h - 100) / 40);
        G.table(cv, t, p.x + 24, p.y + 64, p.w - 48, [{ label: 'Wann', w: 200 }, { label: 'Strecke', w: 170, align: 'right' }, { label: 'Energie', w: 170, align: 'right' },
            { label: cU(), w: 200, align: 'right' }, { label: 'Schnitt', w: 180, align: 'right' }, { label: 'Außen', w: 150, align: 'right' },
            { label: 'Modus', w: 170, align: 'right' }, { label: 'Gegen üblich', w: 260, align: 'right' }],
        list.slice(0, rows).map((s) => [C.when(s.t0), F(D(s.km), 1) + ' ' + dU(), F(s.kwh, 2) + ' kWh', fmtC(s.cons),
            isNum(s.v) ? F(D(s.v), 0) + ' ' + dU() + '/h' : '--', fmtT(s.amb), s.mode ? MODE_LABEL[s.mode] || s.mode : '--',
            { text: isNum(s.vs) ? (s.vs > 0 ? '+' : '') + F(s.vs * 100, 0) + ' %' : 'lernt noch', color: vsColor(t, s.vs) }]),
        { rowH: 40, size: 22, empty: 'Noch keine Fahrt aufgezeichnet' });
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'coach') drawCoach(cv, t, v);
        else if (p === 'speed') drawSpeed(cv, t, v);
        else if (p === 'cond') drawCond(cv, t, v);
        else if (p === 'trips') drawTrips(cv, t, v);
        else U.diagPage(cv, t, eng.hv, eng.live, [['Energie jetzt', F(v.e, 2) + ' kWh'], ['Tempo', F(eng.live.speed, 1) + ' km/h'], ['Fahrmodus', String(eng.live.modeRaw)],
            ['Klima', String(eng.live.climate)], ['Fahrzeugzustand', String(eng.live.cond)]]);
        pg.header(cv, t, [U.demoBadge(v.demo)]);
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
