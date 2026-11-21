'use strict';
/**
 * Recuperation - what slowing down gives back.
 *
 *   - per drive (lib/ev_trip.js: from moving off to 5 minutes standing): the energy the battery gave (driving,
 *     climate, everything) and took back while moving, the share that is, the range it added at this drive's
 *     consumption, the most it took at once.
 *   - per stop or slow-down (lib/ev_regen.js): how much of the energy the car had to lose came back, against how
 *     hard it braked: gentle braking lets the motors take it all, hard braking needs the friction brakes too.
 *   - totals and the last 100 drives.
 *
 * The battery's power is read over UDS (lib/ev_hv.js: pack voltage and current) about once a second while the car
 * moves (app.json autostart: also without its screens), the speed over SOME/IP. Nothing is read while the car
 * stands parked, or is locked and left.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Hv } = require('./ev_hv');
const { watchCar, MODE_LABEL } = require('./ev_signals');
const C = require('./ev_core');
const { TripClock } = require('./ev_trip');
const { Braking, byStrength } = require('./ev_regen');
const { CAR } = require('./ev_phys');
const { DemoDrive } = require('./ev_demo');
const U = require('./ev_ui');

const { isNum } = C;
const W = 1600, H = 520;
const MAX_EVENTS = 300;
const NAMES = { live: 'Jetzt', stops: 'Bremsen', trips: 'Fahrten', diag: 'Diagnose' };

/** What a drive's accumulators become in its summary (also for the drive going on). */
function tripSummary(o) {
    return { id: o.id, t0: o.t0, t1: o.t1, km: Math.round(o.km * 100) / 100, out: Math.round(o.out * 1000) / 1000, in: Math.round(o.in * 1000) / 1000,
        peak: Math.round(o.peak), stops: o.stops, eff: o.effAvail > 0 ? Math.round(o.effBack / o.effAvail * 1000) / 1000 : null,
        amb: isNum(o.amb) ? Math.round(o.amb) : null, mode: o.modes ? Object.keys(o.modes).sort((a, b) => o.modes[b] - o.modes[a])[0] || null : null, reason: o.reason };
}

/** One recorder: drives, their energy and the braking events; fed by readings (real or demo). */
function recorder(st, opts) {
    const car = () => Object.assign({}, CAR, { mass: opts.mass() });
    const trips = new TripClock(st, {
        make: () => ({ out: 0, in: 0, peak: 0, stops: 0, effBack: 0, effAvail: 0, amb: opts.ambient(), modes: {} }),
        summary: tripSummary,
        onClose: (s) => {
            if (!s) return;
            const d = C.dayKey(s.t0), day = st.days[d] || (st.days[d] = { km: 0, out: 0, in: 0 });
            day.km += s.km; day.out += s.out; day.in += s.in;
            const keys = Object.keys(st.days).sort();
            while (keys.length > 60) delete st.days[keys.shift()];
            st.total.km += s.km; st.total.out += s.out; st.total.in += s.in;
            if (opts.onClose) opts.onClose(s);
        },
    });
    const braking = new Braking({
        car: car(),
        onEvent: (e) => {
            st.events.push(e);
            if (st.events.length > MAX_EVENTS) st.events.splice(0, st.events.length - MAX_EVENTS);
            const o = trips.open;
            if (o) { o.stops++; if (isNum(e.eff)) { o.effBack += e.kwh; o.effAvail += e.avail; } }
        },
    });
    let prev = null, movedT = 0;
    return {
        trips, braking,
        speed(t, v) { trips.speed(t, v); if (isNum(v) && v > 1) movedT = t; },
        /** A battery reading: kw + gives power, - takes it. */
        power(t, kw, v, mode) {
            const o = trips.open;
            braking.car = car();
            if (o && prev && t - prev.t < 5000 && t > prev.t) {
                const h = (t - prev.t) / 3600000, avg = (kw + prev.kw) / 2;
                if (avg > 0) o.out += avg * h;
                else if (t - movedT < 5000) o.in += -avg * h;          // (standing: not recuperation)
                if (-kw > o.peak && t - movedT < 5000) o.peak = -kw;
                if (mode) o.modes[mode] = (o.modes[mode] || 0) + h;
            }
            if (isNum(v)) braking.sample(t, kw, v);
            prev = { t, kw };
        },
        check(t) { trips.check(t); },
    };
}

