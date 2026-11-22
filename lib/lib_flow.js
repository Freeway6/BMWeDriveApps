'use strict';
/**
 * lib_flow.js - the fuel flow (l/h) and the fuel used (l).
 *
 * The car sends a fuel injection counter by itself (CDS2.statusInjectionVolume, 16 bit, it wraps); its rate in counts
 * a second, times a factor, is the flow in l/h. The factor is learned from the engine unit's own fuel consumption
 * (DME 5656, ml/s) while both are known: the middle of the last ratios once they agree. Until then, and to check,
 * the engine unit's figure is read. After the Flow of idrive7-apps' Live Data (apps/live_data/signals.js, MIT).
 *
 *   const f = new Flow(savedK);
 *   f.feed(raw, t)        each counter value the car sends
 *   f.learn(lph, t)       the engine unit's l/h at about t: true when the factor changed
 *   f.lph(t)              l/h now from the counter (null until learned)
 *
 *   const u = new Used();  u.add(lph, t)  -> litres since the last add (the mean of the two flows over the time between,
 *                          nothing across a gap of more than 5 s); u.dt: the time they cover (ms)
 */
const isNum = (v) => typeof v === 'number' && isFinite(v);

class Flow {
    constructor(k) { this.k = isNum(k) && k > 0 ? k : null; this.last = null; this.acc = 0; this.accT = 0; this.rate = null; this.rateT = 0; this.ratios = []; this.spread = null; }
    feed(raw, t) {
        if (!isNum(raw)) return;
        if (this.last && t > this.last.t) {
            const d = (raw - this.last.raw + 65536) % 65536, dt = t - this.last.t;
            if (dt > 5000 || d > 40000) { this.acc = 0; this.accT = 0; }               // a gap or a reset: start again
            else {
                this.acc += d; this.accT += dt;
                if (this.accT >= 1000) { this.rate = this.acc / this.accT * 1000; this.rateT = t; this.acc = 0; this.accT = 0; }
            }
        }
        this.last = { raw, t };
    }
    /** counts a second now (0 once the counter stopped changing for 3 s: engine off) */
    rateAt(now) {
        if (!this.last) return null;
        if (now - this.last.t > 3000) return 0;
        return this.rate;
    }
    lph(now) { const r = this.rateAt(now); return r === null || !this.k ? null : r * this.k; }
    learn(lph, now) {
        const r = this.rateAt(now);
        if (!(r > 0) || !(lph > 0.5) || now - this.rateT > 1500) return false;
        this.ratios.push(lph / r);
        if (this.ratios.length > 30) this.ratios.shift();
        if (this.ratios.length < 10) return false;
        const s = this.ratios.slice().sort((a, b) => a - b), q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
        this.spread = q3 / q1;
        if (this.spread > 1.3) return false;
        const k = s[Math.floor(s.length / 2)], old = this.k;
        this.k = k;
        return !old || Math.abs(k - old) / old > 0.02;
    }
}

class Used {
    constructor() { this.prev = null; this.dt = 0; }
    /** Litres since the last add; this.dt: the time (ms) they cover (0 across a gap: the fuel then is not known). */
    add(lph, t) {
        const p = this.prev;
        this.prev = isNum(lph) ? { lph, t } : null;
        this.dt = 0;
        if (!p || !isNum(lph) || t <= p.t || t - p.t > 5000) return 0;
        this.dt = t - p.t;
        return (p.lph + lph) / 2 * this.dt / 3600000;
    }
}

module.exports = { Flow, Used };
