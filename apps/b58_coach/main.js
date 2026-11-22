'use strict';
/**
 * Verbrauchs-Coach - what this M340i really uses, and what changes it.
 *
 *   - fuel: the injection counter the car sends by itself (CDS2), its factor learned from the engine unit's own fuel
 *     flow (DME 5656, lib/lib_flow.js); until it is learned, or where the counter is missing, the engine unit's flow
 *     read every second while the engine runs. With the engine stopped (auto start/stop) nothing is used.
 *   - now: the last few km against what the car usually takes warm at the same speeds and standing times
 *     (lib/lib_coach.js, learned from every drive), the range left in the tank at that rate.
 *   - what changes it: speed, outside temperature, driving mode, climate; a cold engine on its own page (drive.js):
 *     what each cold start costs, how long the engine takes to get warm, drives on which it never did.
 *   - drives: each with its fuel, cost (the price set) and how it compares with the usual.
 *
 * Runs by itself while the car is driven (app.json autostart); nothing is read with the engine off or the car left.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { UdsReader } = require('./lib_uds');
const { DME, dmeConfig } = require('./lib_dme');
const { watchCar, MODE_LABEL } = require('./lib_signals');
const { Flow, Used } = require('./lib_flow');
const C = require('./lib_core');
const U = require('./lib_ui');
const { DemoDrive, rng } = require('./lib_demo');
const { lastKm, SPEED_LABELS, TEMP_LABELS } = require('./lib_coach');
const { Recorder, months, coldStats, COLD_C } = require('./drive');

const { isNum } = C;
const W = 1600, H = 520;
const SLICE_MS = 10000;
const NAMES = { now: 'Jetzt', speed: 'Tempo', cond: 'Bedingungen', cold: 'Kaltstart', trips: 'Fahrten', diag: 'Diagnose' };

function engine(env) {
    const { log, settings, spec } = env;
    const fresh = () => ({ trips: [], open: null, bins: null, months: {}, flowK: null, pick: {} });
    const store = new C.Store(env.dataDir, 'coach.json', fresh(), log);
    const st = store.data;
    const dme = new UdsReader(env.signals, log, dmeConfig(spec.config && spec.config.dme), DME);
    dme.usePick(st.pick);
    const flow = new Flow(st.flowK), byCounter = new Used(), byDme = new Used();
    const zero = () => ({ c: 0, cMs: 0, d: 0, dMs: 0, offMs: 0 });
    let acc = zero(), rec = null;
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'engine', 'tank', 'inj', 'fes', 'climate'], {
        onSpeed: (v) => { if (rec && !demoOn()) rec.speed(Date.now(), v); },
        onInj: (raw, t) => {
            flow.feed(raw, t);
            acc.c += byCounter.add(flow.lph(t), t);
            acc.cMs += byCounter.dt;
        },
    });
    rec = new Recorder(st, {
        ambient: () => live.ambient,
        onClose: (s) => {
            if (s) log.info('drive ' + C.fmt(s.km, 1) + ' km, ' + C.fmt(s.cons, 1) + ' l/100 km' + (s.coldStart ? ', cold start' : ''));
            st.pick = dme.pick;
            store.save(true);
        },
    });
    const now = { lph: null, src: null, coolant: null, coolantT: 0 };
    let visible = false, stopped = false, wake = null, lastLearn = 0, learnUntil = 0, lastCut = 0, lastTick = 0;

    /** The engine's state known: its state signal, or an engine speed just now (CDS; app.json has it optional). */
    const engineKnown = () => (live.running !== null && Date.now() - live.runningT < 60000) || (isNum(live.rpm) && Date.now() - live.rpmT < 3000);
    /** The engine known to be off (auto start/stop, or parked with the ignition on): no fuel then. */
    const engineOff = () => engineKnown() && !live.engineOn();
    /** The engine runs: as the car says, else (no engine signals) while the car is driven or ready to drive. */
    const engineOn = () => (engineKnown() ? live.engineOn() : live.driving());
    /** The coolant: the car's own signal, else the engine unit's (read every 30 s while the signal is missing). */
    const coolant = () => (isNum(live.coolant) ? live.coolant : Date.now() - now.coolantT < 120000 ? now.coolant : null);
    const cond = () => ({ amb: live.ambient, mode: live.mode, climate: live.climate, coolant: coolant() });

    async function onEngine(t) {
        const counter = flow.k && t - live.injT < 3000;
        // the counter's factor checked against the engine unit's l/h for a minute every 30 min (until it is known,
        // the engine unit's flow is read all the time anyway, and it learns from that)
        if (flow.k && t - lastLearn > 1800000 && live.speed > 5) { lastLearn = t; learnUntil = t + 60000; }
        if (dme.available && (!counter || t < learnUntil)) {
            const lph = await dme.value('fuelFlow'), n = Date.now();
            if (isNum(lph)) {
                now.lph = lph; now.src = 'Motorsteuergerät';
                if (flow.learn(lph, n)) { st.flowK = flow.k; log.info('fuel flow factor ' + flow.k.toFixed(6)); store.save(false, 60000); }
            }
            acc.d += byDme.add(lph, n);
            acc.dMs += byDme.dt;
        }
        if (counter) { now.lph = flow.lph(Date.now()); now.src = 'Einspritzzähler'; }
        if (!isNum(live.coolant) && dme.available && t - now.coolantT > 30000) {
            const c = await dme.value('coolant');
            if (isNum(c)) { now.coolant = c; now.coolantT = Date.now(); }
        }
    }

    /** Every 10 s: a slice of the drive, with the fuel from the source that covered it (the counter first). */
    function cut(t) {
        const span = lastCut ? t - lastCut : 0, a = acc;
        lastCut = t;
        acc = zero();
        const byC = a.cMs >= a.dMs;
        rec.fuel(t, byC ? a.c : a.d, (byC ? a.cMs : a.dMs) + a.offMs, cond());
        if (rec.open) store.save(false, 120000);
        return span;
    }

    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await dme.init();
        while (!stopped) {
            let wait = 2000;
            const t = Date.now();
            try {
                rec.check(t);
                if (demoOn()) { demoTick(); wait = 500; }
                else {
                    const dt = lastTick ? Math.min(5000, t - lastTick) : 0;
                    lastTick = t;
                    if (engineOff()) { if (rec.open) acc.offMs += dt; now.lph = 0; }
                    else if (!live.left() && engineOn()) { await onEngine(t); wait = 1000; }
                    if (t - lastCut >= SLICE_MS) cut(t);
                }
            } catch (e) { log.warn('loop: ' + (e && e.message || e)); }
            await sleep(Math.max(200, wait - (Date.now() - t)));
        }
    }

    /* ---------- demo: five months of drives (short ones, commutes, motorway), then one going on ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !dme.available && !st.trips.length && !st.open);
    /** outside temperature over the year: about 24 °C in July, 0 °C in January */
    const season = (t) => { const d = new Date(t), doy = (t - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000; return 12 + 12 * Math.cos(2 * Math.PI * (doy - 200) / 365); };
    function drive(r, d, t0, secs, dt, amb, carry) {
        let tt = t0, l = carry ? carry.l : 0, last = carry ? carry.last : t0, s = null;
        for (let i = 0; i < secs / dt; i++) {
            s = d.step(dt);
            r.speed(tt, s.speed);
            l += s.lph * dt / 3600;
            if (tt - last >= SLICE_MS) { r.fuel(tt, l, tt - last, { amb, mode: s.mode, climate: s.climate, coolant: s.coolant }); l = 0; last = tt; }
            tt += dt * 1000;
        }
        return { tt, l, last, s };
    }
    function demoData() {
        if (demo) return demo;
        const t = Date.now(), dst = fresh(), q = rng(41), d0 = new Date(t - 150 * 86400000);
        d0.setHours(0, 0, 0, 0);
        let amb = 10, k = 0;
        const r = new Recorder(dst, { ambient: () => amb });
        // every 1-5 days one drive in the day time, sometimes a second one after a stop of 30-60 min (starting warm,
        // if the first got the engine warm): short ones, commutes, motorway
        for (let day = d0.getTime(); day < t - 2 * 86400000; day += Math.round(1 + q() * 4) * 86400000) {
            let tt = day + (6.5 + q() * 11) * 3600000, coolant = null;
            for (let j = q() < 0.3 ? 2 : 1; j > 0; j--, k++) {
                amb = Math.round(season(tt) + (q() - 0.5) * 6);
                const kind = q(), secs = kind < 0.35 ? 240 + q() * 200 : kind < 0.8 ? 840 + q() * 480 : 2400, c0 = isNum(coolant) ? coolant : amb + 2;
                const e = drive(r, new DemoDrive(50 + k, { ambient: amb, coolant: c0, oil: c0 }), tt, secs, 1, amb);
                let te = e.tt;
                for (let i = 0; i < 400; i++) { r.speed(te, 0); te += 1000; }
                r.check(te);
                coolant = Math.max(amb + 2, e.s.coolant - 12 - q() * 10);
                tt = te + (30 + q() * 30) * 60000;
            }
        }
        amb = Math.round(season(t));
        const d = new DemoDrive(7, { ambient: amb, coolant: amb + 2, oil: amb + 2 });
        const e = drive(r, d, t - 12 * 60000, 12 * 60, 0.5, amb);
        demo = { st: dst, r, d, amb, carry: { l: e.l, last: e.last }, s: e.s, tick: t, tank: 41.5 };
        return demo;
    }
    function demoTick() {
        const d = demoData(), t = Date.now(), dt = G.clamp((t - d.tick) / 1000, 0.1, 2);
        d.tick = t;
        const e = drive(d.r, d.d, t, dt, dt, d.amb, d.carry);
        d.carry = { l: e.l, last: e.last };
        d.s = e.s;
        d.tank -= e.s.lph * dt / 3600;
    }

    loop();
    return {
        ok: true, dme, live, flow, now,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        view() {
            if (demoOn()) {
                const d = demoData();
                return { demo: true, st: d.st, r: d.r, amb: d.amb, mode: d.s.mode, coolant: d.s.coolant, tank: d.tank, range: Math.round(d.tank / 10.8 * 100),
                    lph: d.s.lph, running: true, link: true };
            }
            return { demo: false, st, r: rec, amb: live.ambient, mode: live.mode, coolant: coolant(), tank: live.tank, range: live.range,
                lph: now.lph, running: engineOn(), link: dme.available };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['now', 'speed', 'cond', 'cold', 'trips'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    const CU = 'l/100 km';
    const price = () => settings.get('price') || 1.85;
    const eur = (l) => (isNum(l) ? F(l * price(), 2) + ' €' : '--');
    const L = (l, d) => (isNum(l) ? F(l, d == null ? 1 : d) + ' l' : '--');
    const sL = (l, d) => (isNum(l) ? (l > 0 && F(l, d) !== F(0, d) ? '+' : '') + L(l, d) : '--');
    /** A share as signed per cent: '+9 %', '-3 %', '0 %'. */
    const pct = (x) => { if (!isNum(x)) return '--'; const s = F(x * 100, 0); return (x > 0 && s !== '0' ? '+' : '') + s + ' %'; };
    const fmtC = (x) => (isNum(x) ? F(x, 1) : '--');
    const tU = () => (settings.get('tempUnit') === 'f' ? '°F' : '°C');
    const fmtT = (c) => (isNum(c) ? F(C.temp(c, settings.get('tempUnit')), 0) + ' ' + tU() : '--');
    const coldCol = (t) => t.cold || '#5aa9ff';
    const vsText = (x) => (!isNum(x) ? '' : Math.abs(x) < 0.03 ? 'wie üblich' : F(Math.abs(x) * 100, 0) + ' % ' + (x < 0 ? 'weniger' : 'mehr') + ' als üblich');
    const vsColor = (t, x) => (!isNum(x) ? t.dim : x <= -0.03 ? U.GO : x >= 0.08 ? t.warn : t.text);
    const modeText = (m) => (m ? MODE_LABEL[m] || m : '--');

    /** l/100 km along the drive over windows of 1 km: { own: [[km, cons, cold]], usual: [[km, cons as usual warm]] }. */
    function along(slices, coach) {
        const own = [], usual = [];
        let km = 0, w = [];
        slices.forEach((s) => {
            km += s.km; w.push(s);
            const wkm = w.reduce((a, x) => a + x.km, 0);
            if (wkm >= 1) {
                own.push([km, w.reduce((a, x) => a + x.l, 0) / wkm * 100, w.some((x) => x.cold)]);
                const ex = coach.warmAll(w);
                if (isNum(ex)) usual.push([km, ex / wkm * 100]);
                w = [];
            }
        });
        return { own, usual };
    }

    function drawNow(cv, t, v) {
        const r = v.r, o = r.open, win = settings.get('window') || 5;
        const w = lastKm(r.slices, win), cons = w.km >= Math.min(1, win) ? w.l / w.km * 100 : null;
        const ex = w.km >= Math.min(1, win) ? r.coach.warmAll(w.slices) : null, usualNow = isNum(ex) ? ex / w.km * 100 : null;
        const vs = isNum(cons) && isNum(usualNow) && usualNow > 0 ? cons / usualNow - 1 : null;
        const coldNow = v.running && isNum(v.coolant) && v.coolant < COLD_C;
        const p = G.panel(cv, t, 24, 44, 760, 468, 'Jetzt: die letzten ' + F(win, 0) + ' km');
        const tag = !o ? ['KEINE FAHRT', t.dim] : coldNow ? ['MOTOR KALT (' + fmtT(v.coolant) + ')', coldCol(t)] : isNum(vs) ? [vsText(vs).toUpperCase(), vsColor(t, vs)]
            : !isNum(cons) ? ['DER ERSTE KM', t.dim] : ['LERNT DEIN AUTO', t.dim];
        U.tag(cv, t, p.x + 24, p.y + 92, tag[0], tag[1], 24);
        U.big(cv, t, p.x + 24, p.y + 226, fmtC(cons), CU, 120, coldNow ? coldCol(t) : isNum(vs) ? vsColor(t, vs) : t.text);
        const tripCons = o && o.lKm > 0.5 ? o.l / o.lKm * 100 : null;
        const rows = [
            ['Üblich warm bei diesem Tempo', isNum(usualNow) ? fmtC(usualNow) + ' ' + CU : 'lernt noch'],
            ['Diese Fahrt', o ? F(o.km, 1) + ' km   ' + L(o.l, 2) + '   ' + fmtC(tripCons) + ' ' + CU + '   ' + eur(o.l) : '--'],
            ['Reichweite so', isNum(v.tank) && isNum(cons) && cons > 1 ? F(v.tank / cons * 100, 0) + ' km' + (isNum(v.range) ? '   (Bordcomputer ' + F(v.range, 0) + ')' : '') : '--'],
            ['Außen   Modus', fmtT(v.amb) + '   ' + modeText(v.mode)],
        ];
        rows.forEach((x, i) => U.row(cv, t, p.x + 24, p.w - 48, p.y + 300 + i * 42, x[0], x[1]));
        const rr = G.panel(cv, t, 808, 44, 768, 468, o ? 'Diese Fahrt, je km' : 'Fahrt');
        const al = along(r.slices, r.coach), runs = [];
        al.own.forEach((q) => {
            const last = runs[runs.length - 1];
            if (!last || last.cold !== q[2]) runs.push({ cold: q[2], pts: last ? [last.pts[last.pts.length - 1]] : [] });
            runs[runs.length - 1].pts.push([q[0], q[1]]);
        });
        const ys = al.own.map((q) => q[1]).concat(al.usual.map((q) => q[1])).filter(isNum);
        U.chart(cv, t, rr.x + 16, rr.y + 60, rr.w - 32, rr.h - 76, {
            xMin: 0, xMax: Math.max(5, Math.ceil(al.own.length ? al.own[al.own.length - 1][0] : 5)), yMin: 0, yMax: ys.length ? Math.ceil(Math.max.apply(null, ys) / 5) * 5 + 2 : 20,
            xUnit: 'km', yUnit: CU, series: [{ pts: al.usual, color: t.dim, width: 2, dash: true }].concat(runs.map((x) => ({ pts: x.pts, color: x.cold ? coldCol(t) : U.GO, width: 3, fill: 0.12 }))),
            empty: o ? 'Der erste km' : 'Losfahren: wird von selbst aufgezeichnet',
        });
        [['warm', U.GO, 4], ['kalt', coldCol(t), 4], ['üblich warm', t.dim, 2]].forEach((l, i) => {
            cv.fillRect(rr.x + 380 + i * 120, rr.y + 32 + (4 - l[2]) / 2, 26, l[2], l[1]); cv.text(l[0], rr.x + 414 + i * 120, rr.y + 40, 18, t.dim);
        });
    }

    function drawSpeed(cv, t, v) {
        const b = v.st.bins, c = v.r.coach;
        const p = G.panel(cv, t, 24, 44, 1552, 468, 'Verbrauch nach Tempo (km/h), Motor warm');
        const vals = b.speed.map((x) => c.cons(x));
        const tot = b.speed.reduce((a, x) => ({ km: a.km + x.km, l: a.l + x.l }), { km: 0, l: 0 });
        const avg = tot.km > 2 ? tot.l / tot.km * 100 : null;
        U.bars(cv, t, p.x + 24, p.y + 50, 1100, p.h - 70, b.speed.map((x, i) => ({ label: SPEED_LABELS[i], value: vals[i], text: fmtC(vals[i]),
            sub: x.km >= 1 ? F(x.km, 0, true) + ' km' : '', color: i >= 5 ? 'warn' : i <= 1 ? 'cold' : U.GO })), { mark: avg });
        // out of town (from 90 km/h up): the biggest step between two speed bands with enough driven, what going one
        // band slower saves (in town the speed is not the choice)
        let best = null;
        for (let i = vals.length - 1; i >= 4; i--) if (isNum(vals[i]) && isNum(vals[i - 1]) && vals[i] > vals[i - 1] && (!best || vals[i] - vals[i - 1] > best.d)) best = { i, d: vals[i] - vals[i - 1] };
        const x = p.x + 1160, w = p.w - 1160 - 24;
        cv.text(CU, x, p.y + 92, 20, t.dim, { font: 'bold' });
        const text = best ? 'Bei ' + SPEED_LABELS[best.i] + ' km/h braucht dein Auto ' + fmtC(vals[best.i]) + ', bei ' + SPEED_LABELS[best.i - 1] + ' km/h ' + fmtC(vals[best.i - 1]) + ' ' + CU
            + '. Eine Stufe langsamer spart ' + F(best.d, 1) + ' l und ' + F(best.d * price(), 2) + ' € je 100 km.'
            : 'Jeder Balken füllt sich, sobald du 2 km in diesem Tempo mit warmem Motor gefahren bist.';
        U.wrap(cv, text, 22, w, {}, 6).forEach((l, k) => cv.text(l, x, p.y + 140 + k * 32, 22, t.text));
        const idle = c.idle();
        ['Linie: dein Schnitt ' + fmtC(avg) + ' ' + CU, isNum(idle) ? 'Im Stand (Leerlauf): ' + F(idle, 2) + ' l/h' : '', 'Kalter Motor: Seite Kaltstart'].filter((l) => l)
            .forEach((l, k) => cv.text(l, x, p.y + 352 + k * 32, 20, t.dim));
    }

    /** Each condition against what the car usually takes warm at the speeds it was driven in it: 0 = as usual. */
    function drawCond(cv, t, v) {
        const b = v.st.bins, c = v.r.coach;
        const item = (label, bin) => { const x = c.vs(bin); return { label, value: x, text: pct(x), sub: bin && bin.km >= 1 ? F(bin.km, 0, true) + ' km' : '' }; };
        const p = G.panel(cv, t, 24, 44, 900, 468, 'Außentemperatur (' + tU() + '): gegen üblich bei gleichem Tempo');
        const tl = settings.get('tempUnit') === 'f' ? ['< 32', '32-50', '50-68', '68-86', '86+'] : TEMP_LABELS;
        const q = G.panel(cv, t, 948, 44, 628, 468, 'Fahrmodus und Klima: gegen üblich');
        const ms = ['eco', 'comfort', 'sport'].concat(b.mode.adaptive && b.mode.adaptive.km >= 2 ? ['adaptive'] : []);
        const left = b.temp.map((x, i) => item(tl[i], x)), right = ms.map((m) => item(MODE_LABEL[m], b.mode[m])).concat([item('Klima an', b.climate.on), item('Klima aus', b.climate.off)]);
        // one scale for both: a bar as tall means as much
        const max = Math.max(0.1, Math.max.apply(null, left.concat(right).map((x) => (isNum(x.value) ? Math.abs(x.value) : 0))) * 1.1);
        U.devBars(cv, t, p.x + 24, p.y + 50, p.w - 48, p.h - 70, left, { max });
        U.devBars(cv, t, q.x + 24, q.y + 50, q.w - 48, q.h - 70, right, { max });
    }

    function drawCold(cv, t, v) {
        const s = coldStats(v.st.trips), ms = months(v.st, 6), cur = ms[ms.length - 1];
        const p = G.panel(cv, t, 24, 44, 760, 468, 'Kaltstarts: Kühlmittel unter ' + COLD_C + ' °C');
        if (!s.starts) {
            U.note(cv, t, p.x, p.y, p.w, p.h, v.link ? 'Noch kein Kaltstart aufgezeichnet' : 'Warte auf das Motorsteuergerät');
        } else {
            U.big(cv, t, p.x + 24, p.y + 160, pct(s.share), 'mehr als warm', 110, coldCol(t));
            cv.text(isNum(s.share) ? 'Sprit, solange der Motor kalt ist, gegen warm bei gleichem Tempo' : 'Der Vergleich kommt, sobald dein Auto warm gelernt ist', p.x + 24, p.y + 200, 20, t.dim);
            const rows = [
                ['Mehr je Kaltstart', isNum(s.extra) ? sL(s.extra, 2) + '   ' + eur(s.extra) : 'lernt noch'],
                ['Bis der Motor warm ist', isNum(s.warmMin) ? F(s.warmMin, 0) + ' min' + (isNum(s.warmKm) ? '   ' + F(s.warmKm, 1) + ' km' : '') : '--'],
                ['Nie warm geworden', s.never + ' von ' + s.starts + ' Kaltstarts'],
                ['Diesen Monat', cur.coldStarts + ' Kaltstarts   ' + sL(cur.extra, 1) + '   ' + eur(cur.extra)],
            ];
            rows.forEach((x, i) => U.row(cv, t, p.x + 24, p.w - 48, p.y + 270 + i * 44, x[0], x[1], i === 2 && s.never > s.starts / 3 ? t.warn : null));
        }
        const q = G.panel(cv, t, 808, 44, 768, 468, 'Kaltstart-Kosten je Monat (' + F(price(), 2) + ' €/l)');
        U.bars(cv, t, q.x + 24, q.y + 50, q.w - 48, q.h - 70, ms.map((m) => ({ label: m.label, value: m.coldStarts ? Math.max(0, m.extra * price()) : null,
            text: eur(m.extra), sub: m.coldStarts ? m.coldStarts + ' Starts' : '', color: coldCol(t) })));
    }

    function drawTrips(cv, t, v) {
        const list = v.st.trips.slice().reverse();
        const tot = list.reduce((a, s) => ({ km: a.km + s.km, l: a.l + s.l, lKm: a.lKm + (s.lKm || 0) }), { km: 0, l: 0, lKm: 0 });
        const p = G.panel(cv, t, 24, 44, 1552, 468, list.length ? list.length + ' Fahrten   ' + F(tot.km, 0, true) + ' km   ' + L(tot.l, 0) + '   '
            + fmtC(tot.lKm > 0 ? tot.l / tot.lKm * 100 : null) + ' ' + CU + '   ' + eur(tot.l) : 'Fahrten');
        const rows = Math.floor((p.h - 100) / 40);
        G.table(cv, t, p.x + 24, p.y + 64, p.w - 48, [{ label: 'Wann', w: 180 }, { label: 'Strecke', w: 150, align: 'right' }, { label: 'Sprit', w: 130, align: 'right' },
            { label: CU, w: 170, align: 'right' }, { label: 'Kosten', w: 140, align: 'right' }, { label: 'Schnitt', w: 150, align: 'right' },
            { label: 'Außen', w: 120, align: 'right' }, { label: 'Kaltstart', w: 230, align: 'right' }, { label: 'Gegen üblich', w: 190, align: 'right' }],
        list.slice(0, rows).map((s) => [C.when(s.t0), F(s.km, 1) + ' km', L(s.l, 2), fmtC(s.cons), eur(s.l), isNum(s.v) ? F(s.v, 0) + ' km/h' : '--', fmtT(s.amb),
            { text: s.coldStart ? (isNum(s.extra) ? sL(s.extra, 2) : 'ja') + (isNum(s.warmMin) ? '' : ', nie warm') : s.coldStart === false ? 'warm' : '--', color: s.coldStart ? coldCol(t) : null },
            { text: isNum(s.vs) ? pct(s.vs) : s.coldStart && !isNum(s.warmMin) ? 'nur kalt' : 'lernt noch', color: vsColor(t, s.vs) }]),
        { rowH: 40, size: 22, empty: 'Noch keine Fahrt aufgezeichnet' });
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'now') drawNow(cv, t, v);
        else if (p === 'speed') drawSpeed(cv, t, v);
        else if (p === 'cond') drawCond(cv, t, v);
        else if (p === 'cold') drawCold(cv, t, v);
        else if (p === 'trips') drawTrips(cv, t, v);
        else {
            const l = eng.live, n = eng.now;
            U.diagPage(cv, t, eng.dme, l, [['Verbrauch jetzt', isNum(n.lph) ? F(n.lph, 2) + ' l/h' + (n.src ? ' (' + n.src + ')' : '') : '--'],
                ['Einspritzzähler', isNum(l.inj) ? String(l.inj) + '   Faktor ' + (eng.flow.k ? F(eng.flow.k * 1e6, 3) : 'lernt noch') : '--'],
                ['Kühlmittel', fmtT(v.coolant)], ['Tank / Reichweite', F(l.tank, 0) + ' l / ' + F(l.range, 0) + ' km'], ['Tempo', F(l.speed, 1) + ' km/h'],
                ['Fahrmodus / Klima', (l.modeRaw == null ? '--' : String(l.modeRaw)) + ' / ' + (l.climate == null ? '--' : l.climate ? 'an' : 'aus')],
                ['Fahrzeugzustand', isNum(l.cond) ? String(l.cond) : '--']]);
        }
        const cold = v.running && isNum(v.coolant) && v.coolant < COLD_C;
        pg.header(cv, t, [U.demoBadge(v.demo), cold && { text: 'MOTOR KALT', color: coldCol(t) }]);
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
