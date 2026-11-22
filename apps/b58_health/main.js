'use strict';
/**
 * Motor-Check - how the B58 is doing over weeks and months.
 *
 *   - snapshots: with a warm engine (coolant 80 °C, oil 75 °C), standing at idle for 15 s or cruising steadily, at most
 *     every few hours (setting), the engine unit's values that move slowly are read once (lib/lib_dme.js): oil
 *     pressure, level and condition, fuel in the oil, mixture and injector corrections, knock adaptation, misfire and
 *     rough-running counters, spark plugs.
 *   - drives: from each engine start, the warm-up (minutes to 80 °C coolant after a cold start) and how warm the oil
 *     got (short trips with cold oil), from the car's own signals only.
 *   - health.js judges them: ok, watch, have it checked; the trends against this engine's own earlier values.
 *   - nothing is read while the engine is off, or the car locked and left. Read only.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { UdsReader } = require('./lib_uds');
const { DME, dmeConfig, CYLINDERS, names } = require('./lib_dme');
const { watchCar, OIL_LEVEL_LABEL } = require('./lib_signals');
const C = require('./lib_core');
const U = require('./lib_ui');
const { rng } = require('./lib_demo');
const { evaluate } = require('./health');

const { isNum } = C;
const W = 1600, H = 520;
const MAX_SNAPS = 500, MAX_DRIVES = 300;
const NAMES = { over: 'Übersicht', cyl: 'Zylinder', oil: 'Öl', hist: 'Verlauf', diag: 'Diagnose' };
const STATE = { ok: ['OK', 'go'], watch: ['BEOBACHTEN', 'warn'], check: ['PRÜFEN', 'crit'], none: ['NOCH KEINE DATEN', 'dim'] };
// read once per snapshot (rough running only at idle, where it means something)
const SNAP = ['oilPress', 'ambientP', 'oilTemp', 'coolant', 'rpm', 'oilLevel', 'oilLevelMm', 'fuelInOil', 'oilKm', 'plugsLeft', 'plugsKm',
    'engineHours', 'ltft', 'stft', 'mixAdapt', 'injMean', 'knockAdapt', 'battV'].concat(names('misfire'), names('inj'));

function engine(env) {
    const { log, settings, spec } = env;
    const store = new C.Store(env.dataDir, 'health.json', { snaps: [], drives: [], open: null, pick: {} }, log);
    const st = store.data;
    const dme = new UdsReader(env.signals, log, dmeConfig(spec.config && spec.config.dme), DME);
    dme.usePick(st.pick);
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'engine', 'tank', 'oil']);
    let visible = false, stopped = false, wake = null, busy = false, standSince = 0, steadySince = 0, lastSpeed = null, offSince = 0, forced = false;
    const status = { text: '', t: 0 };
    const say = (text) => { status.text = text; status.t = Date.now(); };

    /* ---------- drives: warm-up and oil temperature, from the car's own signals ---------- */
    function trackDrive(t) {
        const on = live.engineOn(), o = st.open;
        if (on) {
            offSince = 0;
            if (!o) {
                st.open = { t0: t, startCoolant: live.coolant, ambient: live.ambient, oilMax: live.oil, warmMin: null, odo0: live.odo };
                store.save(false, 60000);
                return;
            }
            if (isNum(live.oil)) o.oilMax = Math.max(isNum(o.oilMax) ? o.oilMax : -40, live.oil);
            if (!isNum(o.startCoolant) && isNum(live.coolant)) o.startCoolant = live.coolant;
            if (o.warmMin === null && isNum(o.startCoolant) && o.startCoolant < 35 && isNum(live.coolant) && live.coolant >= 80) {
                o.warmMin = (t - o.t0) / 60000;
                log.info('warm after ' + o.warmMin.toFixed(1) + ' min (from ' + o.startCoolant + ' °C, outside ' + live.ambient + ' °C)');
            }
            o.t1 = t; o.odo1 = live.odo;
        } else if (o) {
            if (!offSince) offSince = t;
            // off for 2 minutes (start-stop at the lights is shorter), or nothing heard for 10 (the head unit slept)
            if (t - offSince > 120000 || t - (o.t1 || o.t0) > 600000) {
                st.open = null;
                const km = isNum(o.odo0) && isNum(o.odo1) ? o.odo1 - o.odo0 : null;
                if ((o.t1 || o.t0) - o.t0 > 60000) {
                    st.drives.push({ t0: o.t0, t1: o.t1 || o.t0, km, startCoolant: o.startCoolant, ambient: o.ambient, oilMax: o.oilMax, warmMin: o.warmMin });
                    if (st.drives.length > MAX_DRIVES) st.drives.splice(0, st.drives.length - MAX_DRIVES);
                }
                store.save(true);
            }
        }
    }

    /* ---------- snapshots ---------- */
    /** 'idle' / 'cruise' when the engine is warm and the car stands at idle for 15 s or cruises steadily for 20 s, else null. */
    function conditions(t) {
        const v = live.speed;
        if (isNum(v) && v < 1) { if (!standSince) standSince = t; } else standSince = 0;
        if (isNum(v) && v > 40 && v < 130 && isNum(lastSpeed) && Math.abs(v - lastSpeed) < 3) { if (!steadySince) steadySince = t; } else steadySince = 0;
        lastSpeed = v;
        if (!live.engineOn() || !(live.coolant >= 80) || !(live.oil >= 75)) return null;
        if (standSince && t - standSince > 15000 && !(live.rpm > 1000)) return 'idle';
        if (steadySince && t - steadySince > 20000 && live.rpm > 1200 && live.rpm < 2800) return 'cruise';
        return null;
    }
    async function snapshot(kind) {
        busy = true;
        say('Messung läuft ...');
        const t = Date.now(), s = { t, kind, odo: live.odo, ambient: live.ambient, dipstick: live.oilLevel };
        try {
            for (const n of SNAP.concat(kind === 'idle' ? names('rough') : [])) {
                s[n] = await dme.value(n);
                if (stopped) return;
            }
            const life = await dme.group('oilLife');
            if (life) { s.oilLifeH = life.hours; s.oilLifeF = life.fuel; }
            // still the same conditions at the end? else it was not a clean idle / cruise
            if (conditions(Date.now()) !== kind) s.kind = 'mixed';
            const got = SNAP.filter((n) => isNum(s[n])).length;
            if (!got) { say('Keine Antwort vom Motorsteuergerät'); log.warn('snapshot: no values'); return; }
            st.snaps.push(s);
            if (st.snaps.length > MAX_SNAPS) st.snaps.splice(0, st.snaps.length - MAX_SNAPS);
            st.pick = dme.pick;
            store.save(true);
            say('Gemessen: ' + got + ' Werte (' + (s.kind === 'idle' ? 'Leerlauf' : s.kind === 'cruise' ? 'Fahrt' : 'gemischt') + ')');
            log.info('snapshot ' + s.kind + ': ' + got + ' values');
        } catch (e) { log.warn('snapshot: ' + (e && e.message || e)); } finally { busy = false; }
    }

    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await dme.init();
        while (!stopped) {
            try {
                const t = Date.now();
                trackDrive(t);
                const kind = conditions(t), last = st.snaps[st.snaps.length - 1];
                const due = !last || t - last.t > (settings.get('every') || 6) * 3600000 || forced;
                const lastIdle = st.snaps.filter((s) => s.kind === 'idle').pop();
                // a cruise snapshot only when there was no idle one for a day (idle values compare best)
                const take = kind === 'idle' || (kind === 'cruise' && (!lastIdle || t - lastIdle.t > 86400000));
                if (!demoOn() && dme.available && !live.left() && !busy && due && take) { forced = false; await snapshot(kind); }
                else if (forced && !kind) say('Messen geht nur bei warmem Motor: im Stand mit Motor an, oder gleichmäßig fahrend');
            } catch (e) { log.warn('loop: ' + (e && e.message || e)); }
            await sleep(2000);
        }
    }

    /* ---------- demo: 90 days of an M340i, cylinder 4 starting to misfire ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !dme.available && !st.snaps.length);
    function demoData() {
        if (demo) return demo;
        const r = rng(17), now = Date.now(), snaps = [], drives = [], mis = [0, 0, 0, 0, 0, 0];
        let odo = 41210, level = 0.95, fio = 25, t = now - 90 * 86400000;
        for (let d = 0; d < 90; d++) {
            t = now - (90 - d) * 86400000 + 8 * 3600000;
            const amb = 4 + 10 * Math.sin(d / 90 * Math.PI) + (r() - 0.5) * 4, short = r() < 0.35;
            const km = short ? 3 + r() * 5 : 25 + r() * 60;
            drives.push({ t0: t, t1: t + km / 50 * 3600000, km, startCoolant: amb + 2, ambient: amb, oilMax: short ? 45 + r() * 20 : 95 + r() * 10,
                warmMin: short ? null : 6 + (12 - amb) * 0.25 + r() * 1.5 });
            odo += km;
            level -= km * 0.00028;
            if (level < 0.2) level += 0.75;                       // a top-up
            fio = short ? Math.min(140, fio + 6 + r() * 5) : Math.max(15, fio - 10 - r() * 6);
            if (d % 2 === 0) {
                for (let c = 0; c < 6; c++) mis[c] += c === 3 && d > 70 ? Math.round(r() * 6) + 1 : r() < 0.02 ? 1 : 0;
                const s = { t: t + 1800000, kind: r() < 0.8 ? 'idle' : 'cruise', odo: Math.round(odo), ambient: amb, dipstick: level > 0.8 ? 5 : level > 0.5 ? 4 : 3,
                    oilPress: 2.05 + (r() - 0.5) * 0.1, ambientP: 0.98, oilTemp: 92 + r() * 8, coolant: 88 + r() * 4, rpm: 640 + r() * 30,
                    oilLevel: Math.round(level * 100) / 100, oilLevelMm: level * 40, fuelInOil: Math.round(fio), oilKm: Math.round(odo - 38000),
                    plugsLeft: 52000 - (odo - 38000) * 1.1, plugsKm: Math.round(odo - 38000), engineHours: 1180 + d * 0.8,
                    ltft: 1.5 + (r() - 0.5) * 2, stft: (r() - 0.5) * 4, mixAdapt: 1.01 + (r() - 0.5) * 0.02, injMean: 1.0, knockAdapt: -0.6 - r() * 0.8, battV: 14.3,
                    oilLifeH: 70 - d * 0.3, oilLifeF: 72 - d * 0.3 };
                for (let c = 1; c <= 6; c++) {
                    s['misfire' + c] = mis[c - 1];
                    s['inj' + c] = 1 + (c === 2 ? 0.025 : 0) + (r() - 0.5) * 0.01;
                    if (s.kind === 'idle') s['rough' + c] = (c === 4 && d > 70 ? 14 : 4) + r() * 3;
                }
                snaps.push(s);
            }
        }
        demo = { snaps, drives };
        return demo;
    }

    loop();
    return {
        ok: true, dme, live, status,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        measure() { forced = true; if (wake) wake(); },
        view() {
            const d = demoOn() ? demoData() : st;
            return { demo: demoOn(), snaps: d.snaps, drives: d.drives, open: demoOn() ? null : st.open, link: dme.available, busy };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['over', 'cyl', 'oil', 'hist'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    const tU = () => (settings.get('tempUnit') === 'f' ? '°F' : '°C');
    const fmtT = (c) => (isNum(c) ? F(C.temp(c, settings.get('tempUnit')), 0) + ' ' + tU() : '--');
    const col = (t, k) => (k === 'go' ? U.GO : t[k] || t.text);
    let cache = null, cacheT = 0, scroll = 0;
    /** health.js's verdict, worked out at most every 2 s (the screen draws up to 60 times a second). */
    const verdict = (v) => {
        if (!cache || Date.now() - cacheT > 2000 || cache.n !== v.snaps.length || cache.demo !== v.demo) {
            cache = { n: v.snaps.length, demo: v.demo, r: evaluate(v.snaps, v.drives, { oilWarn: settings.get('oilWarn'), cylinders: CYLINDERS }) };
            cacheT = Date.now();
        }
        return cache.r;
    };
    ui.onClick('BTN_ACT', () => { eng.measure(); return render(); });
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    ctx.onScroll((dy) => {
        if (pg.page() !== 'hist') return false;
        const before = scroll;
        scroll = Math.max(0, scroll + (dy > 0 ? 1 : -1));
        return scroll !== before;
    });

    function drawOver(cv, t, v) {
        const r = verdict(v), cw = (1552 - 2 * 24) / 3, ch = 226;
        r.cards.forEach((c, i) => {
            const x = 24 + (i % 3) * (cw + 24), y = 44 + Math.floor(i / 3) * (ch + 16);
            const p = G.panel(cv, t, x, y, cw, ch, c.title), s = STATE[c.state];
            U.tag(cv, t, p.x + p.w - 24 - cv.textWidth(s[0], 20, { font: 'bold', spacing: 1.2 }) - 18, p.y + 42, s[0], col(t, s[1]), 20);
            cv.text(c.value, p.x + 20, p.y + 112, 44, c.state === 'none' ? t.dim : t.text, { font: 'bold' });
            U.wrap(cv, c.note, 20, p.w - 40, null, 3).forEach((l, k) => cv.text(l, p.x + 20, p.y + 152 + k * 26, 20, t.dim));
        });
    }

    function drawCyl(cv, t, v) {
        const r = verdict(v);
        const p = G.panel(cv, t, 24, 44, 1552, 468, 'Zylinder 1 bis 6 (Zündfolge 1-5-3-6-2-4)');
        const cols = [{ label: '', w: 380 }].concat(r.cyl.map((x) => ({ label: 'Zyl. ' + x.n, w: 180, align: 'right' })));
        const misColor = (x) => (x.misDrives >= 3 || x.misfires >= 50 ? 'crit' : x.misfires > 0 ? 'warn' : null);
        const injColor = (x) => (isNum(x.injDev) && Math.abs(x.injDev) > 0.08 ? 'crit' : isNum(x.injDev) && Math.abs(x.injDev) > 0.05 ? 'warn' : null);
        const rows = [
            ['Fehlzündungen, 30 Tage'].concat(r.cyl.map((x) => ({ text: isNum(x.misfires) ? String(x.misfires) : '--', color: misColor(x) }))),
            ['bei Messungen'].concat(r.cyl.map((x) => ({ text: isNum(x.misfires) ? String(x.misDrives) : '--', color: misColor(x) }))),
            ['Laufunruhe Leerlauf (rad/s²)'].concat(r.cyl.map((x) => F(x.rough, 1))),
            ['Injektor-Korrektur'].concat(r.cyl.map((x) => ({ text: isNum(x.inj) ? F(x.inj, 3) : '--', color: injColor(x) }))),
            ['Abweichung vom Mittel'].concat(r.cyl.map((x) => ({ text: isNum(x.injDev) ? (x.injDev > 0 ? '+' : '') + F(x.injDev * 100, 1) + ' %' : '--', color: injColor(x) }))),
        ];
        G.table(cv, t, p.x + 24, p.y + 70, p.w - 48, cols, rows, { rowH: 52, size: 26 });
        const card = r.cards.find((c) => c.id === 'cyl'), s = STATE[card.state];
        U.tag(cv, t, p.x + 24, p.y + 400, s[0], col(t, s[1]), 22);
        cv.text(card.note, p.x + 60 + cv.textWidth(s[0], 22, { font: 'bold', spacing: 1.2 }), p.y + 400, 22, t.text);
        cv.text('Fehlzündungen wandern mit der Zündspule? Spulen zweier Zylinder tauschen und beobachten.', p.x + 24, p.y + 440, 18, t.dim);
    }

    function drawOil(cv, t, v) {
        const r = verdict(v), use = r.oil.use, last = v.snaps[v.snaps.length - 1];
        const p = G.panel(cv, t, 24, 44, 900, 468, 'Ölstand über Minimum (l) über dem Kilometerstand');
        const pts = v.snaps.filter((s) => isNum(s.oilLevel) && isNum(s.odo)).map((s) => [s.odo, s.oilLevel]);
        const x0 = pts.length ? pts[0][0] : 0, x1 = pts.length ? Math.max(x0 + 100, pts[pts.length - 1][0]) : 1000;
        const fit = [];
        if (isNum(use.perKm) && use.seg.length) {
            const a = use.seg[0], b = use.seg[use.seg.length - 1];
            const my = use.seg.reduce((s, q) => s + q[1], 0) / use.seg.length, mx = use.seg.reduce((s, q) => s + q[0], 0) / use.seg.length;
            fit.push([a[0], my - use.perKm * (a[0] - mx)], [b[0], my - use.perKm * (b[0] - mx)]);
        }
        U.chart(cv, t, p.x + 16, p.y + 60, p.w - 32, p.h - 76, {
            xMin: x0, xMax: x1, xStep: Math.max(500, Math.ceil((x1 - x0) / 5 / 500) * 500), xFmt: (x) => F(x / 1000, 1) + ' tkm', yMin: 0, yMax: 1.2, yStep: 0.2, yUnit: 'l',
            series: [{ pts: fit, color: t.warn, width: 2, dash: true }, { pts, color: U.GO, width: 3 }],
            empty: 'Noch keine Messung mit Ölstand',
        });
        const q = G.panel(cv, t, 948, 44, 628, 468, 'Öl');
        const rows = [
            ['Verbrauch', isNum(r.oil.per1000) ? F(r.oil.per1000, 2) + ' l/1000 km' : 'misst noch (' + F(use.km, 0) + ' von 800 km)'],
            ['Ölstand (Auto)', last && isNum(last.dipstick) ? OIL_LEVEL_LABEL[last.dipstick] : '--'],
            ['Über Minimum', last && isNum(last.oilLevel) ? F(last.oilLevel, 2) + ' l' : '--'],
            ['Kraftstoff im Öl', isNum(r.oil.fuelInOil) ? F(r.oil.fuelInOil, 0) + ' g' : '--'],
            ['Öldruck warm, Leerlauf', isNum(r.oil.press) ? F(r.oil.press, 2) + ' bar' + (isNum(r.oil.pressBase) ? '  (üblich ' + F(r.oil.pressBase, 2) + ')' : '') : '--'],
            ['Seit Ölwechsel', last && isNum(last.oilKm) ? F(last.oilKm, 0, true) + ' km' : '--'],
            ['Öl-Restlebensdauer', last && isNum(last.oilLifeH) ? F(Math.min(last.oilLifeH, last.oilLifeF || 999), 0) + ' %' : '--'],
            ['Öltemperatur (letzte)', last ? fmtT(last.oilTemp) : '--'],
        ];
        rows.forEach((x, i) => U.row(cv, t, q.x + 24, q.w - 48, q.y + 92 + i * 46, x[0], x[1]));
    }

    function drawHist(cv, t, v) {
        const list = v.snaps.slice().reverse();
        const p = G.panel(cv, t, 24, 44, 1552, 468, list.length ? list.length + ' Messungen' : 'Messungen');
        const rows = Math.floor((p.h - 100) / 40);
        scroll = Math.min(scroll, Math.max(0, list.length - rows));
        const deltas = {};
        for (let i = 1; i < v.snaps.length; i++) {
            let d = 0;
            for (let c = 1; c <= CYLINDERS; c++) {
                const a = v.snaps[i - 1]['misfire' + c], b = v.snaps[i]['misfire' + c];
                if (isNum(b)) d += !isNum(a) || b < a ? b : b - a;
            }
            deltas[v.snaps[i].t] = d;
        }
        G.table(cv, t, p.x + 24, p.y + 64, p.w - 48, [{ label: 'Wann', w: 180 }, { label: 'km-Stand', w: 150, align: 'right' }, { label: 'Art', w: 150, align: 'right' },
            { label: 'Öl', w: 120, align: 'right' }, { label: 'Öldruck', w: 140, align: 'right' }, { label: 'Ölstand', w: 140, align: 'right' },
            { label: 'Kraftst. im Öl', w: 170, align: 'right' }, { label: 'Gemisch', w: 140, align: 'right' }, { label: 'Klopfadapt.', w: 150, align: 'right' },
            { label: 'Fehlz.', w: 110, align: 'right' }],
        list.slice(scroll, scroll + rows).map((s) => [C.when(s.t), isNum(s.odo) ? F(s.odo, 0, true) : '--', s.kind === 'idle' ? 'Leerlauf' : s.kind === 'cruise' ? 'Fahrt' : 'gemischt',
            fmtT(s.oilTemp), isNum(s.oilPress) && isNum(s.ambientP) ? F(s.oilPress - s.ambientP, 2) + ' bar' : '--', isNum(s.oilLevel) ? '+' + F(s.oilLevel, 2) + ' l' : '--',
            isNum(s.fuelInOil) ? F(s.fuelInOil, 0) + ' g' : '--', isNum(s.ltft) ? (s.ltft > 0 ? '+' : '') + F(s.ltft, 1) + ' %' : '--', isNum(s.knockAdapt) ? F(s.knockAdapt, 1) + '°' : '--',
            { text: isNum(deltas[s.t]) ? String(deltas[s.t]) : '--', color: deltas[s.t] > 0 ? 'warn' : null }]),
        { rowH: 40, size: 22, empty: 'Noch keine Messung: bei warmem Motor im Stand oder bei gleichmäßiger Fahrt wird von selbst gemessen' });
        cv.scroll = { y: p.y + 94 };
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'over') drawOver(cv, t, v);
        else if (p === 'cyl') drawCyl(cv, t, v);
        else if (p === 'oil') drawOil(cv, t, v);
        else if (p === 'hist') drawHist(cv, t, v);
        else U.diagPage(cv, t, eng.dme, eng.live, [['Motor läuft', eng.live.engineOn() ? 'ja' : 'nein'], ['Kühlmittel / Öl', fmtT(eng.live.coolant) + ' / ' + fmtT(eng.live.oil)],
            ['Tempo', F(eng.live.speed, 1) + ' km/h'], ['km-Stand', F(eng.live.odo, 0, true)], ['Fahrzeugzustand', isNum(eng.live.cond) ? String(eng.live.cond) : '--'], ['Status', eng.status.text || '--']]);
        const o = verdict(v).overall, s = STATE[o];
        pg.header(cv, t, [U.demoBadge(v.demo), v.busy && { text: 'MISST', color: t.accent }, o !== 'none' && { text: s[0], color: col(t, s[1]) }]);
        if (eng.status.text && Date.now() - eng.status.t < 8000 && p !== 'diag') cv.text(eng.status.text, 1576, 512, 18, t.dim, { align: 'right' });
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
