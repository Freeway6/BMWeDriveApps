'use strict';
/**
 * ev_coach.js - consumption by what it depends on: speed, outside temperature, driving mode, climate.
 *
 * A slice is the stretch between two readings of the battery's energy (about 10 s): the energy it lost
 * (net: recuperation already taken off), the distance, the mean speed, and the conditions then. Slices are
 * joined into pieces of at least CHUNK_KM (or CHUNK_H) before they go into the bins by their mean speed: a 10 s
 * slice speeding up from a stop would put the energy of the speeding up in the slow band and the recuperation of
 * the stop in a faster one. A bin's consumption is its kWh over its km. Pieces standing still (under 5 km/h on
 * average) count for the drive but not for the bins (their energy goes on time, not distance).
 *
 *   const c = new Coach(state);  c.slice({ km, kwh, h, amb, mode, climate });
 *   c.cons(c.bins.speed[i]) -> kWh/100 km or null      c.compare(slices) -> { exp, own } kWh as usual and as taken
 */
const { isNum, bandOf, bandLabels } = require('./ev_core');

const SPEED_EDGES = [30, 50, 70, 90, 110, 130];
const TEMP_EDGES = [0, 10, 20, 30];
const MIN_KM = 2;              // a bin with less is not shown (nor used as "usual")
const MIN_V = 5;
const CHUNK_KM = 0.5, CHUNK_H = 2 / 60;

const empty = () => ({ km: 0, kwh: 0 });

class Coach {
    constructor(state) {
        this.st = state;
        const b = state.bins || (state.bins = {});
        if (!Array.isArray(b.speed) || b.speed.length !== SPEED_EDGES.length + 1) b.speed = SPEED_EDGES.concat([0]).map(empty);
        if (!Array.isArray(b.temp) || b.temp.length !== TEMP_EDGES.length + 1) b.temp = TEMP_EDGES.concat([0]).map(empty);
        if (!b.mode) b.mode = {};
        if (!b.climate) b.climate = { on: empty(), off: empty() };
        if (!b.stand) b.stand = { h: 0, kwh: 0 };
    }
    get bins() { return this.st.bins; }

    /**
     * Add a slice: { km, kwh, h (hours), amb (°C), mode, climate (bool) }. It goes into the piece being joined;
     * a piece that is long enough goes into the bins. Returns the piece when one went in.
     */
    slice(s) {
        if (!s || !isNum(s.kwh) || !isNum(s.km) || s.km < 0) return null;
        const c = this.chunk || (this.chunk = { km: 0, kwh: 0, h: 0 });
        c.km += s.km; c.kwh += s.kwh; c.h += isNum(s.h) ? s.h : 0;
        c.amb = isNum(s.amb) ? s.amb : c.amb; c.mode = s.mode || c.mode;
        if (typeof s.climate === 'boolean') c.climate = s.climate;
        if (c.km < CHUNK_KM && c.h < CHUNK_H) return null;
        this.chunk = null;
        c.v = c.h > 0 ? c.km / c.h : null;
        this.add(c);
        return c;
    }

    /** A piece into the bins: { km, kwh, h, v, amb, mode, climate }. */
    add(c) {
        const b = this.st.bins;
        if (!isNum(c.v) || c.v < MIN_V) { b.stand.h += c.h || 0; b.stand.kwh += c.kwh; return false; }
        const add = (bin) => { bin.km += c.km; bin.kwh += c.kwh; };
        add(b.speed[bandOf(c.v, SPEED_EDGES)]);
        if (isNum(c.amb)) add(b.temp[bandOf(c.amb, TEMP_EDGES)]);
        if (c.mode) add(b.mode[c.mode] || (b.mode[c.mode] = empty()));
        if (typeof c.climate === 'boolean') add(b.climate[c.climate ? 'on' : 'off']);
        return true;
    }

    /** kWh/100 km of a bin, or null with too little in it. */
    cons(bin) { return bin && bin.km >= MIN_KM ? bin.kwh / bin.km * 100 : null; }

    /** The usual kWh/100 km at speed v: its band's, else the nearest band's that has enough. */
    usual(v) {
        const sp = this.st.bins.speed, i = bandOf(v, SPEED_EDGES);
        if (i < 0) return null;
        for (let d = 0; d < sp.length; d++) {
            for (const k of [i - d, i + d]) { if (k >= 0 && k < sp.length && isNum(this.cons(sp[k]))) return this.cons(sp[k]); }
        }
        return null;
    }

    /**
     * Slices (each { km, h, kwh }, in order) against the usual: { exp, own } - the kWh their moving pieces would
     * usually take and the kWh they took (pieces standing still left out of both), or null when nothing is learned
     * yet. Joined into pieces as the bins are; a piece's usual comes from its mean speed.
     */
    compare(slices) {
        let exp = 0, own = 0, any = false, c = { km: 0, h: 0, kwh: 0 };
        const piece = () => {
            const v = c.h > 0 ? c.km / c.h : null;
            if (isNum(v) && v >= MIN_V) {
                const u = this.usual(v);
                if (!isNum(u)) return false;
                exp += u * c.km / 100; own += c.kwh; any = true;
            }
            c = { km: 0, h: 0, kwh: 0 };
            return true;
        };
        for (const s of slices) {
            c.km += s.km || 0; c.h += isNum(s.h) ? s.h : 0; c.kwh += isNum(s.kwh) ? s.kwh : 0;
            if ((c.km >= CHUNK_KM || c.h >= CHUNK_H) && !piece()) return null;
        }
        if (c.km > 0 && !piece()) return null;
        return any ? { exp, own } : null;
    }

    /** What slices would usually take (kWh), or null: compare(slices).exp. */
    expected(slices) { const r = this.compare(slices); return r ? r.exp : null; }
}

/** The stretch of the last km of slices (newest last): { km, kwh, slices }. */
function lastKm(slices, km) {
    const out = [];
    let d = 0, e = 0;
    for (let i = slices.length - 1; i >= 0 && d < km; i--) { out.unshift(slices[i]); d += slices[i].km; e += slices[i].kwh; }
    return { km: d, kwh: e, slices: out };
}

module.exports = { Coach, lastKm, CHUNK_KM, CHUNK_H, SPEED_EDGES, TEMP_EDGES, SPEED_LABELS: bandLabels(SPEED_EDGES), TEMP_LABELS: bandLabels(TEMP_EDGES), MIN_KM, MIN_V };