function engine(env) {
    const { log, settings, spec } = env;
    const fresh = () => ({ trips: [], open: null, events: [], days: {}, total: { km: 0, out: 0, in: 0 }, pick: {}, sign: null });
    const store = new C.Store(env.dataDir, 'regen.json', fresh(), log);
    const st = store.data;
    const hv = new Hv(env.signals, log, spec.config && spec.config.hv);
    hv.usePick(st.pick);
    hv.applySign(settings.get('signMode'), st.sign);
    settings.onChange((k) => { if (k === 'signMode') hv.applySign(settings.get('signMode'), st.sign); });
    const now = { kw: null, t: 0 };
    let rec = null;
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'fes'], { onSpeed: (v) => { if (rec && !demoOn()) rec.speed(Date.now(), v); } });
    rec = recorder(st, {
        mass: () => settings.get('mass') || CAR.mass, ambient: () => live.ambient,
        onClose: (s) => { log.info('drive ' + G.fmt(s.km, 1) + ' km: out ' + G.fmt(s.out, 2) + ' kWh, back ' + G.fmt(s.in, 2) + ' kWh'); st.pick = hv.pick; store.save(true); },
    });
    let visible = false, stopped = false, wake = null;

    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await hv.init();
        while (!stopped) {
            let wait = 2000;
            const t0 = Date.now();
            try {
                rec.check(t0);
                if (demoOn()) { demoTick(); wait = 250; }
                else if (hv.available && !live.left() && (rec.trips.open || visible || live.driving())) {
                    const p = await hv.power(true, 3000);
                    if (p) {
                        const s = hv.learnSign(p, live.speed);
                        if (s) { st.sign = s; store.save(true); }
                        now.kw = p.kw; now.t = Date.now();
                        rec.power(now.t, p.kw, live.speed, live.mode);
                        if (rec.trips.open) store.save(false, 60000);
                    }
                    wait = (settings.get('sample') || 1) * 1000 - (Date.now() - t0);
                } else wait = 5000;
            } catch (e) { log.warn('read: ' + (e && e.message || e)); }
            await sleep(Math.max(100, wait));
        }
    }

    /* ---------- demo: a drive going on, and drives before it ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !hv.available && !now.t);
    function demoTick() {
        const t = Date.now();
        if (!demo) {
            const dst = fresh();
            const r = recorder(dst, { mass: () => settings.get('mass') || CAR.mass, ambient: () => 8 });
            // drives over the last days, then the one going on (15 minutes in)
            let tt = t - 9 * 86400000;
            for (let k = 0; k < 8; k++) {
                const d = new DemoDrive(11 + k, { ambient: 4 + k * 2 });
                const len = 900 + (k % 3) * 900;
                for (let i = 0; i < len; i++) { const s = d.step(1); r.speed(tt, s.speed); r.power(tt, s.kw, s.speed, s.mode); tt += 1000; }
                tt += 6 * 60000; r.check(tt); tt += 1.1 * 86400000;
            }
            const d = new DemoDrive(7);
            tt = t - 15 * 60000;
            for (let i = 0; i < 15 * 60 * 4; i++) { const s = d.step(0.25); r.speed(tt, s.speed); if (i % 4 === 0) r.power(tt, s.kw, s.speed, s.mode); tt += 250; }
            demo = { st: dst, r, d };
        }
        const s = demo.d.step(0.25);
        demo.r.speed(t, s.speed); demo.r.power(t, s.kw, s.speed, s.mode);
        demo.now = { kw: s.kw, speed: s.speed, mode: s.mode };
    }

    loop();
    return {
        ok: true, hv, live,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        view() {
            if (demoOn()) { if (!demo) demoTick(); return { demo: true, st: demo.st, kw: demo.now.kw, speed: demo.now.speed, mode: demo.now.mode, link: true }; }
            return { demo: false, st, kw: Date.now() - now.t < 5000 ? now.kw : null, speed: live.speed, mode: live.mode, link: hv.available };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['live', 'stops', 'trips'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    const mi = () => settings.get('distUnit') === 'mi';
    const dU = () => (mi() ? 'mi' : 'km');
    const D = (km) => C.dist(km, settings.get('distUnit'));
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    const pct = (x) => (isNum(x) ? F(x * 100, 0) + ' %' : '--');
    const effColor = (t, e) => (!isNum(e) ? t.dim : e >= 0.65 ? U.GO : e >= 0.45 ? '#c8d0dc' : t.warn);
    /** Range the energy back added at this consumption: back / ((out - back) / km). */
    const gained = (s) => (s && s.km > 0.5 && s.out > s.in ? s.in / ((s.out - s.in) / s.km) : null);

    function stat(cv, t, x, y, label, value, unit, color) {
        cv.text(label.toUpperCase(), x, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
        U.big(cv, t, x, y + 62, value, unit, 64, color || t.text);
    }

    function drawLive(cv, t, v) {
        const o = v.st.open, s = o ? tripSummary(o) : v.st.trips[v.st.trips.length - 1];
        const r = G.panel(cv, t, 24, 44, 820, 468, o ? 'Diese Fahrt' : s ? 'Letzte Fahrt  ' + C.when(s.t0) : 'Diese Fahrt');
        const kw = v.kw;
        G.bar(cv, t, r.x + 24, r.y + 64, r.w - 48, 70, { min: -150, max: 250, origin: 0, value: isNum(kw) ? kw : null, label: isNum(kw) && kw < 0 ? 'Rekuperation' : 'Akkuleistung',
            unit: 'kW', decimals: 0, color: isNum(kw) && kw < 0 ? U.GO : null, step: 50 });
        if (!s) { U.note(cv, t, r.x, r.y + 140, r.w, r.h - 140, v.link ? 'Losfahren: Die Fahrt wird von selbst aufgezeichnet' : 'Warte auf das Batteriesteuergerät'); }
        else {
            const g = gained(s);
            stat(cv, t, r.x + 24, r.y + 200, 'Gefahren', F(D(s.km), 1), dU());
            stat(cv, t, r.x + 290, r.y + 200, 'Verbraucht', F(s.out, 2), 'kWh');
            stat(cv, t, r.x + 560, r.y + 200, 'Zurück', F(s.in, 2), 'kWh', U.GO);
            stat(cv, t, r.x + 24, r.y + 330, 'Anteil', isNum(s.in) && s.out > 0 ? F(s.in / s.out * 100, 0) : '--', '%', U.GO);
            stat(cv, t, r.x + 290, r.y + 330, 'Reichweite +', isNum(g) ? F(D(g), 1) : '--', dU());
            stat(cv, t, r.x + 560, r.y + 330, 'Bremsungen zurück', isNum(s.eff) ? F(s.eff * 100, 0) : '--', '%', effColor(t, s.eff));
            cv.text('höchstens ' + F(s.peak, 0) + ' kW auf einmal' + (s.mode ? '   meist ' + (MODE_LABEL[s.mode] || s.mode) : '') + '   ' + s.stops + (s.stops === 1 ? ' Bremsung' : ' Bremsungen'), r.x + 24, r.y + r.h - 18, 18, t.dim);
        }
        const rr = G.panel(cv, t, 868, 44, 708, 468, 'Letzte Bremsungen');
        const ev = v.st.events.slice(-8).reverse();
        G.table(cv, t, rr.x + 24, rr.y + 64, rr.w - 48, [{ label: 'Wann', w: 110 }, { label: 'km/h', w: 140 }, { label: 'm/s²', w: 90, align: 'right' },
            { label: 'Zurück', w: 120, align: 'right' }, { label: 'Anteil', w: 200, align: 'right' }],
        ev.map((e) => [C.when(e.t), e.v0 + ' -> ' + e.v1, F(e.decel, 1), F(e.kwh * 1000, 0) + ' Wh', { text: isNum(e.eff) ? pct(e.eff) : 'bergab', color: effColor(t, e.eff) }]),
        { rowH: 44, size: 22, empty: 'Noch keine Bremsung' });
    }

    function drawStops(cv, t, v) {
        const ev = v.st.events, bands = byStrength(ev);
        const r = G.panel(cv, t, 24, 44, 640, 468, 'Zurück nach Bremsstärke');
        bands.forEach((b, i) => {
            const y = r.y + 76 + i * 92;
            G.bar(cv, t, r.x + 24, y, r.w - 48, 70, { min: 0, max: 100, value: isNum(b.eff) ? b.eff * 100 : null, unit: '%', decimals: 0, step: 25,
                label: b.label + '  ' + (b.hi < 99 ? b.lo + '-' + b.hi : 'über ' + b.lo) + ' m/s²  (' + b.n + ')', color: effColor(t, b.eff) });
        });
        const rr = G.panel(cv, t, 688, 44, 888, 468, 'Jede Bremsung: Anteil zurück über der Bremsstärke');
        const pts = ev.filter((e) => isNum(e.eff) && isNum(e.decel));
        const ch = U.chart(cv, t, rr.x + 16, rr.y + 56, rr.w - 32, rr.h - 140, { xMin: 0, xMax: 4, xStep: 1, yMin: 0, yMax: 100, yStep: 25, xUnit: 'm/s²', yUnit: '%', series: [] });
        pts.forEach((e) => cv.circle(ch.X(Math.min(4, e.decel)), ch.Y(Math.min(100, e.eff * 100)), 5, U.withAlpha(effColor(t, e.eff), 0.8)));
        if (!pts.length) U.note(cv, t, rr.x, rr.y, rr.w, rr.h - 60, 'Noch keine Bremsung gemessen');
        const g = bands[0], h = bands.slice(2).filter((b) => b.n).reduce((a, b) => (a && a.n > b.n ? a : b), null) || bands[1];
        const tip = isNum(g.eff) && h && isNum(h.eff) && g.eff - h.eff > 0.08
            ? 'Sanftes Bremsen brachte ' + pct(g.eff) + ' zurück, kräftiges ' + pct(h.eff) + ': früher und leichter bremsen spart Energie.'
            : 'Jeder Punkt ist eine Bremsung. Der Rest ging an die Reibungsbremsen und den Antrieb.';
        cv.text(tip, rr.x + 24, rr.y + rr.h - 40, 20, t.text);
    }

    function drawTrips(cv, t, v) {
        const list = v.st.trips.slice().reverse(), T = v.st.total;
        const share = T.out > 0 ? T.in / T.out : null, g = T.km > 1 && T.out > T.in ? T.in / ((T.out - T.in) / T.km) : null;
        const r = G.panel(cv, t, 24, 44, 1552, 468, list.length ? 'Alle Fahrten: ' + F(D(T.km), 0) + ' ' + dU() + '   zurück ' + F(T.in, 1) + ' kWh (' + pct(share) + ')   etwa ' + F(D(g), 0) + ' ' + dU() + ' Reichweite' : 'Fahrten');
        const rows = Math.floor((r.h - 100) / 40);
        G.table(cv, t, r.x + 24, r.y + 64, r.w - 48, [{ label: 'Wann', w: 200 }, { label: 'Strecke', w: 160, align: 'right' }, { label: 'Verbraucht', w: 170, align: 'right' },
            { label: 'Zurück', w: 190, align: 'right' }, { label: 'Anteil', w: 130, align: 'right' }, { label: 'Reichweite +', w: 190, align: 'right' },
            { label: 'Höchstens', w: 180, align: 'right' }, { label: 'Bremsungen zurück', w: 240, align: 'right' }],
        list.slice(0, rows).map((s) => [C.when(s.t0), F(D(s.km), 1) + ' ' + dU(), F(s.out, 2) + ' kWh', { text: F(s.in, 2) + ' kWh', color: U.GO },
            pct(s.out > 0 ? s.in / s.out : null), isNum(gained(s)) ? F(D(gained(s)), 1) + ' ' + dU() : '--', F(s.peak, 0) + ' kW',
            { text: pct(s.eff) + '  (' + s.stops + ')', color: effColor(t, s.eff) }]),
        { rowH: 40, size: 22, empty: 'Noch keine Fahrt aufgezeichnet' });
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'live') drawLive(cv, t, v);
        else if (p === 'stops') drawStops(cv, t, v);
        else if (p === 'trips') drawTrips(cv, t, v);
        else U.diagPage(cv, t, eng.hv, eng.live, [['Tempo', F(eng.live.speed, 1) + ' km/h'], ['Fahrmodus', String(eng.live.modeRaw)], ['Fahrzeugzustand', String(eng.live.cond)]]);
        pg.header(cv, t, [U.demoBadge(v.demo), isNum(v.kw) && v.kw < -3 && { text: 'REKUPERIERT', color: U.GO }]);
        return ui.image('MAIN_GFX', cv);
    }
    ctx.loop('MAIN', 4, render);
    return render();
}

mgu.run({
    background(bg) { return engine(bg); },
    async start(ctx) {
        const eng = ctx.background && ctx.background.ok ? ctx.background : engine(ctx);
        startUi(ctx, eng).catch((e) => ctx.log.warn('first frame: ' + e));
    },
});
