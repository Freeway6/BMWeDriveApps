'use strict';
/**
 * lib_coach.js - fuel consumption by what it depends on: speed, outside temperature, driving mode, climate, a cold engine.
 *
 * A slice is the stretch of about 10 s between two readings: the fuel used, the distance, the mean speed, and the
 * conditions then. Slices are joined into pieces of at least CHUNK_KM (or CHUNK_H) before they go into the bins by
 * their mean speed: a 10 s slice speeding up from a stop would put the fuel of the speeding up in the slow band and
 * the coasting to the next stop (no fuel) in a faster one. A bin's consumption is its litres over its km
 * (l/100 km). Pieces standing still (under 5 km/h on average) count for the drive but not for the bins (their fuel
 * goes on time, not distance: idling, l/h). Pieces with a cold engine go into their own bin (bins.cold) and not into
 * the others: a cold engine uses more, and "usual" means warm.
 *
 *   const c = new Coach(state);  c.slice({ km, l, h, amb, mode, climate });
 *   c.cons(c.bins.speed[i]) -> l/100 km or null      c.compare(slices) -> { exp, own } litres as usual and as used
 *   c.vs(c.bins.temp[i]) -> the bin against the usual at the same speeds (0.09: 9 % more) or null
 *   c.warm(piece) -> litres the piece would usually take with a warm engine       c.idle() -> l/h idling
 *   c.warmAll(slices) -> the same for slices joined into pieces (standing included)
 */
const { isNum, bandOf, bandLabels } = require('./lib_core');

const SPEED_EDGES = [30, 50, 70, 90, 110, 130];
const TEMP_EDGES = [0, 10, 20, 30];
const MIN_KM = 2;              // a bin with less is not shown (nor used as "usual")
const MIN_VS_KM = 5;           // a condition's bin against the usual: from this much on
const MIN_V = 5;
const CHUNK_KM = 0.5, CHUNK_H = 2 / 60;

const empty = () => ({ km: 0, l: 0 });

class Coach {
    constructor(state) {
        this.st = state;
        const b = state.bins || (state.bins = {});
        if (!Array.isArray(b.speed) || b.speed.length !== SPEED_EDGES.length + 1) b.speed = SPEED_EDGES.concat([0]).map(empty);
        if (!Array.isArray(b.temp) || b.temp.length !== TEMP_EDGES.length + 1) b.temp = TEMP_EDGES.concat([0]).map(empty);
        if (!b.mode) b.mode = {};
        if (!b.climate) b.climate = { on: empty(), off: empty() };
        if (!b.stand) b.stand = { h: 0, l: 0 };
        if (!b.cold) b.cold = { km: 0, l: 0, h: 0 };
    }
    get bins() { return this.st.bins; }

    /**
     * Add a slice: { km, l, h (hours), amb (°C), mode, climate (bool) }. It goes into the piece being joined;
     * a piece that is long enough goes into the bins. Returns the piece when one went in.
     */
    slice(s) {
        if (!s || !isNum(s.l) || !isNum(s.km) || s.km < 0) return null;
        const c = this.chunk || (this.chunk = { km: 0, l: 0, h: 0 });
        c.km += s.km; c.l += s.l; c.h += isNum(s.h) ? s.h : 0;
        c.amb = isNum(s.amb) ? s.amb : c.amb; c.mode = s.mode || c.mode;
        if (typeof s.climate === 'boolean') c.climate = s.climate;
        if (s.cold) c.cold = true;
        if (c.km < CHUNK_KM && c.h < CHUNK_H) return null;
        this.chunk = null;
        c.v = c.h > 0 ? c.km / c.h : null;
        this.add(c);
        return c;
    }

    /** A piece into the bins: { km, l, h, v, amb, mode, climate }. */
    add(c) {
        const b = this.st.bins;
        if (c.cold) { b.cold.km += c.km; b.cold.l += c.l; b.cold.h += c.h || 0; return false; }
        if (!isNum(c.v) || c.v < MIN_V) { b.stand.h += c.h || 0; b.stand.l += c.l; return false; }
        // what such a piece usually takes, worked out before it is in the bins: each condition against the usual at
        // the speeds it was driven (ex: those litres, lx: the litres it took)
        const u = this.usual(c.v), ex = isNum(u) ? u * c.km / 100 : null;
        const add = (bin) => { bin.km += c.km; bin.l += c.l; if (isNum(ex)) { bin.ex = (bin.ex || 0) + ex; bin.lx = (bin.lx || 0) + c.l; } };
        add(b.speed[bandOf(c.v, SPEED_EDGES)]);
        if (isNum(c.amb)) add(b.temp[bandOf(c.amb, TEMP_EDGES)]);
        if (c.mode) add(b.mode[c.mode] || (b.mode[c.mode] = empty()));
        if (typeof c.climate === 'boolean') add(b.climate[c.climate ? 'on' : 'off']);
        return true;
    }

