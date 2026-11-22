'use strict';
/**
 * tank.js - Sprit-Check's bookkeeping: tank fillings and what each fuel did.
 *
 *   const tk = new Tanks(state, { onFill(prev, cur) {} });
 *   tk.level(t, litres, odo, standing)   every tank reading: a rise of FILL_L or more that stays for 20 s is a filling
 *                                        candidate { litres, l, odo } (the app confirms it, then calls tk.fill)
 *   tk.fuel(litres)                      fuel used (from the flow) on the tank going on
 *   tk.load(retard)                      a knock control reading under load (° retarded)
 *   tk.cur, tk.st.tanks                  the tank going on, the finished ones
 *   compare(tanks, prices) -> per type: { type, n, km, cons, eur100, ron, retard, share }
 *
 * The consumption of a tank: the fuel the flow counted, when it covered most of the distance, else the drop of the
 * tank level (1 l steps, so only over a long distance). Prices: what the type cost when it was filled.
 */
const { isNum } = require('./lib_core');

const FILL_L = 5;              // a rise of the tank level this big while standing: a filling
const KEEP = 60;
const TYPES = ['e10', 'super', 'plus', 'premium'];
const TYPE_LABEL = { e10: 'Super E10', super: 'Super', plus: 'Super Plus', premium: 'Premium 100+' };

class Tanks {
    constructor(state, opts) {
        this.st = state;
        if (!Array.isArray(state.tanks)) state.tanks = [];
        if (state.cur === undefined) state.cur = null;
        this.o = opts || {};
        this.pending = null;       // a rise seen once, waiting to be seen again (the level settles after filling)
    }
    get cur() { return this.st.cur; }

    /** A tank level reading (litres) with the odometer (km); standing: the car not moving. Returns 'fill' or null. */
    level(t, l, odo, standing) {
        if (!isNum(l)) return null;
        const st = this.st, cur = st.cur;
        if (cur) {
            if (isNum(odo)) cur.odo1 = odo;
            cur.level1 = l;
            cur.t1 = t;
        }
        // the lowest level before the rise: the last reading (kept across starts, so a filling done while the head
        // unit slept is found at the next start)
        const before = isNum(st.lastLevel) ? st.lastLevel : null;
        if (before !== null && l - before >= FILL_L && (standing || !cur || t - (cur.t1 || 0) > 600000)) {
            if (!this.pending || Math.abs(this.pending.l - l) > 3) { this.pending = { t, l, before }; return null; }
            if (t - this.pending.t < 20000) return null;               // seen again 20 s later: it stays
            const p = this.pending;
            this.pending = null;
            st.lastLevel = l;                                          // (asked once: a refused candidate is not asked again)
            return { litres: l - p.before, l, odo };
        }
        this.pending = null;
        if (!(cur && before !== null && l > before)) st.lastLevel = l;    // (a small rise is the level sloshing: not lower)
        return null;
    }

    fill(t, l, litres, odo) {
        const st = this.st, prev = st.cur;
        if (prev) this.close(prev);
        const type = st.lastType || 'super';
        st.cur = { t0: t, t1: t, odo0: isNum(odo) ? odo : null, odo1: isNum(odo) ? odo : null, level0: l, level1: l, filled: Math.round(litres * 10) / 10,
            type, price: this.o.price ? this.o.price(type) : null, used: 0, usedKm: 0, n: 0, sum: 0, max: 0, over: 0, ron: null, ronKm: null, kqe: null, knockAdapt: null };
        st.lastLevel = l;
        if (this.o.onFill) this.o.onFill(prev, st.cur);
        return 'fill';
    }

    close(c) {
        const s = summary(c);
        if (s.km >= 5) {
            this.st.tanks.push(s);
            if (this.st.tanks.length > KEEP) this.st.tanks.splice(0, this.st.tanks.length - KEEP);
        }
        return s;
    }

    /** Fuel used (l) on the tank going on, over km driven (both from the flow, while it was known). */
    fuel(l, km) { const c = this.st.cur; if (c && isNum(l) && l > 0) { c.used += l; c.usedKm += isNum(km) ? km : 0; } }

    /** A knock control reading under load: retard in ° (0 = none). */
    load(retard) {
        const c = this.st.cur;
        if (!c || !isNum(retard)) return;
        const r = Math.max(0, retard);
        c.n++; c.sum += r; c.max = Math.max(c.max, r);
        if (r > 1.5) c.over++;
    }

