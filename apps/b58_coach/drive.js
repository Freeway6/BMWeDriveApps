'use strict';
/**
 * drive.js - the Verbrauchs-Coach's bookkeeping: drives, their fuel against the usual, cold starts, months.
 *
 *   const rec = new Recorder(state, { ambient: () => °C, onClose(summary) {} });
 *   rec.speed(t, kmh)              every speed signal (the distance; drives start and end: lib/lib_trip.js)
 *   rec.fuel(t, l, ms, cond)       about every 10 s: the litres used since the last call and the time (ms) they cover,
 *                                  cond { amb, mode, climate, coolant }; a slice whose fuel is known for less than
 *                                  80 % of its time counts for the distance only
 *   rec.check(t)                   now and then: ends a drive the car has stopped
 *   rec.slices                     the drive going on, in slices: { t, km, l, h, v, amb, mode, climate, cold }
 *   rec.coach                      what the car usually takes (lib/lib_coach.js), learned from every warm drive
 *
 *   months(state, n, now) -> the last n months, oldest first: { key, label, km, l, lKm, trips, coldStarts, extra, never }
 *   coldStats(trips) -> { starts, extra (l per cold start), share (cold against warm at the same speeds), warmMin, warmKm, never }
 *
 * A drive against the usual: each warm piece's fuel against what such a piece usually takes (the same mean speed, or
 * idling for the time it stood), once the car has learned that. A cold engine (coolant under COLD_C) uses more: richer
 * mixture while warming up, the catalytic converter heated, thick oil. Its extra fuel: the cold pieces' fuel against
 * what the same pieces usually take warm.
 */
const { isNum } = require('./lib_core');
const { TripClock } = require('./lib_trip');
const { Coach, CHUNK_KM, CHUNK_H } = require('./lib_coach');

const COLD_C = 70;
const MAX_SLICES = 900;        // the drive going on: about 2.5 hours of 10 s slices
const KEEP_MONTHS = 13;
const MONTH = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;

function monthKey(t) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

/** A finished drive as it is kept. */
function summary(o) {
    const top = Object.keys(o.modes).sort((a, b) => o.modes[b] - o.modes[a])[0] || null;
    return { id: o.id, t0: o.t0, t1: o.t1, km: r2(o.km), l: r3(o.l), lKm: r2(o.lKm), cons: o.lKm > 0.5 ? r2(o.l / o.lKm * 100) : null,
        v: o.movingMs > 0 ? Math.round(o.km / (o.movingMs / 3600000)) : null, amb: isNum(o.amb) ? Math.round(o.amb) : null, mode: top,
        vs: o.expL > 0.1 ? r3(o.cmpL / o.expL - 1) : null, coldStart: o.coldStart, coldKm: r2(o.coldKm), coldMin: r1(o.coldH * 60),
        extra: o.coldExp > 0 ? r3(o.coldL - o.coldExp) : null, coldExp: r3(o.coldExp), coldL: r3(o.coldL),
        warmMin: isNum(o.warmMs) ? r1(o.warmMs / 60000) : null, warmKm: isNum(o.warmKm) ? r2(o.warmKm) : null, reason: o.reason };
}

/** A finished drive into its month. */
function addMonth(months, s) {
    const k = monthKey(s.t0);
    const m = months[k] || (months[k] = { km: 0, l: 0, lKm: 0, trips: 0, coldStarts: 0, never: 0, extra: 0, coldL: 0, coldExp: 0 });
    m.km += s.km || 0; m.l += s.l || 0; m.lKm += s.lKm || 0; m.trips++;
    if (s.coldStart) { m.coldStarts++; if (!isNum(s.warmMin)) m.never++; }
    if (isNum(s.extra)) { m.extra += s.extra; m.coldL += s.coldL || 0; m.coldExp += s.coldExp || 0; }
    const keys = Object.keys(months).sort();
    while (keys.length > KEEP_MONTHS) delete months[keys.shift()];
}