    /** l/100 km of a bin, or null with too little in it. */
    cons(bin) { return bin && bin.km >= MIN_KM ? bin.l / bin.km * 100 : null; }

    /** A bin against the usual at the speeds it was driven (0.09: 9 % more), or null with too little in it. */
    vs(bin) { return bin && bin.km >= MIN_VS_KM && bin.ex > 0 && bin.lx > 0 ? bin.lx / bin.ex - 1 : null; }

    /** The usual l/100 km at speed v: its band's, else the nearest band's that has enough. */
    usual(v) {
        const sp = this.st.bins.speed, i = bandOf(v, SPEED_EDGES);
        if (i < 0) return null;
        for (let d = 0; d < sp.length; d++) {
            for (const k of [i - d, i + d]) { if (k >= 0 && k < sp.length && isNum(this.cons(sp[k]))) return this.cons(sp[k]); }
        }
        return null;
    }

    /**
     * Slices (each { km, h, l }, in order) against the usual: { exp, own } - the litres their moving pieces would
     * usually take and the litres they took (pieces standing still left out of both), or null when nothing is learned
     * yet. Joined into pieces as the bins are; a piece's usual comes from its mean speed.
     */
    compare(slices) {
        let exp = 0, own = 0, any = false, c = { km: 0, h: 0, l: 0 };
        const piece = () => {
            const v = c.h > 0 ? c.km / c.h : null;
            if (isNum(v) && v >= MIN_V && !c.cold) {
                const u = this.usual(v);
                if (!isNum(u)) return false;
                exp += u * c.km / 100; own += c.l; any = true;
            }
            c = { km: 0, h: 0, l: 0 };
            return true;
        };
        for (const s of slices) {
            c.km += s.km || 0; c.h += isNum(s.h) ? s.h : 0; c.l += isNum(s.l) ? s.l : 0;
            if (s.cold) c.cold = true;
            if ((c.km >= CHUNK_KM || c.h >= CHUNK_H) && !piece()) return null;
        }
        if (c.km > 0 && !piece()) return null;
        return any ? { exp, own } : null;
    }

    /** What slices would usually take (l), or null: compare(slices).exp. */
    expected(slices) { const r = this.compare(slices); return r ? r.exp : null; }

    /** l/h idling with a warm engine (standing pieces), or null with too little of it. */
    idle() { const s = this.st.bins.stand; return s.h >= 0.05 ? s.l / s.h : null; }

    /**
     * What a piece ({ km, h, l }) would usually take with a warm engine (l), or null when not learned yet: moving,
     * the usual at its mean speed; standing, the usual idling over its time. For cold pieces: what the cold cost.
     */
    warm(c) {
        if (!c || !isNum(c.h) || c.h <= 0 || !isNum(c.km)) return null;
        const v = c.km / c.h;
        if (v >= MIN_V) { const u = this.usual(v); return isNum(u) ? u * c.km / 100 : null; }
        const i = this.idle();
        return isNum(i) ? i * c.h : null;
    }

    /** What slices (in order) would usually take with a warm engine, standing still included (l), or null. */
    warmAll(slices) {
        let sum = 0, c = { km: 0, h: 0 };
        const piece = () => { const x = this.warm(c); c = { km: 0, h: 0 }; if (!isNum(x)) return false; sum += x; return true; };
        for (const s of slices) {
            c.km += s.km || 0; c.h += isNum(s.h) ? s.h : 0;
            if ((c.km >= CHUNK_KM || c.h >= CHUNK_H) && !piece()) return null;
        }
        if (c.h > 0 && !piece()) return null;
        return sum;
    }
}

/** The stretch of the last km of slices (newest last): { km, l, slices }. */
function lastKm(slices, km) {
    const out = [];
    let d = 0, e = 0;
    for (let i = slices.length - 1; i >= 0 && d < km; i--) { out.unshift(slices[i]); d += slices[i].km; e += slices[i].l; }
    return { km: d, l: e, slices: out };
}

module.exports = { Coach, lastKm, CHUNK_KM, CHUNK_H, SPEED_EDGES, TEMP_EDGES, SPEED_LABELS: bandLabels(SPEED_EDGES), TEMP_LABELS: bandLabels(TEMP_EDGES), MIN_KM, MIN_V };
