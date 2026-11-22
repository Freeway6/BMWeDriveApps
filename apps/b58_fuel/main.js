'use strict';
/**
 * Sprit-Check - which fuel suits this B58: per tank filling and per fuel type.
 *
 *   - a filling: the tank level the instrument cluster sends rises by 5 l or more while standing, and stays (also one
 *     done while the head unit slept: found at the next start). Confirmed by the engine unit's own "time since
 *     refuelling" where it answers. The fuel type: the button (Sorte ändern), remembered for the next filling.
 *   - per tank: the fuel used (the injection counter, its factor learned from the engine unit's fuel flow,
 *     lib/lib_flow.js; else the drop of the tank level), the km, the cost (the type's price when it was filled), the
 *     octane the engine unit has adapted to (DME 5776) and its knock adaptation, the knock control's retard at high
 *     load (sampled about once a second at full throttle only), and the engine unit's quality range of the filling
 *     (its refuelling list, KQE 4035).
 *   - per type: all of that over its tanks, and what each costs against the cheapest.
 *   Read only; nothing is read with the engine off or the car locked and left.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { UdsReader } = require('./lib_uds');
const { DME, dmeConfig, QUALITY, refuellings } = require('./lib_dme');
const { watchCar } = require('./lib_signals');
const { Flow, Used } = require('./lib_flow');
const C = require('./lib_core');
const U = require('./lib_ui');
const { rng } = require('./lib_demo');
const { Tanks, summary, compare, verdict, TYPES, TYPE_LABEL } = require('./tank');

const { isNum } = C;
const W = 1600, H = 520;
const NAMES = { now: 'Jetzt', types: 'Sorten', list: 'Tankfüllungen', diag: 'Diagnose' };

function engine(env) {
    const { log, settings, spec } = env;
    const store = new C.Store(env.dataDir, 'fuel.json', { tanks: [], cur: null, lastLevel: null, lastType: 'super', flowK: null, pick: {} }, log);
    const st = store.data;
    const dme = new UdsReader(env.signals, log, dmeConfig(spec.config && spec.config.dme), DME);
    dme.usePick(st.pick);
    const flow = new Flow(st.flowK), used = new Used();
    let kmFlow = 0, litres = 0, lastSpeedT = 0, lastSpeed = null;
    const price = (type) => settings.get('price_' + type);
    const tk = new Tanks(st, {
        price,
        onFill: (prev, cur) => { log.info('filling: ' + cur.filled + ' l ' + cur.type + (prev ? ' (last tank ' + summary(prev).km + ' km)' : '')); store.save(true); },
    });
    let pendingFill = null;
    const live = watchCar(env.signals, log, ['speed', 'cond', 'engine', 'tank', 'inj', 'pedal', 'fes'], {
        onTank: (lv) => {
            const c = tk.level(Date.now(), lv.tank, lv.odo, !(lv.speed > 1));
            if (c) pendingFill = c;
            if (tk.cur) store.save(false, 120000);
        },
        onInj: (raw, t) => {
            flow.feed(raw, t);
            const l = used.add(flow.lph(t), t);
            if (l > 0) litres += l;
        },
        onSpeed: (v) => {
            const t = Date.now();
            if (isNum(v) && isNum(lastSpeed) && t - lastSpeedT < 3000 && flow.k) kmFlow += (v + lastSpeed) / 2 * (t - lastSpeedT) / 3600000;
            lastSpeed = v; lastSpeedT = t;
        },
    });
    let visible = false, stopped = false, wake = null, lastRon = 0, lastLearn = 0, learnUntil = 0, kqeAsked = false, engineWas = false;

    /** A filling candidate: counted when the engine unit agrees it was refuelled (or does not say, or it was 10 l or more). */
    async function confirmFill(c) {
        let ok = c.litres >= 10;
        if (!ok) {
            const h = dme.available && !live.left() ? await dme.value('sinceRefuel') : null;
            ok = h === null || h < 1;
            if (!ok) log.info('tank level rose ' + c.litres + ' l, but no refuelling for ' + h.toFixed(1) + ' h: not counted');
        }
        if (ok) { tk.fill(Date.now(), c.l, c.litres, c.odo); kqeAsked = false; }
    }

    async function onDrive(t) {
        const cur = tk.cur;
        // the engine unit's quality range of this filling (asked once per drive until found)
        if (cur && cur.kqe === null && !kqeAsked) {
            kqeAsked = true;
            const k = await dme.group('kqe');
            const near = refuellings(k).filter((x) => isNum(cur.odo0) && Math.abs(x.km - cur.odo0) <= 24);
            if (near.length) { cur.kqe = near[0].q; log.info('filling at ' + cur.odo0 + ' km: quality range ' + cur.kqe); store.save(false, 60000); }
        }
        // the adapted octane and knock adaptation, every 5 minutes (after 30 km on this tank: it adapts while driving)
        if (cur && t - lastRon > 300000) {
            lastRon = t;
            const km = isNum(cur.odo0) && isNum(cur.odo1) ? cur.odo1 - cur.odo0 : 0;
            const ron = await dme.value('fuelQuality'), ka = await dme.value('knockAdapt');
            if (km >= 30 && isNum(ron)) { cur.ron = Math.round(ron * 10) / 10; cur.ronKm = km; }
            if (km >= 30 && isNum(ka)) cur.knockAdapt = Math.round(ka * 10) / 10;
        }
        // the flow factor: learned from the engine unit's l/h for a minute, again every 30 min
        if (t - lastLearn > (flow.k ? 1800000 : 120000) && live.speed > 5) { lastLearn = t; learnUntil = t + 60000; }
        if (t < learnUntil) {
            const lph = await dme.value('fuelFlow');
            if (isNum(lph) && flow.learn(lph, Date.now())) { st.flowK = flow.k; log.info('fuel flow factor ' + flow.k.toFixed(6)); store.save(false, 60000); }
        }
        // full throttle: the knock control's retard, about once a second
        const loadRpm = settings.get('loadRpm') || 2500;
        if (cur && live.rpm > loadRpm && ((isNum(live.pedal) && live.pedal > 60) || (isNum(live.power) && live.power > 50))) {
            const r = await dme.value('knockRetard', true);
            if (isNum(r)) tk.load(r);
        }
        // the fuel counted by the flow goes to the tank every few seconds
        if (litres > 0) { tk.fuel(litres, kmFlow); litres = 0; kmFlow = 0; }
    }

    const sleep = (ms) => new Promise((res) => { const tm = setTimeout(() => { wake = null; res(); }, ms); wake = () => { clearTimeout(tm); wake = null; res(); }; });
    async function loop() {
        await dme.init();
        while (!stopped) {
            let wait = 2000;
            try {
                const t = Date.now(), on = live.engineOn();
                if (on && !engineWas) kqeAsked = false;
                engineWas = on;
                if (pendingFill) { const c = pendingFill; pendingFill = null; await confirmFill(c); }
                if (!demoOn() && dme.available && !live.left() && on) { await onDrive(t); wait = 1000; }
            } catch (e) { log.warn('loop: ' + (e && e.message || e)); }
            await sleep(wait);
        }
    }

    /* ---------- demo: nine tanks of three fuels, the tenth going on ---------- */
    let demo = null;
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !dme.available && !st.tanks.length && !st.cur);
    function demoData() {
        if (demo) return demo;
        const r = rng(23), now = Date.now(), dst = { tanks: [], cur: null, lastLevel: null, lastType: 'plus' };
        const dtk = new Tanks(dst, { price: (type) => price(type) });
        const ORDER = ['e10', 'plus', 'e10', 'premium', 'plus', 'e10', 'plus', 'premium', 'e10'];
        const CONS = { e10: 9.75, super: 9.6, plus: 9.45, premium: 9.4 }, RON = { e10: 95.3, super: 95.6, plus: 97.6, premium: 98.1 }, RET = { e10: 1.35, super: 1.2, plus: 0.65, premium: 0.45 };
        let t = now - 75 * 86400000, odo = 41000;
        ORDER.concat(['plus']).forEach((type, i) => {
            dst.lastType = type;
            const d = new Date(t);                                   // filled in the day time
            d.setHours(7 + Math.floor(r() * 12), Math.floor(r() * 60));
            t = d.getTime();
            dtk.fill(t, 58, 45 + r() * 8, odo);
            const c = dst.cur, km = i === 9 ? 312 : 480 + r() * 160;
            const n = 40 + Math.round(r() * 60);
            for (let k = 0; k < n; k++) dtk.load(Math.max(0, RET[type] * (0.4 + r() * 1.3)));
            odo += km; t += km / 70 * 3600000 + 6 * 86400000;
            dtk.fuel(km * (CONS[type] + (r() - 0.5) * 0.4) / 100, km);
            c.odo1 = odo; c.level1 = 58 - km * CONS[type] / 100; c.t1 = t;
            c.ron = Math.round((RON[type] + (r() - 0.5) * 0.4) * 10) / 10; c.kqe = type === 'e10' ? 2 : 3; c.knockAdapt = -RET[type] * 0.8;
        });
        demo = { st: dst, tk: dtk };
        return demo;
    }

    loop();
    return {
        ok: true, dme, live, flow,
        setVisible(v) { visible = v; if (v && wake) wake(); },
        /** The button: the next fuel type for the tank going on. */
        nextType() {
            const s = demoOn() ? demoData() : { st, tk };
            const cur = s.st.cur ? s.st.cur.type : s.st.lastType, i = TYPES.indexOf(cur);
            s.tk.setType(TYPES[(i + 1) % TYPES.length]);
            if (!demoOn()) store.save(true);
        },
        view() {
            if (demoOn()) { const d = demoData(); return { demo: true, st: d.st, link: true }; }
            return { demo: false, st, link: dme.available, tank: live.tank, odo: live.odo };
        },
        stop() { stopped = true; if (wake) wake(); },
    };
}

