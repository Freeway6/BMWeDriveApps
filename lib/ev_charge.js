'use strict';
/**
 * ev_charge.js - charge sessions from the battery's readings: when one starts and ends, the energy it put in,
 * its curve (power over charge level) and how long each 10 % took.
 *
 *   const tr = new ChargeTracker(state, { onClose(session) {} });
 *   tr.sample({ t, kwIn, soc, cellT, cellTmax, speed, stored, odo, dc });   // kwIn: kW into the battery
 *   tr.resume(t, soc)          // at a start: a session the head unit slept through is closed
 *
 * state (persisted by the app): { sessions: [summary], open: session | null }.
 * A summary: { id, t0, t1, soc0, soc1, kwh, peak, peakSoc, avg, kind 'DC' | 'AC', temp0, temp1, tmax,
 *   odo, reason, partial, cross: { '10': t, '20': t, ... }, points: [[min, soc, kw, cellT], ...] }.
 */
const { isNum } = require('./ev_core');

const START_KW = 1.2;          // kW into the battery while standing: a charge (the car draws ~0.3-3 kW out when it stands)
const STOP_KW = 0.4;
const STOP_MS = 90000;         // under STOP_KW this long: the charge has ended
const GAP_MS = 120000;         // readings further apart are not joined (the head unit slept in between)
const ASLEEP_MS = 10 * 60000;  // a session whose last reading is older than this at a start: the head unit slept
const MAX_POINTS = 160;
const MAX_SESSIONS = 60;
const DC_KW = 11.5;            // more than an AC charger gives (the i4 takes at most 11 kW AC)

class ChargeTracker {
    constructor(state, opts) {
        this.st = state;
        if (!Array.isArray(state.sessions)) state.sessions = [];
        if (state.open === undefined) state.open = null;
        this.o = opts || {};
        this.startN = 0;
        this.lowSince = 0;
        this.last = null;
    }

    get open() { return this.st.open; }

    /** A reading. Returns 'start', 'end' or null. */
    sample(s) {
        if (!s || !isNum(s.t)) return null;
        const o = this.st.open, kwIn = isNum(s.kwIn) ? s.kwIn : null;
        const still = !isNum(s.speed) || s.speed < 1;
        if (!o) {
            if (kwIn !== null && kwIn >= START_KW && still) {
                if (++this.startN === 1) this.first = s;
                if (this.startN >= 2) { this.begin(this.first, s); return 'start'; }
            } else this.startN = 0;
            this.last = s;
            return null;
        }
        if (isNum(s.speed) && s.speed > 3) { this.close('drove off'); return 'end'; }
        // the energy between this reading and the last one (not across a gap)
        const prev = o.lastS;
        if (prev && kwIn !== null && isNum(prev.kwIn) && s.t - prev.t < GAP_MS && s.t > prev.t) {
            o.kwh += Math.max(0, (kwIn + prev.kwIn) / 2) * (s.t - prev.t) / 3600000;
            o.chargeMs += kwIn > STOP_KW ? s.t - prev.t : 0;
        }
        if (kwIn !== null) {
            if (kwIn > o.peak) { o.peak = kwIn; o.peakSoc = isNum(s.soc) ? s.soc : o.soc1; }
            if (kwIn > DC_KW) o.dc = true;
        }
        if (s.dc === 1) o.dc = true;
        if (isNum(s.soc)) this.cross(o, s.soc, s.t);
        if (isNum(s.soc)) o.soc1 = s.soc;
        if (isNum(s.cellT)) { if (!isNum(o.temp0)) o.temp0 = s.cellT; o.temp1 = s.cellT; o.tmax = Math.max(isNum(o.tmax) ? o.tmax : -99, isNum(s.cellTmax) ? s.cellTmax : s.cellT); }
        if (isNum(s.stored)) { if (!isNum(o.stored0)) o.stored0 = s.stored; o.stored1 = s.stored; }
        o.t1 = s.t;
        o.lastS = { t: s.t, kwIn };
        this.point(o, s, kwIn);
        // the end: low power for STOP_MS (the charger stopped, or the car is full)
        if (kwIn !== null && kwIn < STOP_KW) {
            if (!this.lowSince) this.lowSince = s.t;
            if (s.t - this.lowSince >= STOP_MS) { this.close('done'); return 'end'; }
        } else if (kwIn !== null) this.lowSince = 0;
        return null;
    }

