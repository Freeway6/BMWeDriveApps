'use strict';
/**
 * ev_livedoc.js - what Charge Curve sends to the iPhone and the Watch (lib/ev_live.js carries it, encrypted):
 *
 * state (every few seconds while charging, every 5 minutes else):
 *   { v: 1, seq, t,                       t: the head unit's clock (ms); the phone goes by the relay's clock instead
 *     phase: 'charging' | 'idle', kind: 'DC' | 'AC' | null,
 *     soc, kw, cellT, cellTmax, stored, cap, target,           (%, kW into the battery, °C, kWh, %)
 *     session: { id, t0, soc0, kwh, peak, peakSoc, cost } | null,
 *     fc: [[minutes from t, soc, kW], ...] | null,             the rest of the charge as expected now, to 100 %
 *     last: { id, t0, t1, kind, soc0, soc1, kwh, peak, avg, cost, partial } | null,   the last charge, when idle
 *     link: the battery unit answers }
 *
 * curve (when the charge's curve has grown, at most every minute):
 *   { v: 1, seq, id, live, kind, t0,
 *     pts: [[minutes from t0, soc, kW, cellT], ...],          this charge (or the last one) as recorded
 *     ref: { id, t0, pts: [[soc, kW], ...] } | null,           its reference (lib/ev_charge.js reference())
 *     exp: { cellT, pts: [[soc, kW], ...] } }                  what the model expects at the cells' temperature now
 *
 * The forecast follows Charge Curve's own time to target: the expected curve (lib/ev_model.js, learned from this
 * car's charges) scaled to what the charge takes now, never more than its peak so far (the station's limit), the
 * cells warming as they charge. AC: the power now, a little less over 95 %.
 */
const { isNum, clamp } = require('./ev_core');
const M = require('./ev_model');
const { reference, DC_KW } = require('./ev_charge');

