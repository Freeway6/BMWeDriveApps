'use strict';
/**
 * ev_regen.js - stops and slow-downs as the battery sees them: how much of the energy the car had to lose
 * came back into the battery.
 *
 * A braking event: the battery takes more than START_KW while the car moves, until it takes less than
 * END_KW for 2 s or the car stands. The energy that had to go: the kinetic energy between the speeds at its
 * start and end, less what air and tyres took meanwhile (ev_phys.js). What came back: the battery's power
 * added up. Their ratio is the event's recovery (drivetrain losses and the friction brakes take the rest; a
 * slope adds energy, so downhill events are left out of the ratio: more came back than the car had).
 *
 *   const b = new Braking({ car, onEvent(e) {} });
 *   b.sample(t, kwOut, kmh)       // every battery reading while driving (kwOut: + gives, - takes)
 *   e = { t, v0, v1, s (seconds), kwh (back), avail (kWh that had to go), eff (0..1 or null), peak (kW), decel (m/s²) }
 */
const { isNum } = require('./ev_core');
const { roadKw, kineticKwh, kmh: ms, CAR } = require('./ev_phys');

const START_KW = 3, END_KW = 1, END_MS = 2000, MIN_AVAIL = 0.01;     // kWh: 36 kJ (a stop from ~20 km/h)

class Braking {
    constructor(opts) {
        this.o = opts || {};
        this.car = this.o.car || CAR;
        this.ev = null;
        this.prev = null;
    }

    sample(t, kw, v) {
        if (!isNum(t) || !isNum(kw) || !isNum(v)) return null;
        const prev = this.prev;
        this.prev = { t, kw, v };
        const take = -kw;
        let e = this.ev;
        if (!e) {
            if (take > START_KW && v > 5) {
                // starts at the reading before (the car was already slowing between them)
                e = this.ev = { t0: prev ? prev.t : t, v0: prev ? Math.max(prev.v, v) : v, kwh: 0, road: 0, peak: take, low: 0, last: prev || this.prev };
            } else return null;
        }
        const dt = Math.min(3000, t - e.last.t) / 3600000;
        if (dt > 0) {
            e.kwh += Math.max(0, (take + -e.last.kw) / 2) * dt;
            e.road += roadKw(ms((v + e.last.v) / 2), this.car) * dt;
        }
        e.last = this.prev;
        e.peak = Math.max(e.peak, take);
        e.v1 = v; e.t1 = t;
        if (take < END_KW) { if (!e.low) e.low = t; } else e.low = 0;
        if ((e.low && t - e.low >= END_MS) || v < 2) return this.end();
        return null;
    }

    end() {
        const e = this.ev;
        this.ev = null;
        if (!e) return null;
        const kin = kineticKwh(ms(e.v0), ms(e.v1), this.car), avail = kin - e.road;
        const s = (e.t1 - e.t0) / 1000;
        const out = { t: e.t0, v0: Math.round(e.v0), v1: Math.round(e.v1), s: Math.round(s * 10) / 10, kwh: Math.round(e.kwh * 1000) / 1000,
            avail: Math.round(avail * 1000) / 1000, peak: Math.round(e.peak), decel: s > 0 ? Math.round((ms(e.v0) - ms(e.v1)) / s * 100) / 100 : null,
            eff: avail >= MIN_AVAIL && e.kwh <= avail * 1.05 ? Math.round(e.kwh / avail * 1000) / 1000 : null };
        if (this.o.onEvent) this.o.onEvent(out);
        return out;
    }
}

/** Recovery per braking strength: [{ label, lo, hi, n, eff (kWh-weighted), kwh }] from events with eff. */
const BANDS = [[0, 1, 'sanft'], [1, 2, 'mittel'], [2, 3, 'kräftig'], [3, 99, 'stark']];
function byStrength(events) {
    return BANDS.map((b) => {
        const xs = events.filter((e) => isNum(e.eff) && isNum(e.decel) && e.decel >= b[0] && e.decel < b[1]);
        const back = xs.reduce((a, e) => a + e.kwh, 0), avail = xs.reduce((a, e) => a + e.avail, 0);
        return { label: b[2], lo: b[0], hi: b[1], n: xs.length, eff: avail > 0 ? back / avail : null, kwh: back };
    });
}

module.exports = { Braking, byStrength, BANDS, START_KW, END_KW };