class Recorder {
    constructor(st, o) {
        this.st = st;
        this.o = o || {};
        if (!st.months || typeof st.months !== 'object') st.months = {};
        this.coach = new Coach(st);
        this.slices = [];
        this.prev = null;          // { t, km } at the last fuel call
        this.trips = new TripClock(st, {
            make: () => ({ l: 0, lKm: 0, cmpL: 0, expL: 0, amb: this.o.ambient ? this.o.ambient() : null, modes: {},
                coldStart: null, coldKm: 0, coldH: 0, coldL: 0, coldExp: 0, warmMs: null, warmKm: null }),
            onOpen: () => { this.slices.length = 0; this.prev = null; this.coach.chunk = null; },
            summary,
            onClose: (s) => { if (s) addMonth(st.months, s); if (this.o.onClose) this.o.onClose(s); },
        });
    }
    get open() { return this.trips.open; }
    speed(t, v) { this.trips.speed(t, v); }
    check(t) { return this.trips.check(t); }

    fuel(t, l, ms, cond) {
        const o = this.trips.open;
        cond = cond || {};
        if (!o) { this.prev = null; return null; }
        const p = this.prev;
        this.prev = { t, km: o.km };
        if (!p || t <= p.t || t - p.t > 60000) return null;           // the first call of a drive, or after a gap
        const km = Math.max(0, o.km - p.km), h = (t - p.t) / 3600000;
        const known = isNum(cond.coolant), cold = known && cond.coolant < COLD_C;
        if (o.coldStart === null && known) o.coldStart = cold;
        if (o.coldStart && !cold && known && o.warmMs === null) { o.warmMs = t - o.t0; o.warmKm = o.km; }
        if (cold) { o.coldKm += km; o.coldH += h; }
        if (!isNum(l) || l < 0 || !(ms >= (t - p.t) * 0.8)) return null;    // the fuel not known for most of it
        const s = { t, km, l, h, v: km / h, amb: cond.amb, mode: cond.mode, climate: cond.climate, cold };
        // the piece this slice completes (if it does), against what it usually takes warm - worked out before the
        // piece itself is in the bins
        const c = this.coach.chunk;
        const piece = { km: (c ? c.km : 0) + km, h: (c ? c.h : 0) + h, l: (c ? c.l : 0) + l, cold: !!((c && c.cold) || cold) };
        const ex = piece.km >= CHUNK_KM || piece.h >= CHUNK_H ? this.coach.warm(piece) : null;
        this.coach.slice(s);
        if (isNum(ex)) {
            if (piece.cold) { o.coldExp += ex; o.coldL += piece.l; } else { o.expL += ex; o.cmpL += piece.l; }
        }
        o.l += l; o.lKm += km;
        if (cond.mode) o.modes[cond.mode] = (o.modes[cond.mode] || 0) + km;
        this.slices.push(s);
        if (this.slices.length > MAX_SLICES) this.slices.shift();
        return s;
    }
}

/** The last n months (oldest first), empty ones too: { key, label, km, l, lKm, trips, coldStarts, never, extra }. */
function months(st, n, now) {
    const out = [], d = new Date(now || Date.now());
    for (let i = n - 1; i >= 0; i--) {
        const m = new Date(d.getFullYear(), d.getMonth() - i, 15), k = monthKey(m.getTime());
        out.push(Object.assign({ key: k, label: MONTH[m.getMonth()], km: 0, l: 0, lKm: 0, trips: 0, coldStarts: 0, never: 0, extra: 0, coldL: 0, coldExp: 0 },
            (st.months || {})[k] || {}));
    }
    return out;
}

const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Cold starts over drives (summaries). */
function coldStats(trips) {
    const cs = trips.filter((s) => s.coldStart);
    const priced = cs.filter((s) => isNum(s.extra));
    const L = priced.reduce((a, s) => a + (s.coldL || 0), 0), E = priced.reduce((a, s) => a + (s.coldExp || 0), 0);
    const warmed = cs.filter((s) => isNum(s.warmMin));
    return { starts: cs.length, drives: trips.length, known: priced.length,
        extra: priced.length ? priced.reduce((a, s) => a + s.extra, 0) / priced.length : null,
        share: E > 0.05 ? L / E - 1 : null,
        warmMin: median(warmed.map((s) => s.warmMin)), warmKm: median(warmed.map((s) => s.warmKm).filter(isNum)),
        never: cs.length - warmed.length };
}

module.exports = { Recorder, summary, months, monthKey, coldStats, COLD_C, MONTH };
