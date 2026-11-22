'use strict';
/**
 * Pull-Check - every full-throttle pull, checked.
 *
 *   - a pull: the accelerator pedal at the setting (90 %) or more (else the sport display's power at 85 %), from
 *     1800 rpm and 15 km/h, until the pedal comes back, the gearbox shifts up (the engine speed falls) or 15 s pass;
 *     kept when it lasted 2.5 s over 1500 rpm or more.
 *   - while it lasts: the car's own signals ten times a second (engine speed, speed, acceleration, pedal), and the engine
 *     unit's values as fast as it answers, in turn (lib/lib_dme.js): boost target and actual, knock retard, rail pressure
 *     target and actual, intake air, lambda target and actual. Nothing is read between pulls.
 *   - pull.js judges it; the power at the wheels comes from the acceleration and speed (lib/lib_phys.js, the car's
 *     weight from the settings), against a reference pull in the same gear (pinned, else the strongest one before).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { UdsReader } = require('./lib_uds');
const { DME, dmeConfig } = require('./lib_dme');
const { watchCar } = require('./lib_signals');
const { CAR, PS } = require('./lib_phys');
const C = require('./lib_core');
const U = require('./lib_ui');
const { demoPull } = require('./lib_demo');
const { analyze, versus } = require('./pull');

const { isNum } = C;
const W = 1600, H = 520;
const KEEP = 40, MAX_MS = 15000;
const NAMES = { last: 'Pull', hist: 'Verlauf', diag: 'Diagnose' };
const STATE = { ok: ['OK', 'go'], watch: ['BEOBACHTEN', 'warn'], check: ['PRÜFEN', 'crit'], none: ['KEINE WERTE', 'dim'] };
// the engine unit's channels, in turn; boost twice as often (it is what most often goes wrong)
const CHANNELS = ['boostAct', 'boostTarget', 'knockRetard', 'railAct', 'boostAct', 'boostTarget', 'iat', 'lambda', 'railTarget', 'knockRetard', 'lambdaTarget'];

/** A finished pull: its samples, kept small (at most 150 of each kind), and when / where it happened. */
function keep(p) {
    const thin = (xs) => (xs.length <= 150 ? xs : xs.filter((x, i) => i % Math.ceil(xs.length / 150) === 0));
    return { id: p.t0, t0: p.t0, ambient: p.ambient, fast: thin(p.fast), dme: thin(p.dme) };
}