    /** A charge from reading s (the first with power going in) on; s2: the reading that confirmed it. */
    begin(s, s2) {
        const prevSoc = this.last && isNum(this.last.soc) ? this.last.soc : null;
        this.st.open = { id: s.t, t0: s.t, t1: s.t, soc0: isNum(s.soc) ? s.soc : prevSoc, soc1: isNum(s.soc) ? s.soc : prevSoc,
            kwh: 0, chargeMs: 0, peak: 0, peakSoc: null, dc: s.dc === 1, temp0: isNum(s.cellT) ? s.cellT : null, temp1: null, tmax: null,
            odo: isNum(s.odo) ? s.odo : null, stored0: isNum(s.stored) ? s.stored : null, stored1: null, cross: {}, points: [], lastS: null, lastPt: null };
        this.lowSince = 0;
        this.startN = 0;
        // both readings count
        this.sample(s);
        if (s2 && s2 !== s) this.sample(s2);
        if (this.o.onStart) this.o.onStart(this.st.open);
    }

    /** The time each 10 % mark was passed (interpolated between two readings). */
    cross(o, soc, t) {
        const p = o.crossLast;
        if (!p && soc % 10 === 0) o.cross[String(soc)] = t;
        if (p && soc > p.soc) {
            for (let m = Math.ceil(p.soc / 10) * 10; m <= soc && m <= 100; m += 10) {
                if (m > p.soc && !(String(m) in o.cross)) o.cross[String(m)] = Math.round(p.t + (t - p.t) * (m - p.soc) / (soc - p.soc));
            }
        }
        if (!p || soc >= p.soc) o.crossLast = { soc, t };
    }

    /** A point of the curve when the charge moved 0.5 % or 30 s went by; thinned to MAX_POINTS. */
    point(o, s, kwIn) {
        if (kwIn !== null && kwIn < STOP_KW) return;            // (the charger ramping down at the end: not the curve)
        const lp = o.lastPt;
        const soc = isNum(s.soc) ? s.soc : o.soc1;
        if (lp && !(isNum(soc) && Math.abs(soc - lp.soc) >= 0.5) && s.t - lp.t < 30000) return;
        o.points.push([Math.round((s.t - o.t0) / 6000) / 10, isNum(soc) ? Math.round(soc * 10) / 10 : null,
            kwIn === null ? null : Math.round(kwIn * 10) / 10, isNum(s.cellT) ? Math.round(s.cellT * 10) / 10 : null]);
        o.lastPt = { t: s.t, soc };
        if (o.points.length > MAX_POINTS) o.points = o.points.filter((p, i) => i % 2 === 0 || i === o.points.length - 1);
    }

    /** At a start: a session whose last reading is long ago was slept through; soc: the charge now (if known). */
    resume(t, soc) {
        const o = this.st.open;
        if (!o || t - o.t1 < ASLEEP_MS) return false;
        if (isNum(soc) && (!isNum(o.soc1) || soc > o.soc1)) {
            o.soc1 = soc;
            o.partial = true;
        }
        this.close('asleep');
        return true;
    }

