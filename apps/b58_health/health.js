'use strict';
/**
 * health.js - Motor-Check's judgement: from the snapshots (one measurement of the engine unit's values with a warm
 * engine, standing at idle or cruising steadily) and the drives (warm-up, how warm the oil got), what is fine, what
 * to watch and what to have checked.
 *
 *   const r = evaluate(snaps, drives, opts)  -> { cards: [{ id, title, state: 'ok'|'watch'|'check'|'none', value, note }],
 *                                                 cyl: [{ n, misfires, rough, inj }], oil: {...} }
 *
 * The limits are rules of thumb for a petrol engine, not BMW's: the app says "beobachten" (watch) or "prüfen lassen"
 * (have it checked), never that something is broken. The car's own fault memory decides that (Fault Scanner).
 */
const { isNum } = require('./lib_core');

const DAY = 86400000;
const median = (xs) => { const s = xs.filter(isNum).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const worst = (a, b) => (['none', 'ok', 'watch', 'check'].indexOf(a) > ['none', 'ok', 'watch', 'check'].indexOf(b) ? a : b);

/** Misfires of each cylinder since the snapshot before (a counter that went down was reset: its value counts). */
function misfireDeltas(snaps, n) {
    const out = [];
    for (let i = 1; i < snaps.length; i++) {
        const a = snaps[i - 1], b = snaps[i], row = [];
        for (let c = 1; c <= n; c++) {
            const x = a['misfire' + c], y = b['misfire' + c];
            row.push(!isNum(y) ? null : !isNum(x) || y < x ? y : y - x);
        }
        out.push({ t: b.t, row });
    }
    return out;
}

/**
 * Oil used per 1000 km: the oil level (litres above the minimum) over the odometer since the last top-up (a rise of
 * 0.25 l or more), a straight line through it; at least 800 km of readings. null: not enough yet.
 */
function oilUse(snaps) {
    const pts = snaps.filter((s) => isNum(s.oilLevel) && isNum(s.odo)).map((s) => [s.odo, s.oilLevel]);
    let from = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][1] - pts[i - 1][1] >= 0.25) from = i;
    const seg = pts.slice(from);
    if (seg.length < 4 || seg[seg.length - 1][0] - seg[0][0] < 800) return { perKm: null, seg, km: seg.length ? seg[seg.length - 1][0] - seg[0][0] : 0 };
    const n = seg.length, mx = seg.reduce((a, p) => a + p[0], 0) / n, my = seg.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, den = 0;
    seg.forEach((p) => { num += (p[0] - mx) * (p[1] - my); den += (p[0] - mx) * (p[0] - mx); });
    const slope = den > 0 ? num / den : 0;                // litres per km (negative: used)
    return { perKm: Math.max(0, -slope), seg, km: seg[n - 1][0] - seg[0][0] };
}