function engine(env) {
    const { log, settings, spec } = env;
    const store = new C.Store(env.dataDir, 'pulls.json', { pulls: [], refs: {}, pick: {} }, log);
    const st = store.data;
    const dme = new UdsReader(env.signals, log, dmeConfig(spec.config && spec.config.dme), DME);
    dme.usePick(st.pick);
    const live = watchCar(env.signals, log, ['speed', 'env', 'cond', 'engine', 'pedal', 'fes', 'accel']);
    let cur = null, lowSince = 0, maxRpm = 0, stopped = false, timer = null;

    const full = () => (isNum(live.pedal) && Date.now() - live.pedalT < 2000 ? live.pedal >= (settings.get('trigger') || 90) : isNum(live.power) && live.power >= 85);
    async function readDme(p) {
        let k = 0;
        while (cur === p) {
            const n = CHANNELS[k++ % CHANNELS.length];
            const v = await dme.value(n, true);
            if (cur !== p) break;
            if (isNum(v)) p.dme.push({ t: Date.now(), n, v, rpm: live.rpm });
            else await new Promise((r) => setTimeout(r, 20));           // (a channel that is not there: on to the next)
        }
    }
    function finish(why) {
        const p = cur;
        cur = null;
        const dur = p.fast.length ? p.fast[p.fast.length - 1].t - p.t0 : 0;
        const rpms = p.fast.map((s) => s.rpm).filter(isNum), span = rpms.length ? Math.max.apply(null, rpms) - Math.min.apply(null, rpms) : 0;
        if (dur < 2500 || span < 1500) { log.info('pull too short (' + dur + ' ms, ' + Math.round(span) + ' rpm): not kept'); return; }
        st.pulls.push(keep(p));
        if (st.pulls.length > KEEP) st.pulls.splice(0, st.pulls.length - KEEP);
        st.pick = dme.pick;
        store.save(true);
        log.info('pull kept: ' + (dur / 1000).toFixed(1) + ' s, ' + Math.round(span) + ' rpm, ' + p.dme.length + ' engine unit readings (' + why + ')');
    }
    function tick() {
        const t = Date.now();
        if (!cur) {
            if (!demoOn() && dme.available && !live.left() && live.engineOn() && full() && live.rpm >= 1800 && live.speed > 15) {
                cur = { t0: t, ambient: live.ambient, fast: [], dme: [] };
                lowSince = 0; maxRpm = 0;
                log.info('pull at ' + Math.round(live.rpm) + ' rpm, ' + Math.round(live.speed) + ' km/h');
                readDme(cur);
            }
            return;
        }
        cur.fast.push({ t, rpm: live.rpm, speed: live.speed, aLong: Date.now() - live.aLongT < 500 ? live.aLong : null, pedal: live.pedal });
        if (isNum(live.rpm)) maxRpm = Math.max(maxRpm, live.rpm);
        if (!full()) { if (!lowSince) lowSince = t; } else lowSince = 0;
        if (lowSince && t - lowSince > 300) finish('pedal released');
        else if (isNum(live.rpm) && maxRpm - live.rpm > 400) finish('shift');
        else if (t - cur.t0 > MAX_MS || !(live.speed > 10)) finish('time');
    }
    dme.init().then(() => { timer = setInterval(tick, 100); });

    /* ---------- demo: five pulls in 3rd gear over the last weeks, one on a hot day, one short of boost ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !dme.available && !st.pulls.length);
    function demoData() {
        if (demo) return demo;
        const now = Date.now(), pulls = [];
        [[30, {}], [21, { retard: 2.2, iatRise: 1, boostLoss: 0.05 }], [12, {}], [5, { boostLoss: 0.18 }], [0.2, {}]].forEach((d, i) => {
            // in the late afternoon of that day (at the latest an hour ago)
            const day = new Date(now - d[0] * 86400000);
            day.setHours(16 + i % 3, 5 + i * 11, 0, 0);
            const s = demoPull(5 + i, d[1]), t0 = Math.min(day.getTime(), now - 3600000 - i * 60000), fast = [], dm = [];
            let k = 0;
            s.forEach((x) => {
                fast.push({ t: t0 + x.t, rpm: x.rpm, speed: x.speed, aLong: x.aLong, pedal: 100 });
                const n = CHANNELS[k++ % CHANNELS.length];
                dm.push({ t: t0 + x.t, n, v: x[n], rpm: x.rpm });
            });
            pulls.push({ id: t0, t0, ambient: d[1].iatRise ? 29 : 12, fast, dme: dm });
        });
        demo = { pulls, refs: {} };
        return demo;
    }

    return {
        ok: true, dme, live,
        active: () => !!cur,
        view() { const d = demoOn() ? demoData() : st; return { demo: demoOn(), pulls: d.pulls, refs: d.refs, link: dme.available }; },
        /** Pin pull id as the reference of its gear (again: unpin). */
        pin(id, gear) {
            const d = demoOn() ? demoData() : st;
            if (!isNum(gear)) return;
            d.refs[gear] = d.refs[gear] === id ? null : id;
            if (!demoOn()) store.save(true);
        },
        stop() { stopped = true; if (timer) clearInterval(timer); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['last', 'hist'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => { labels(); return render(); });
    const col = (t, k) => (k === 'go' ? U.GO : t[k] || t.text);
    const car = () => Object.assign({}, CAR, { mass: settings.get('mass') || CAR.mass });
    const P = (kw) => (settings.get('powerUnit') === 'ps' ? kw * PS : kw), pU = () => (settings.get('powerUnit') === 'ps' ? 'PS' : 'kW');
    let sel = 0;                                   // 0 = the newest pull
    const cache = {};
    const an = (p) => {
        const k = p.id + '|' + settings.get('mass');
        if (!cache[k]) cache[k] = analyze(p, { ambient: p.ambient, car: car() });
        return cache[k];
    };
    const list = (v) => v.pulls.slice().reverse();
    /** The reference of a pull: the pinned one of its gear, else the strongest earlier one in the same gear. */
    function reference(v, p, a) {
        if (!isNum(a.gear)) return null;
        const pinned = v.refs[a.gear], all = v.pulls.filter((x) => x.id !== p.id);
        if (pinned) { const x = all.find((q) => q.id === pinned); if (x) return x; }
        let best = null, bestKw = 0;
        all.filter((x) => x.t0 < p.t0).forEach((x) => { const b = an(x); if (b.gear === a.gear && b.peak && b.peak.kw > bestKw) { bestKw = b.peak.kw; best = x; } });
        return best;
    }
    let actText = '';
    function labels() {
        const v = eng.view(), p = list(v)[sel], a = p ? an(p) : null;
        const txt = p && a && isNum(a.gear) && v.refs[a.gear] === p.id ? 'Referenz lösen' : 'Als Referenz merken';
        if (txt !== actText) { actText = txt; ui.text('BTN_ACT', txt); }
    }
    ui.onClick('BTN_ACT', () => { const v = eng.view(), p = list(v)[sel]; if (p) eng.pin(p.id, an(p).gear); labels(); return render(); });
    ui.onClick('BTN_SEL', () => { const n = list(eng.view()).length; if (n) sel = (sel + 1) % n; labels(); return render(); });
    ctx.onScroll((dy) => {
        if (pg.page() !== 'hist') return false;
        const n = list(eng.view()).length, before = sel;
        sel = G.clamp(sel + (dy > 0 ? 1 : -1), 0, Math.max(0, n - 1));
        return sel !== before;
    });

    function checkText(c) {
        if (c.state === 'none') return c.note;
        if (c.id === 'boost') return c.value > 0.005 ? 'max. ' + F(c.value, 2) + ' bar unter Soll' : 'erreicht den Soll';
        if (c.id === 'knock') return 'im Mittel ' + F(c.value, 1) + '°, max. ' + F(c.max, 1) + '°';
        if (c.id === 'rail') return 'min. ' + F(c.value * 100, 0) + ' % vom Soll';
        if (c.id === 'iat') return '+' + F(c.value, 0) + ' K über außen';
        if (c.id === 'lambda') return 'Lambda max. ' + (c.value > 0.005 ? '+' + F(c.value, 2) + ' über' : F(Math.abs(c.value), 2) + ' unter') + ' Soll';
        return '';
    }

    function drawLast(cv, t, v) {
        const ps = list(v);
        if (sel >= ps.length) sel = 0;
        const p = ps[sel];
        const r = G.panel(cv, t, 24, 44, p ? 700 : 1552, 468, p ? (sel === 0 ? 'Letzter Pull' : 'Pull ' + (sel + 1) + ' von ' + ps.length) : 'Pull');
        if (!p) {
            U.note(cv, t, r.x, r.y, r.w, r.h, (v.link ? 'Noch kein Pull gemessen.' : 'Warte auf das Motorsteuergerät.') + '\n\nEin Pull wird von selbst erkannt: Vollgas ab ' + F(settings.get('trigger') || 90, 0)
                + ' % Pedal, ab 1.800 1/min und 15 km/h,\nam besten im 2. oder 3. Gang bis kurz vor den Begrenzer.\nNur wo es sicher und erlaubt ist.');
            return;
        }
        const a = an(p), ref = reference(v, p, a), ra = ref ? an(ref) : null, vs = versus(a, ra);
        cv.text((isNum(a.gear) ? a.gear + '. Gang   ' : '') + (a.speed ? F(a.speed[0], 0) + '-' + F(a.speed[1], 0) + ' km/h   ' : '') + (a.rpm ? F(a.rpm[0], 0, true) + '-' + F(a.rpm[1], 0, true) + ' 1/min   ' : '') + F(a.dur, 1) + ' s',
            r.x + 24, r.y + 84, 22, t.dim);
        U.big(cv, t, r.x + 24, r.y + 170, a.peak ? F(P(a.peak.kw), 0) : '--', pU() + ' an den Rädern (geschätzt)', 72, t.text);
        cv.text(C.when(p.t0) + (ref ? '   gegen Referenz ' + C.when(ref.t0) + ': ' + (isNum(vs) ? (vs > 0 ? '+' : '') + F(vs * 100, 1) + ' %' : '--') : '   noch keine Referenz in diesem Gang'),
            r.x + 24, r.y + 206, 20, isNum(vs) && vs < -0.05 ? t.warn : t.dim);
        a.checks.forEach((c, i) => {
            const y = r.y + 256 + i * 42, s = STATE[c.state];
            cv.text(c.label.toUpperCase(), r.x + 24, y, 20, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(checkText(c), r.x + 220, y, 22, c.state === 'none' ? t.dim : t.text);
            U.tag(cv, t, r.x + r.w - 24 - cv.textWidth(s[0], 18, { font: 'bold', spacing: 1.2 }) - 16, y, s[0], col(t, s[1]), 18);
        });
        // charts: boost target / actual, and the power against the reference, over engine speed
        const q = G.panel(cv, t, 748, 44, 828, 468, 'Ladedruck und Leistung');
        const xs = [a.rpm ? a.rpm[0] : 2000, a.rpm ? a.rpm[1] : 6500], x0 = Math.floor(xs[0] / 500) * 500, x1 = Math.ceil(xs[1] / 500) * 500;
        const bAll = a.boost.target.concat(a.boost.actual).map((x) => x[1]);
        U.chart(cv, t, q.x + 16, q.y + 50, q.w - 32, 190, { xMin: x0, xMax: x1, xStep: 1000, yMin: Math.floor(Math.min.apply(null, bAll.concat([1])) * 2) / 2,
            yMax: Math.ceil(Math.max.apply(null, bAll.concat([2])) * 2) / 2, yStep: 0.5, yUnit: 'bar abs.', xFmt: (x) => F(x / 1000, 0) + 'k',
            series: [{ pts: a.boost.target.sort((m, n) => m[0] - n[0]), color: t.dim, width: 2, dash: true }, { pts: a.boost.actual.sort((m, n) => m[0] - n[0]), color: t.accent, width: 3 }] });
        const pw = a.power.map((x) => [x[0], P(x[1])]), rp = ra ? ra.power.map((x) => [x[0], P(x[1])]) : [];
        U.chart(cv, t, q.x + 16, q.y + 250, q.w - 32, 206, { xMin: x0, xMax: x1, xStep: 1000, yMin: 0, yMax: Math.ceil(Math.max.apply(null, pw.concat(rp).map((x) => x[1]).concat([100])) / 50) * 50 + 20,
            yUnit: pU(), xUnit: '1/min', xFmt: (x) => F(x / 1000, 0) + 'k', series: [{ pts: rp, color: t.cold || '#5aa9ff', width: 2 }, { pts: pw, color: U.GO, width: 3, fill: 0.12 }] });
        [['Soll', t.dim], ['Ist', t.accent], ['Leistung', U.GO], ['Referenz', t.cold || '#5aa9ff']].forEach((l, i) => { cv.fillRect(q.x + 400 + i * 100, q.y + 33, 20, 4, l[1]); cv.text(l[0], q.x + 426 + i * 100, q.y + 40, 16, t.dim); });
    }

    function drawHist(cv, t, v) {
        const ps = list(v);
        const r = G.panel(cv, t, 24, 44, 1552, 468, ps.length ? ps.length + ' Pulls' : 'Pulls');
        if (!ps.length) { U.note(cv, t, r.x, r.y, r.w, r.h, 'Noch kein Pull gemessen'); return; }
        const rows = Math.floor((r.h - 100) / 40);
        if (sel >= ps.length) sel = 0;
        const scroll = G.clamp(sel - Math.floor(rows / 2), 0, Math.max(0, ps.length - rows));
        const y0 = r.y + 64;
        cv.roundRect(r.x + 12, y0 + 30 + (sel - scroll) * 40, r.w - 24, 40, 6, U.withAlpha(t.sel || t.accent, 0.22));
        G.table(cv, t, r.x + 24, y0, r.w - 48, [{ label: 'Wann', w: 180 }, { label: 'Gang', w: 90, align: 'right' }, { label: 'km/h', w: 160, align: 'right' },
            { label: 'Leistung', w: 170, align: 'right' }, { label: 'Ladedruck', w: 170, align: 'right' }, { label: 'Klopfen', w: 140, align: 'right' },
            { label: 'Raildruck', w: 150, align: 'right' }, { label: 'Ansaugluft', w: 150, align: 'right' }, { label: 'Ergebnis', w: 220, align: 'right' }],
        ps.slice(scroll, scroll + rows).map((p) => {
            const a = an(p), c = (id) => a.checks.find((x) => x.id === id), s = STATE[a.state], pinned = isNum(a.gear) && v.refs[a.gear] === p.id;
            const cell = (id, text) => ({ text: c(id).state === 'none' ? '--' : text, color: c(id).state === 'check' ? 'crit' : c(id).state === 'watch' ? 'warn' : null });
            return [(pinned ? '* ' : '') + C.when(p.t0), isNum(a.gear) ? String(a.gear) : '--', a.speed ? F(a.speed[0], 0) + '-' + F(a.speed[1], 0) : '--',
                a.peak ? F(P(a.peak.kw), 0) + ' ' + pU() : '--', cell('boost', c('boost').value > 0.005 ? '-' + F(c('boost').value, 2) + ' bar' : '0,00 bar'), cell('knock', F(c('knock').value, 1) + '°'),
                cell('rail', F((c('rail').value || 0) * 100, 0) + ' %'), cell('iat', '+' + F(c('iat').value, 0) + ' K'), { text: s[0], color: s[1] === 'go' ? U.GO : s[1] }];
        }), { rowH: 40, size: 22 });
        cv.scroll = { y: y0 + 30 };
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'last') drawLast(cv, t, v);
        else if (p === 'hist') drawHist(cv, t, v);
        else U.diagPage(cv, t, eng.dme, eng.live, [['Drehzahl', F(eng.live.rpm, 0) + ' 1/min'], ['Gaspedal / Leistung', F(eng.live.pedal, 0) + ' % / ' + F(eng.live.power, 0) + ' %'],
            ['Beschleunigung', F(eng.live.aLong, 2) + ' m/s²'], ['Tempo', F(eng.live.speed, 1) + ' km/h'], ['Fahrzeugzustand', isNum(eng.live.cond) ? String(eng.live.cond) : '--']]);
        const last = list(v)[0], st = last ? STATE[an(last).state] : null;
        pg.header(cv, t, [U.demoBadge(v.demo), eng.active() && { text: 'MISST', color: t.accent }, st && { text: st[0], color: col(t, st[1]) }]);
        return ui.image('MAIN_GFX', cv);
    }
    labels();
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
