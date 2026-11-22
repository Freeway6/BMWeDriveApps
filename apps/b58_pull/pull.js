'use strict';
/**
 * pull.js - Pull-Check's judgement of a full-throttle pull.
 *
 * A pull: fast samples from the car's own signals (about 10 a second: engine speed, speed, acceleration, pedal) and
 * slower ones from the engine unit (about 10 readings a second shared by all channels: boost target and actual, knock
 * retard, rail pressure target and actual, intake air, lambda target and actual), each with its time.
 *
 *   const a = analyze(pull, { ambient, car })
 *     -> { checks: [{ id, label, state: 'ok'|'watch'|'check'|'none', value, note }], power: [[rpm, kW]], peak: { kw, rpm },
 *          gear, boost: { target: [[rpm, bar]], actual: [[rpm, bar]] }, state }
 *
 * The limits are rules of thumb for a standard B58, not BMW's.
 */
const { isNum } = require('./lib_core');
const { wheelKw, kmh, CAR } = require('./lib_phys');
const { RATIOS, FINAL, TYRE } = require('./lib_demo');

const worse = (a, b) => (['none', 'ok', 'watch', 'check'].indexOf(a) > ['none', 'ok', 'watch', 'check'].indexOf(b) ? a : b);

/** The gear from engine speed over road speed (8HP ratios, final drive, tyre), or null. */
function gearOf(rpm, speed) {
    if (!(rpm > 800) || !(speed > 10)) return null;
    const ratio = rpm / (speed / 3.6 / TYRE * 60) / FINAL;
    let best = null, err = 0.12;
    RATIOS.forEach((r, i) => { const e = Math.abs(ratio - r) / r; if (e < err) { err = e; best = i + 1; } });
    return best;
}

/** The engine unit's samples of one channel: [{ t, v, rpm }]. */
const ch = (pull, name) => (pull.dme || []).filter((s) => s.n === name && isNum(s.v));

/** For each sample of a, the sample of b nearest in time (within ms): [[a, b]]. */
function pairs(a, b, ms) {
    const out = [];
    a.forEach((x) => {
        let best = null;
        b.forEach((y) => { if (Math.abs(y.t - x.t) <= ms && (!best || Math.abs(y.t - x.t) < Math.abs(best.t - x.t))) best = y; });
        if (best) out.push([x, best]);
    });
    return out;
}