const r1 = (x) => (isNum(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);

/** [[minutes, soc, kW], ...] from soc now to 100 %, every 2 % (and the start). o: { battery, grid, peak, ac }. */
function forecast(soc, cellT, kwNow, o) {
    o = o || {};
    if (!isNum(soc) || !isNum(kwNow) || kwNow < 0.5) return null;
    const pts = [[0, r1(soc), r1(kwNow)]];
    if (soc >= 99.9) return pts;
    const bat = M.BATTERIES[o.battery] || M.BATTERIES['83.9'], kwhPct = bat.usable / 100;
    const opt = { battery: o.battery, grid: o.grid };
    let t = isNum(cellT) ? cellT : 25, min = 0, s = soc;
    const f = o.ac ? 1 : clamp(kwNow / Math.max(1, M.expectKw(soc, t, opt)), 0.3, 1.3);
    const cap = isNum(o.peak) && o.peak > 5 ? o.peak : Infinity;
    while (s < 100) {
        const next = Math.min(100, Math.floor(s) + 1), mid = (s + next) / 2;
        const kw = o.ac ? Math.max(0.5, kwNow * (mid > 95 ? 0.6 : 1)) : Math.max(1, Math.min(cap, M.expectKw(mid, t, opt) * f));
        const h = kwhPct * (next - s) / kw;
        min += h * 60;
        if (!o.ac && t < 35) t = Math.min(35, t + 0.025 * kw * h * 3600 / 600 + (t < 20 ? M.HEAT_CHARGING * h * 60 : 0));
        s = next;
        if (s % 2 === 0 || s === 100) pts.push([r1(min), s, r1(kw)]);
    }
    return pts;
}

/** Minutes until soc reaches target on a forecast, or null. */
function minutesTo(fc, target) {
    if (!fc || !fc.length || !isNum(target)) return null;
    if (fc[0][1] >= target) return 0;
    for (let i = 1; i < fc.length; i++) {
        const a = fc[i - 1], b = fc[i];
        if (b[1] >= target) return a[0] + (b[0] - a[0]) * (target - a[1]) / (b[1] - a[1]);
    }
    return null;
}

const kindOf = (s) => (s.dc || s.kind === 'DC' || s.peak > DC_KW ? 'DC' : 'AC');
/** What a session cost: kWh into the battery x losses x the price set for its kind. o: { price: { DC, AC }, loss: { DC, AC } }. */
function costOf(s, o) {
    const k = kindOf(s), p = o.price && o.price[k], l = (o.loss && o.loss[k]) || 1;
    return isNum(s.kwh) && p > 0 ? r2(s.kwh * l * p) : null;
}

/**
 * The state. v: the recorder's view { st, open, now, cellT, link }; o: { t, seq, target, battery, price, loss }.
 */
function stateDoc(v, o) {
    const n = v.now || {}, op = v.open || null, st = v.st || { sessions: [] }, t = o.t || Date.now();
    const soc = isNum(n.soc) ? n.soc : op ? op.soc1 : null;
    const doc = {
        v: 1, seq: isNum(o.seq) ? o.seq : t, t, phase: op ? 'charging' : 'idle', kind: op ? kindOf(op) : null,
        soc: r1(soc), kw: op && isNum(n.kwIn) ? r1(Math.max(0, n.kwIn)) : null, cellT: r1(v.cellT), cellTmax: r1(n.temp && n.temp.max),
        stored: r2(n.energy && n.energy.stored), cap: r1(n.energy && n.energy.cap), target: isNum(o.target) ? o.target : 80,
        session: null, fc: null, last: null, link: !!v.link,
    };
    if (op) {
        doc.session = { id: op.id, t0: op.t0, soc0: r1(op.soc0), kwh: r2(op.kwh), peak: r1(op.peak), peakSoc: r1(op.peakSoc), cost: costOf(op, o) };
        doc.fc = forecast(soc, v.cellT, doc.kw, { battery: o.battery, grid: st.grid, peak: op.peak, ac: doc.kind === 'AC' });
    } else {
        const s = st.sessions && st.sessions[st.sessions.length - 1];
        if (s) doc.last = { id: s.id, t0: s.t0, t1: s.t1, kind: s.kind, soc0: r1(s.soc0), soc1: r1(s.soc1), kwh: r2(s.kwh), peak: r1(s.peak), avg: r1(s.avg), cost: costOf(s, o), partial: !!s.partial };
    }
    return doc;
}

/** The curve of the charge going on, else of the last one. v, o: as stateDoc. */
function curveDoc(v, o) {
    const st = v.st || { sessions: [] }, op = v.open || null, t = o.t || Date.now();
    const s = op || (st.sessions && st.sessions[st.sessions.length - 1]) || null;
    const cT = isNum(v.cellT) ? v.cellT : 25;
    const exp = [];
    for (let q = 0; q <= 100; q += 5) exp.push([q, r1(M.expectKw(q, cT, { battery: o.battery, grid: st.grid }))]);
    if (!s) return { v: 1, seq: isNum(o.seq) ? o.seq : t, id: null, live: false, kind: null, t0: null, pts: [], ref: null, exp: { cellT: r1(cT), pts: exp } };
    // (a charge going on has no kind yet, only its dc flag: reference() compares kinds)
    const ref = reference(st.sessions || [], Object.assign({}, s, { kind: kindOf(s) }), st.pinned);
    const two = (p) => isNum(p[1]) && isNum(p[2]);
    return {
        v: 1, seq: isNum(o.seq) ? o.seq : t, id: s.id, live: !!op, kind: kindOf(s), t0: s.t0,
        pts: (s.points || []).map((p) => [p[0], p[1], p[2], p[3]]),
        ref: ref ? { id: ref.id, t0: ref.t0, pts: (ref.points || []).filter(two).map((p) => [p[1], p[2]]) } : null,
        exp: { cellT: r1(cT), pts: exp },
    };
}

module.exports = { forecast, minutesTo, stateDoc, curveDoc, costOf };