    /** The type of the tank going on (the button), also the one the next filling starts with. */
    setType(type) {
        const c = this.st.cur;
        this.st.lastType = type;
        if (c) { c.type = type; if (this.o.price) c.price = this.o.price(type); }
    }
}

/** What a tank (going on or finished) amounts to. */
function summary(c) {
    const km = isNum(c.odo0) && isNum(c.odo1) ? c.odo1 - c.odo0 : 0;
    const drop = isNum(c.level0) && isNum(c.level1) ? c.level0 - c.level1 : null;
    // the flow when it counted most of the distance, else the level's drop (only from 150 km on: 1 l steps)
    const byFlow = c.used > 0 && km > 0 && c.usedKm >= km * 0.8;
    const used = byFlow ? c.used * km / Math.max(1, c.usedKm) : km >= 150 && isNum(drop) && drop > 0 ? drop : null;
    const cons = isNum(used) && km > 0 ? used / km * 100 : null;
    return { t0: c.t0, t1: c.t1, type: c.type, filled: c.filled, price: c.price, km: Math.round(km), used: isNum(used) ? Math.round(used * 10) / 10 : null,
        cons: isNum(cons) ? Math.round(cons * 100) / 100 : null, by: byFlow ? 'flow' : 'level', ron: c.ron, kqe: c.kqe, knockAdapt: c.knockAdapt,
        n: c.n, retard: c.n ? Math.round(c.sum / c.n * 100) / 100 : null, max: c.n ? c.max : null, share: c.n ? Math.round(c.over / c.n * 1000) / 1000 : null,
        cost: isNum(c.price) && isNum(c.filled) ? Math.round(c.price * c.filled * 100) / 100 : null };
}

/** Per fuel type over the tanks (summaries): km-weighted consumption and cost, means of RON and knock retard. */
function compare(tanks) {
    return TYPES.map((type) => {
        const xs = tanks.filter((s) => s.type === type);
        const withCons = xs.filter((s) => isNum(s.cons) && s.km > 0), km = withCons.reduce((a, s) => a + s.km, 0);
        const cons = km > 0 ? withCons.reduce((a, s) => a + s.cons * s.km, 0) / km : null;
        const priced = withCons.filter((s) => isNum(s.price)), kmP = priced.reduce((a, s) => a + s.km, 0);
        const eur100 = kmP > 0 ? priced.reduce((a, s) => a + s.cons * s.price * s.km, 0) / kmP : null;     // l/100 km x €/l
        const rons = xs.filter((s) => isNum(s.ron)).map((s) => s.ron);
        const nLoad = xs.reduce((a, s) => a + (s.n || 0), 0);
        return { type, label: TYPE_LABEL[type], n: xs.length, km: xs.reduce((a, s) => a + (s.km || 0), 0), cons, eur100,
            ron: rons.length ? rons.reduce((a, b) => a + b, 0) / rons.length : null,
            retard: nLoad ? xs.reduce((a, s) => a + (s.retard || 0) * (s.n || 0), 0) / nLoad : null,
            share: nLoad ? xs.reduce((a, s) => a + (s.share || 0) * (s.n || 0), 0) / nLoad : null, nLoad };
    });
}

/**
 * The verdict: each type with data against the cheapest one with data (per 100 km). Returns lines of text, or [].
 */
function verdict(rows, F) {
    const have = rows.filter((r) => isNum(r.cons) && isNum(r.eur100) && r.km >= 200);
    if (have.length < 2) return [];
    const base = have.reduce((a, r) => (r.eur100 < a.eur100 ? r : a));
    return have.filter((r) => r !== base).map((r) => {
        const dl = r.cons - base.cons, de = r.eur100 - base.eur100, dr = isNum(r.retard) && isNum(base.retard) ? r.retard - base.retard : null;
        return r.label + ' gegen ' + base.label + ': ' + (Math.abs(dl) < 0.05 ? 'gleicher Verbrauch' : F(Math.abs(dl), 2) + ' l/100 km ' + (dl < 0 ? 'weniger' : 'mehr'))
            + (isNum(dr) && Math.abs(dr) >= 0.1 ? ', ' + F(Math.abs(dr), 1) + '° ' + (dr < 0 ? 'weniger' : 'mehr') + ' Zündrücknahme' : '')
            + ', ' + F(Math.abs(de), 2) + ' € je 100 km ' + (de > 0 ? 'teurer' : 'günstiger');
    });
}

module.exports = { Tanks, summary, compare, verdict, TYPES, TYPE_LABEL, FILL_L };