function analyze(pull, o) {
    o = o || {};
    const car = o.car || CAR, fast = pull.fast || [], checks = [];
    const t0 = fast.length ? fast[0].t : 0;
    // the steady part: after the turbo has built up (1.5 s), from 2500 rpm
    const steady = (s) => s.t - t0 >= 1500 && s.rpm >= 2500;

    // ---- power at the wheels from the acceleration and speed (smoothed over 5 samples)
    const pw = [];
    fast.forEach((s, i) => {
        const win = fast.slice(Math.max(0, i - 2), i + 3).filter((x) => isNum(x.aLong) && isNum(x.speed));
        if (!win.length || !isNum(s.rpm)) return;
        const a = win.reduce((q, x) => q + x.aLong, 0) / win.length, v = win.reduce((q, x) => q + x.speed, 0) / win.length;
        if (v > 15) pw.push([s.rpm, wheelKw(kmh(v), a, car)]);
    });
    const peak = pw.reduce((b, p) => (!b || p[1] > b.kw ? { rpm: p[0], kw: p[1] } : b), null);

    // ---- boost: target against actual, paired within 0.6 s
    const bt = ch(pull, 'boostTarget'), ba = ch(pull, 'boostAct');
    const bp = pairs(bt, ba, 600).filter((p) => steady(p[0]));
    const dev = bp.map((p) => p[0].v - p[1].v);
    const devMax = dev.length ? Math.max.apply(null, dev) : null, devMean = dev.length ? dev.reduce((a, b) => a + b, 0) / dev.length : null;
    checks.push(!dev.length ? { id: 'boost', label: 'Ladedruck', state: 'none', value: '--', note: 'keine Werte' } : {
        id: 'boost', label: 'Ladedruck', value: devMax, state: devMax > 0.3 ? 'check' : devMax > 0.15 ? 'watch' : 'ok',
        note: devMax > 0.15 ? 'erreicht den Sollwert nicht: undichter Ladeluftweg, Wastegate?' : 'folgt dem Sollwert', mean: devMean });

    // ---- knock control retard
    const kr = ch(pull, 'knockRetard').filter(steady).map((s) => Math.max(0, s.v));
    const krMean = kr.length ? kr.reduce((a, b) => a + b, 0) / kr.length : null, krMax = kr.length ? Math.max.apply(null, kr) : null;
    checks.push(!kr.length ? { id: 'knock', label: 'Klopfregelung', state: 'none', value: '--', note: 'keine Werte' } : {
        id: 'knock', label: 'Klopfregelung', value: krMean, max: krMax, state: krMean > 3 ? 'check' : krMean > 1.5 ? 'watch' : 'ok',
        note: krMean > 1.5 ? 'nimmt deutlich Zündung zurück: Kraftstoff, Hitze? (Sprit-Check)' : 'kaum Zündrücknahme' });

    // ---- rail pressure: actual against target
    const rp = pairs(ch(pull, 'railAct'), ch(pull, 'railTarget'), 800).filter((p) => steady(p[0]) && p[1].v > 50);
    const rr = rp.map((p) => p[0].v / p[1].v), rMin = rr.length ? Math.min.apply(null, rr) : null;
    checks.push(!rr.length ? { id: 'rail', label: 'Raildruck', state: 'none', value: '--', note: 'keine Werte' } : {
        id: 'rail', label: 'Raildruck', value: rMin, state: rMin < 0.75 ? 'check' : rMin < 0.85 ? 'watch' : 'ok',
        note: rMin < 0.85 ? 'bricht unter Last ein: Hochdruckpumpe?' : 'hält den Sollwert' });

    // ---- intake air: how much warmer than outside at the end
    const iat = ch(pull, 'iat'), amb = isNum(o.ambient) ? o.ambient : null;
    const rise = iat.length && amb !== null ? iat[iat.length - 1].v - amb : null;
    checks.push(rise === null ? { id: 'iat', label: 'Ansaugluft', state: 'none', value: '--', note: iat.length ? 'keine Außentemperatur' : 'keine Werte' } : {
        id: 'iat', label: 'Ansaugluft', value: rise, state: rise > 40 ? 'check' : rise > 25 ? 'watch' : 'ok',
        note: rise > 25 ? 'Hitzestau: Ladeluftkühler warm (nach Stop-and-go oder mehreren Pulls)' : 'kühl' });

    // ---- lambda: leaner than wanted at full load
    const lp = pairs(ch(pull, 'lambda'), ch(pull, 'lambdaTarget'), 800).filter((p) => steady(p[0]));
    const lean = lp.map((p) => p[0].v - p[1].v), lMax = lean.length ? Math.max.apply(null, lean) : null;
    checks.push(!lean.length ? { id: 'lambda', label: 'Gemisch', state: 'none', value: '--', note: 'keine Werte' } : {
        id: 'lambda', label: 'Gemisch', value: lMax, state: lMax > 0.08 ? 'check' : lMax > 0.04 ? 'watch' : 'ok',
        note: lMax > 0.04 ? 'magerer als gewollt: Kraftstoffversorgung?' : 'wie gewollt' });

    const gears = fast.map((s) => gearOf(s.rpm, s.speed)).filter(isNum);
    const gear = gears.length ? gears.sort((a, b) => gears.filter((x) => x === a).length - gears.filter((x) => x === b).length).pop() : null;
    return { checks, power: pw, peak, gear, state: checks.reduce((a, c) => worse(a, c.state), 'none'),
        boost: { target: bt.map((s) => [s.rpm, s.v]), actual: ba.map((s) => [s.rpm, s.v]) },
        rpm: fast.length ? [Math.min.apply(null, fast.map((s) => s.rpm)), Math.max.apply(null, fast.map((s) => s.rpm))] : null,
        speed: fast.length ? [fast[0].speed, fast[fast.length - 1].speed] : null, dur: fast.length ? (fast[fast.length - 1].t - t0) / 1000 : 0 };
}

/** The power (kW) of a pull's curve at rpm (straight lines between its points), or null outside it. */
function powerAt(power, rpm) {
    const pts = power.slice().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pts.length; i++) if (rpm >= pts[i - 1][0] && rpm <= pts[i][0] && pts[i][0] > pts[i - 1][0]) {
        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (rpm - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
    }
    return null;
}

/** The pull's mean power against a reference's over the rpm both cover (share, e.g. -0.04), or null. */
function versus(a, ref) {
    if (!a || !ref || !a.power.length || !ref.power.length) return null;
    const lo = Math.max(Math.min.apply(null, a.power.map((p) => p[0])), Math.min.apply(null, ref.power.map((p) => p[0])), 2500);
    const hi = Math.min(Math.max.apply(null, a.power.map((p) => p[0])), Math.max.apply(null, ref.power.map((p) => p[0])));
    if (hi - lo < 1000) return null;
    let s1 = 0, s2 = 0;
    for (let r = lo; r <= hi; r += 100) { const x = powerAt(a.power, r), y = powerAt(ref.power, r); if (isNum(x) && isNum(y)) { s1 += x; s2 += y; } }
    return s2 > 0 ? s1 / s2 - 1 : null;
}

module.exports = { analyze, gearOf, pairs, powerAt, versus };