function evaluate(snaps, drives, opts) {
    const o = Object.assign({ cylinders: 6, oilWarn: 0.5, now: Date.now() }, opts || {});
    const n = o.cylinders, last = snaps[snaps.length - 1] || null, cards = [];
    const recent = snaps.filter((s) => o.now - s.t < 30 * DAY);

    // ---- cylinders: misfires (30 days), rough running (latest idle), injector corrections (latest)
    const deltas = misfireDeltas(snaps, n).filter((d) => o.now - d.t < 30 * DAY);
    const cyl = [];
    for (let c = 1; c <= n; c++) {
        const mis = deltas.reduce((a, d) => a + (isNum(d.row[c - 1]) ? d.row[c - 1] : 0), 0);
        const misDrives = deltas.filter((d) => d.row[c - 1] > 0).length;
        const idle = snaps.filter((s) => s.kind === 'idle' && isNum(s['rough' + c]));
        const rough = idle.length ? idle[idle.length - 1]['rough' + c] : null;
        const inj = last && isNum(last['inj' + c]) ? last['inj' + c] : null;
        cyl.push({ n: c, misfires: deltas.length ? mis : null, misDrives, rough, inj });
    }
    const injs = cyl.map((x) => x.inj).filter(isNum), injMid = median(injs);
    cyl.forEach((x) => { x.injDev = isNum(x.inj) && isNum(injMid) ? (x.inj - injMid) / injMid : null; });
    const roughMid = median(cyl.map((x) => (isNum(x.rough) ? Math.abs(x.rough) : null)));
    let cylState = deltas.length || injs.length ? 'ok' : 'none', cylNote = 'Fehlzündungen, Laufruhe und Injektoren unauffällig';
    cyl.forEach((x) => {
        if (x.misDrives >= 3 || x.misfires >= 50) { cylState = worst(cylState, 'check'); cylNote = 'Zylinder ' + x.n + ': Fehlzündungen bei ' + x.misDrives + ' Messungen - Zündspule und Kerze prüfen lassen'; }
        else if (x.misfires > 0 && cylState === 'ok') { cylState = 'watch'; cylNote = 'Zylinder ' + x.n + ': einzelne Fehlzündungen - beobachten'; }
    });
    cyl.forEach((x) => {
        if (isNum(x.injDev) && Math.abs(x.injDev) > 0.08) { cylState = worst(cylState, 'check'); if (cylState === 'check' && !/Fehlz/.test(cylNote)) cylNote = 'Injektor Zylinder ' + x.n + ' weicht ' + Math.round(x.injDev * 100) + ' % ab - prüfen lassen'; }
        else if (isNum(x.injDev) && Math.abs(x.injDev) > 0.05 && cylState === 'ok') { cylState = 'watch'; cylNote = 'Injektor Zylinder ' + x.n + ' weicht ' + Math.round(x.injDev * 100) + ' % ab - beobachten'; }
        if (isNum(x.rough) && isNum(roughMid) && roughMid > 0 && Math.abs(x.rough) > 3 * roughMid && Math.abs(x.rough) > 20 && cylState === 'ok') { cylState = 'watch'; cylNote = 'Zylinder ' + x.n + ' läuft unruhiger als die anderen - beobachten'; }
    });
    if (cylState === 'none') cylNote = 'noch keine Messung';
    const misTotal = cyl.reduce((a, x) => a + (x.misfires || 0), 0);
    cards.push({ id: 'cyl', title: 'Zylinder', state: cylState, value: deltas.length ? misTotal + ' Fehlz.' : '--', note: cylNote });

    // ---- mixture: long term fuel trim, mixture adaptation
    let mixState = 'none', mixNote = 'noch keine Messung', mixValue = '--';
    if (last && (isNum(last.ltft) || isNum(last.mixAdapt))) {
        const lt = last.ltft, ma = last.mixAdapt, dev = isNum(ma) ? (ma - 1) * 100 : null;
        const x = Math.max(isNum(lt) ? Math.abs(lt) : 0, isNum(dev) ? Math.abs(dev) : 0);
        mixState = x > 12 ? 'check' : x > 8 ? 'watch' : 'ok';
        mixValue = isNum(lt) ? (lt > 0 ? '+' : '') + lt.toFixed(1).replace('.', ',') + ' %' : (dev > 0 ? '+' : '') + dev.toFixed(1).replace('.', ',') + ' %';
        const lean = (isNum(lt) ? lt : dev) > 0;
        mixNote = mixState === 'ok' ? 'Gemischadaption im normalen Bereich'
            : (lean ? 'Das Steuergerät gibt mehr Kraftstoff zu: Falschluft (Ansaugseite, Kurbelgehäuseentlüftung)?' : 'Das Steuergerät nimmt Kraftstoff weg: Injektor, Lambdasonde?')
                + (mixState === 'check' ? ' - prüfen lassen' : ' - beobachten');
    }
    cards.push({ id: 'mix', title: 'Gemisch', state: mixState, value: mixValue, note: mixNote });

    // ---- oil: level / use, fuel in the oil, pressure at warm idle
    const use = oilUse(snaps), per1000 = isNum(use.perKm) ? use.perKm * 1000 : null;
    let oilState = last ? 'ok' : 'none', oilNote = last ? 'Ölstand, Verbrauch und Öldruck unauffällig' : 'noch keine Messung';
    if (isNum(per1000) && per1000 > o.oilWarn) { oilState = 'watch'; oilNote = 'Ölverbrauch ' + per1000.toFixed(2).replace('.', ',') + ' l/1000 km - beobachten'; }
    if (isNum(per1000) && per1000 > o.oilWarn * 2) { oilState = 'check'; oilNote = 'Ölverbrauch ' + per1000.toFixed(2).replace('.', ',') + ' l/1000 km - prüfen lassen'; }
    if (last && isNum(last.oilLevel) && last.oilLevel < 0.15) { oilState = worst(oilState, 'watch'); oilNote = 'Ölstand nahe Minimum - nachfüllen'; }
    const fuelIn = snaps.filter((s) => isNum(s.fuelInOil));
    const fio = fuelIn.length ? fuelIn[fuelIn.length - 1].fuelInOil : null, fioMid = median(fuelIn.map((s) => s.fuelInOil));
    if (isNum(fio) && isNum(fioMid) && fuelIn.length >= 5 && fio > Math.max(60, 2 * fioMid) && oilState === 'ok') {
        oilState = 'watch'; oilNote = 'Kraftstoff im Öl steigt (' + Math.round(fio) + ' g): eine längere Fahrt (20 min+) lässt ihn verdampfen';
    }
    // oil pressure at warm idle against this engine's own, at the same oil temperature (+-10 °C)
    const idle = snaps.filter((s) => s.kind === 'idle' && isNum(s.oilPress) && isNum(s.ambientP) && isNum(s.oilTemp));
    let press = null, pressBase = null;
    if (idle.length) {
        const l = idle[idle.length - 1];
        press = l.oilPress - l.ambientP;
        const same = idle.slice(0, -1).filter((s) => Math.abs(s.oilTemp - l.oilTemp) <= 10).slice(0, 20).map((s) => s.oilPress - s.ambientP);
        pressBase = same.length >= 3 ? median(same) : null;
        if (isNum(pressBase) && pressBase > 0.3) {
            const drop = 1 - press / pressBase;
            if (drop > 0.35) { oilState = 'check'; oilNote = 'Öldruck im warmen Leerlauf ' + Math.round(drop * 100) + ' % unter deinem üblichen - prüfen lassen'; }
            else if (drop > 0.2) { oilState = worst(oilState, 'watch'); if (oilState === 'watch') oilNote = 'Öldruck im warmen Leerlauf ' + Math.round(drop * 100) + ' % unter deinem üblichen - beobachten'; }
        }
    }
    cards.push({ id: 'oil', title: 'Öl', state: oilState, value: isNum(per1000) ? per1000.toFixed(2).replace('.', ',') + ' l/1000 km' : last && isNum(last.oilLevel) ? '+' + last.oilLevel.toFixed(2).replace('.', ',') + ' l' : '--', note: oilNote });

    // ---- cooling: warm-up time against this car's own at the same outside temperature
    const warm = drives.filter((d) => isNum(d.warmMin) && isNum(d.startCoolant) && d.startCoolant < 35);
    let coolState = warm.length ? 'ok' : 'none', coolNote = warm.length ? 'Warmlauf normal' : 'noch kein Kaltstart gemessen', coolValue = '--';
    if (warm.length) {
        const l = warm[warm.length - 1];
        coolValue = Math.round(l.warmMin) + ' min';
        const same = warm.slice(0, -1).filter((d) => isNum(d.ambient) && isNum(l.ambient) && Math.abs(d.ambient - l.ambient) <= 6).map((d) => d.warmMin);
        const base = same.length >= 3 ? median(same) : null;
        if (isNum(base) && l.warmMin > base * 1.6 && l.warmMin - base > 4) { coolState = 'watch'; coolNote = 'Warmlauf dauerte ' + Math.round(l.warmMin) + ' statt ' + Math.round(base) + ' min: Thermostat? - beobachten'; }
        else coolNote = 'Warmlauf bis 80 °C: ' + Math.round(l.warmMin) + ' min' + (isNum(base) ? ' (üblich ' + Math.round(base) + ')' : '');
    }
    cards.push({ id: 'cool', title: 'Kühlung', state: coolState, value: coolValue, note: coolNote });

    // ---- ignition: knock adaptation, spark plugs
    let ignState = last ? 'ok' : 'none', ignNote = last ? 'Klopfregelung und Zündkerzen unauffällig' : 'noch keine Messung', ignValue = '--';
    if (last && isNum(last.plugsLeft)) {
        ignValue = Math.round(last.plugsLeft / 1000) + ' tkm Kerzen';
        if (last.plugsLeft < 0) { ignState = 'check'; ignNote = 'Zündkerzen über ihrer Laufzeit - wechseln lassen'; }
        else if (last.plugsLeft < 5000) { ignState = 'watch'; ignNote = 'Zündkerzen: noch etwa ' + Math.round(last.plugsLeft / 100) * 100 + ' km'; }
    }
    if (last && isNum(last.knockAdapt) && last.knockAdapt < -3) {
        ignState = worst(ignState, 'watch');
        if (ignState === 'watch') ignNote = 'Die Klopfregelung hat ' + Math.abs(last.knockAdapt).toFixed(1).replace('.', ',') + '° Zündung zurückgenommen: Kraftstoffqualität? (Sprit-Check)';
    }
    cards.push({ id: 'ign', title: 'Zündung', state: ignState, value: ignValue, note: ignNote });

    // ---- driving: short trips (the oil never reached 70 °C), the last 30 days
    const d30 = drives.filter((d) => o.now - d.t0 < 30 * DAY);
    const short = d30.filter((d) => isNum(d.oilMax) && d.oilMax < 70).length;
    let tripState = d30.length ? 'ok' : 'none', tripNote = d30.length ? 'genug lange Fahrten' : 'noch keine Fahrt';
    if (d30.length >= 5 && short / d30.length > 0.5) { tripState = 'watch'; tripNote = short + ' von ' + d30.length + ' Fahrten ohne warmes Öl: ab und zu länger fahren'; }
    else if (d30.length) tripNote = short + ' von ' + d30.length + ' Fahrten ohne warmes Öl';
    cards.push({ id: 'trips', title: 'Fahrprofil', state: tripState, value: d30.length ? Math.round(short / d30.length * 100) + ' % kurz' : '--', note: tripNote });

    return { cards, cyl, oil: { per1000, use, fuelInOil: fio, press, pressBase }, overall: cards.reduce((a, c) => worst(a, c.state), 'none'), recent: recent.length };
}

module.exports = { evaluate, misfireDeltas, oilUse, median };