    /** End the open session: kept when it added something (1 % or 0.5 kWh). Returns the summary or null. */
    close(reason) {
        const o = this.st.open;
        this.st.open = null;
        this.lowSince = 0;
        if (!o) return null;
        const gain = isNum(o.soc0) && isNum(o.soc1) ? o.soc1 - o.soc0 : 0;
        if (gain < 1 && o.kwh < 0.5) return null;
        const hours = o.chargeMs / 3600000;
        const sum = {
            id: o.id, t0: o.t0, t1: o.t1, soc0: o.soc0, soc1: o.soc1, kwh: Math.round(o.kwh * 100) / 100,
            peak: Math.round(o.peak * 10) / 10, peakSoc: o.peakSoc, avg: hours > 0.01 ? Math.round(o.kwh / hours * 10) / 10 : null,
            kind: o.dc ? 'DC' : 'AC', temp0: o.temp0, temp1: o.temp1, tmax: o.tmax, odo: o.odo, reason, partial: !!o.partial,
            storedKwh: isNum(o.stored0) && isNum(o.stored1) ? Math.round((o.stored1 - o.stored0) * 100) / 100 : null,
            cross: o.cross, points: o.points,
        };
        this.st.sessions.push(sum);
        if (this.st.sessions.length > MAX_SESSIONS) this.st.sessions.splice(0, this.st.sessions.length - MAX_SESSIONS);
        if (this.o.onClose) this.o.onClose(sum);
        return sum;
    }
}

/** Minutes between two 10 % marks of a session (e.g. 10 -> 80), or null when it did not pass both. */
function between(s, a, b) {
    const c = (s && s.cross) || {};
    return isNum(c[String(a)]) && isNum(c[String(b)]) ? (c[String(b)] - c[String(a)]) / 60000 : null;
}

/**
 * The widest whole 10 % span a session passed, e.g. { a: 20, b: 70, min: 24.5 } (10 -> 80 when it has it), or
 * null: sessions starting and ending at different levels are compared over what they have.
 */
function span(s) {
    const marks = Object.keys((s && s.cross) || {}).map(Number).filter((m) => isNum(s.cross[String(m)])).sort((x, y) => x - y);
    if (marks.length < 2) return null;
    const full = marks.indexOf(10) >= 0 && marks.indexOf(80) >= 0;
    const a = full ? 10 : marks[0], b = full ? 80 : marks[marks.length - 1];
    return { a, b, min: between(s, a, b) };
}

/** Power at a charge level, read off a session's curve (points [min, soc, kw, T]); null outside it. */
function kwAt(s, soc) {
    const pts = ((s && s.points) || []).filter((p) => isNum(p[1]) && isNum(p[2]));
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (soc >= a[1] && soc <= b[1] && b[1] > a[1]) return a[2] + (b[2] - a[2]) * (soc - a[1]) / (b[1] - a[1]);
    }
    return null;
}

/**
 * The reference for comparing: the session pinned, else the session of the same kind (DC, AC) with the highest
 * mean power over the charge range it shares with s (at least 15 % of it). null when there is none.
 */
function reference(sessions, s, pinnedId) {
    if (pinnedId != null) { const p = sessions.find((x) => x.id === pinnedId); if (p && (!s || p.id !== s.id)) return p; }
    if (!s) return null;
    let best = null, bestKw = 0;
    sessions.forEach((x) => {
        if (x.id === s.id || x.kind !== s.kind) return;
        const lo = Math.max(isNum(s.soc0) ? s.soc0 : 0, isNum(x.soc0) ? x.soc0 : 0), hi = Math.min(isNum(s.soc1) ? s.soc1 : 100, isNum(x.soc1) ? x.soc1 : 100);
        if (hi - lo < 15) return;
        let sum = 0, n = 0;
        for (let q = lo; q <= hi; q += 1) { const k = kwAt(x, q); if (isNum(k)) { sum += k; n++; } }
        if (n && sum / n > bestKw) { bestKw = sum / n; best = x; }
    });
    return best;
}

module.exports = { ChargeTracker, between, span, kwAt, reference, START_KW, STOP_KW, STOP_MS, ASLEEP_MS, DC_KW, MAX_POINTS };