function startUi(ctx, eng) {
    const { ui, settings } = ctx;
    const F = C.fmt;
    const pages = () => ['now', 'types', 'list'].concat(settings.get('diagPage') ? ['diag'] : []);
    const pg = U.pager(ctx, pages, NAMES, () => render());
    ui.onClick('BTN_ACT', () => { eng.nextType(); return render(); });
    if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') eng.setVisible(on); });
    if (ui.isVisible && ui.isVisible('MAIN')) eng.setVisible(true);
    const qCol = (t, q) => (q === 3 ? U.GO : q === 2 ? '#c8d0dc' : q === 1 ? t.warn : t.dim);
    const retCol = (t, x) => (!isNum(x) ? t.dim : x < 0.8 ? U.GO : x < 1.5 ? '#c8d0dc' : t.warn);

    /** The octane on a scale from RON 91 to 99, marks at 95 and 98. */
    function ronScale(cv, t, x, y, w, ron) {
        const lo = 91, hi = 99, X = (v) => x + G.clamp((v - lo) / (hi - lo), 0, 1) * w;
        cv.fillRect(x, y, w, 12, U.withAlpha('#ffffff', 0.12));
        if (isNum(ron)) cv.fillRect(x, y, X(ron) - x, 12, ron >= 97 ? U.GO : ron >= 94.5 ? '#c8d0dc' : t.warn);
        [91, 95, 98].forEach((v) => { cv.fillRect(X(v) - 1, y - 6, 2, 24, U.withAlpha('#ffffff', 0.5)); cv.text('ROZ ' + v, X(v), y + 40, 16, t.dim, { align: v === 91 ? 'left' : 'center' }); });
    }

    function drawNow(cv, t, v) {
        const cur = v.st.cur, s = cur ? summary(cur) : null;
        const p = G.panel(cv, t, 24, 44, 900, 468, cur ? 'Diese Tankfüllung' : 'Tankfüllung');
        if (!cur) {
            U.note(cv, t, p.x, p.y, p.w, p.h, v.link ? 'Noch keine Tankfüllung erkannt.\nNach dem nächsten Tanken zählt die App von selbst.' : 'Warte auf das Motorsteuergerät');
        } else {
            cv.text(TYPE_LABEL[cur.type], p.x + 24, p.y + 120, 64, t.text, { font: 'bold' });
            cv.text('getankt ' + C.when(cur.t0) + '   ' + F(cur.filled, 1) + ' l' + (isNum(s.cost) ? '   ' + F(s.cost, 2) + ' €' : ''), p.x + 24, p.y + 160, 22, t.dim);
            const rows = [
                ['Gefahren', F(s.km, 0, true) + ' km'],
                ['Verbrauch', isNum(s.cons) ? F(s.cons, 1) + ' l/100 km' + (s.by === 'level' ? ' (Tankanzeige)' : '') : 'misst noch'],
                ['Zündrücknahme unter Last', isNum(s.retard) ? F(s.retard, 1) + '°  (über 1,5°: ' + F(s.share * 100, 0) + ' %)' : 'noch keine Volllast'],
                ['Einstufung Motor', cur.kqe ? QUALITY[cur.kqe] : '--'],
            ];
            rows.forEach((x, i) => U.row(cv, t, p.x + 24, p.w - 48, p.y + 222 + i * 44, x[0], x[1], i === 2 ? retCol(t, s.retard) : i === 3 ? qCol(t, cur.kqe) : null));
            cv.text('OKTANZAHL, AN DIE SICH DER MOTOR ANGEPASST HAT', p.x + 24, p.y + 412, 18, t.dim, { font: 'bold', spacing: 1.2 });
            cv.text(isNum(cur.ron) ? 'ROZ ' + F(cur.ron, 1) : 'ab 30 km', p.x + p.w - 24, p.y + 412, 22, isNum(cur.ron) ? t.text : t.dim, { font: 'bold', align: 'right' });
            ronScale(cv, t, p.x + 24, p.y + 426, p.w - 48, cur.ron);
        }
        const q = G.panel(cv, t, 948, 44, 628, 468, 'So geht es');
        ['Nach dem Tanken einmal "Sorte ändern" drücken,', 'bis die getankte Sorte oben steht.', 'Die nächste Füllung beginnt mit derselben Sorte.', '',
            'Gezählt wird von selbst: Verbrauch, Kosten,', 'Klopfregelung bei Volllast und die Oktanzahl,', 'die der Motor selbst gelernt hat.', '',
            'Je mehr Tankfüllungen je Sorte, desto', 'belastbarer der Vergleich (Seite Sorten).']
            .forEach((l, i) => cv.text(l, q.x + 24, q.y + 92 + i * 34, 21, i < 3 ? t.text : t.dim));
    }

    function drawTypes(cv, t, v) {
        const tanks = v.st.tanks.concat(v.st.cur && summary(v.st.cur).km >= 100 ? [summary(v.st.cur)] : []);
        const rows = compare(tanks);
        const p = G.panel(cv, t, 24, 44, 1552, 468, 'Die Sorten im Vergleich');
        G.table(cv, t, p.x + 24, p.y + 64, p.w - 48, [{ label: 'Sorte', w: 240 }, { label: 'Füllungen', w: 140, align: 'right' }, { label: 'Strecke', w: 160, align: 'right' },
            { label: 'Verbrauch', w: 200, align: 'right' }, { label: 'Kosten', w: 200, align: 'right' }, { label: 'ROZ (Motor)', w: 170, align: 'right' },
            { label: 'Zündrücknahme', w: 190, align: 'right' }, { label: 'über 1,5°', w: 150, align: 'right' }],
        rows.map((r) => [{ text: r.label, color: r.n ? null : 'dim' }, String(r.n), r.km ? F(r.km, 0, true) + ' km' : '--', isNum(r.cons) ? F(r.cons, 2) + ' l/100 km' : '--',
            isNum(r.eur100) ? F(r.eur100, 2) + ' €/100 km' : '--', isNum(r.ron) ? F(r.ron, 1) : '--', { text: isNum(r.retard) ? F(r.retard, 2) + '°' : '--', color: retCol(t, r.retard) },
            isNum(r.share) ? F(r.share * 100, 0) + ' %' : '--']), { rowH: 46, size: 24 });
        const lines = verdict(rows, F);
        (lines.length ? lines : ['Für einen Vergleich braucht es je Sorte mindestens 200 km.']).slice(0, 3)
            .forEach((l, i) => cv.text(l, p.x + 24, p.y + 330 + i * 34, 22, lines.length ? t.text : t.dim));
        cv.text('Zündrücknahme: wie weit die Klopfregelung die Zündung bei Volllast zurücknimmt - weniger ist besser.', p.x + 24, p.y + p.h - 20, 18, t.dim);
    }

    function drawList(cv, t, v) {
        const list = v.st.tanks.slice().reverse();
        const p = G.panel(cv, t, 24, 44, 1552, 468, list.length ? list.length + ' Tankfüllungen' : 'Tankfüllungen');
        const rows = Math.floor((p.h - 100) / 40);
        G.table(cv, t, p.x + 24, p.y + 64, p.w - 48, [{ label: 'Getankt', w: 180 }, { label: 'Sorte', w: 210 }, { label: 'Menge', w: 130, align: 'right' },
            { label: 'Kosten', w: 140, align: 'right' }, { label: 'Strecke', w: 150, align: 'right' }, { label: 'Verbrauch', w: 200, align: 'right' },
            { label: 'ROZ', w: 110, align: 'right' }, { label: 'Zündrückn.', w: 160, align: 'right' }, { label: 'Einstufung', w: 210, align: 'right' }],
        list.slice(0, rows).map((s) => [C.when(s.t0), TYPE_LABEL[s.type], F(s.filled, 1) + ' l', isNum(s.cost) ? F(s.cost, 2) + ' €' : '--', F(s.km, 0, true) + ' km',
            isNum(s.cons) ? F(s.cons, 2) + ' l/100 km' : '--', isNum(s.ron) ? F(s.ron, 1) : '--', { text: isNum(s.retard) ? F(s.retard, 2) + '°' : '--', color: retCol(t, s.retard) },
            { text: s.kqe ? QUALITY[s.kqe] : '--', color: qCol(t, s.kqe) }]),
        { rowH: 40, size: 22, empty: 'Noch keine abgeschlossene Tankfüllung' });
    }

    function render() {
        const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = eng.view(), p = pg.page();
        if (p === 'now') drawNow(cv, t, v);
        else if (p === 'types') drawTypes(cv, t, v);
        else if (p === 'list') drawList(cv, t, v);
        else U.diagPage(cv, t, eng.dme, eng.live, [['Tankinhalt', F(eng.live.tank, 0) + ' l'], ['km-Stand', F(eng.live.odo, 0, true)], ['Motor läuft', eng.live.engineOn() ? 'ja' : 'nein'],
            ['Drehzahl / Pedal', F(eng.live.rpm, 0) + ' / ' + F(eng.live.pedal, 0) + ' %'], ['Fluss-Faktor', eng.flow.k ? F(eng.flow.k * 1e6, 3) + ' (gelernt)' : 'lernt noch'], ['Fahrzeugzustand', isNum(eng.live.cond) ? String(eng.live.cond) : '--']]);
        const cur = v.st.cur;
        pg.header(cv, t, [U.demoBadge(v.demo), cur && { text: TYPE_LABEL[cur.type].toUpperCase(), color: t.accent }]);
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
