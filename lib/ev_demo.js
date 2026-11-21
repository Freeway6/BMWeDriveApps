'use strict';
/**
 * ev_demo.js - made-up data for the demo mode (setting "Demo data") and the PC preview: a drive with town,
 * country road and motorway, and a DC fast charge, both worked out with the same models the apps use.
 *
 *   const d = new DemoDrive(seed); d.step(dt_s) -> { speed, accel, kw, soc, stored, odo, battT, ambient, mode, climate }
 *   const c = new DemoCharge({ soc0, cellT, charger }); c.at(minutes) -> { soc, kw, cellT, kwh }
 */
const { clamp } = require('./ev_core');
const { expectKw, BATTERIES, HEAT_CHARGING } = require('./ev_model');
const { wheelKw, kmh } = require('./ev_phys');

/** A small deterministic random generator (the same demo every time). */
function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// [target km/h, seconds to hold it]: town with stops, a country road, the motorway, back into town
const PROFILE = [[0, 8], [48, 25], [0, 12], [52, 30], [30, 10], [50, 20], [0, 15], [80, 40], [95, 60], [70, 15],
    [100, 50], [120, 80], [130, 90], [110, 30], [128, 60], [80, 20], [60, 25], [0, 10], [45, 30], [0, 20]];

class DemoDrive {
    constructor(seed, o) {
        o = o || {};
        this.r = rng(seed || 7);
        this.t = 0; this.i = 0; this.hold = 0;
        this.speed = 0; this.accel = 0;
        this.usable = o.usable || BATTERIES['83.9'].usable;
        this.soc = o.soc0 == null ? 74 : o.soc0;
        this.odo = o.odo0 == null ? 23817.4 : o.odo0;
        this.battT = o.battT0 == null ? 17 : o.battT0;
        this.ambient = o.ambient == null ? 8 : o.ambient;
        this.mode = 'comfort';
        this.kw = 0;
    }
    get stored() { return this.soc / 100 * this.usable; }
    step(dt) {
        this.t += dt;
        const seg = PROFILE[this.i % PROFILE.length], target = seg[0];
        const dv = target - this.speed;
        // gentle in town, firmer braking before a stop; some wobble on the motorway
        if (Math.abs(dv) < 0.5) this.accel = (this.r() - 0.5) * 0.15;
        else if (dv > 0) this.accel = Math.min(dv / 3.6 / 2, this.speed < 60 ? 2.2 : 1.1);
        else this.accel = Math.max(dv / 3.6 / 2, target === 0 ? (this.i % 4 === 1 ? -3.4 : -2.4) : -1.4);
        this.speed = Math.max(0, this.speed + this.accel * 3.6 * dt);
        if (Math.abs(this.speed - target) < 1) { this.hold += dt; if (this.hold >= seg[1]) { this.hold = 0; this.i++; this.mode = this.i % 9 < 3 ? 'eco' : this.i % 9 < 7 ? 'comfort' : 'sport'; } }
        const v = kmh(this.speed), wheel = wheelKw(v, this.accel);
        // the climate and on-board electrics: heating when cold, a little A/C when hot
        const aux = 0.6 + Math.max(0, 18 - this.ambient) * 0.12 + (this.ambient > 25 ? 0.8 : 0);
        // drive: motors and inverters about 90 % efficient; braking: the motors take up to about 2 m/s² (the
        // friction brakes the rest) and give back about 80 % of it, at most 116 kW
        const regenWheel = Math.max(wheel, -2365 * 2.0 * v / 1000);
        this.kw = wheel >= 0 ? wheel / (this.mode === 'sport' ? 0.86 : 0.9) + aux : Math.max(-116, regenWheel * 0.8) + aux;
        this.soc = clamp(this.soc - this.kw * dt / 3600 / this.usable * 100, 0, 100);
        this.odo += this.speed * dt / 3600;
        this.battT = Math.min(32, this.battT + Math.abs(this.kw) * dt * 0.00002);
        return { speed: this.speed, accel: this.accel, kw: this.kw, soc: this.soc, stored: this.stored, odo: this.odo,
            battT: this.battT, ambient: this.ambient, mode: this.mode, climate: true };
    }
}

/** A DC fast charge from soc0 at a cellT start, at a charger of charger kW: worked out once, in 10 s steps. */
class DemoCharge {
    constructor(o) {
        o = o || {};
        this.soc0 = o.soc0 == null ? 12 : o.soc0;
        this.cellT0 = o.cellT == null ? 18 : o.cellT;
        this.charger = o.charger || 200;
        this.usable = o.usable || BATTERIES['83.9'].usable;
        this.r = rng(o.seed || 3);
        this.pts = [];
        let soc = this.soc0, t = this.cellT0, kwh = 0;
        const maxS = (o.maxMin || (this.charger < 20 ? 720 : 120)) * 60;
        for (let s = 0; s <= maxS && soc < 100; s += 10) {
            const ramp = Math.min(1, s / 90);
            const kw = Math.max(0, expectKw(soc, t, { charger: this.charger }) * ramp * (0.985 + this.r() * 0.03));
            this.pts.push({ s, soc, kw, cellT: t, kwh });
            const e = kw * 10 / 3600;
            kwh += e;
            soc = Math.min(100, soc + e / this.usable * 100);
            if (t < 35) t = Math.min(35, t + 0.025 * kw * 10 / 600 + (t < 20 ? HEAT_CHARGING / 6 : 0));
        }
    }
    /** The charge at min minutes after its start. */
    at(min) {
        const i = clamp(Math.floor(min * 6), 0, this.pts.length - 1);
        return this.pts[i];
    }
}

/** Charges for the history pages: n of them over the last weeks (DC on trips, AC at home), recorded the way
 * the app records real ones (ev_charge.js). */
function demoSessions(n, now) {
    const { ChargeTracker } = require('./ev_charge');
    const r = rng(11), st = { sessions: [], open: null };
    const tr = new ChargeTracker(st);
    let t = (now || Date.now()) - n * 2.6 * 86400000;
    for (let i = 0; i < n; i++) {
        t += (1.5 + r() * 2) * 86400000;
        const dc = i % 3 !== 2, soc0 = Math.round(8 + r() * 25), cellT = dc ? Math.round(10 + r() * 22) : 15;
        const charger = dc ? [50, 150, 200, 300][Math.floor(r() * 4)] : 11;
        const c = new DemoCharge({ soc0, cellT, charger, seed: i + 5 });
        const to = dc ? 75 + Math.round(r() * 10) : 90, step = dc ? 10 : 60;
        let tt = Math.round(t), last = null;
        for (let k = 0; k < c.pts.length; k += step / 10) {
            const p = c.pts[k];
            last = p;
            tr.sample({ t: tt, kwIn: p.kw, soc: p.soc, cellT: p.cellT, cellTmax: p.cellT + 2, speed: 0, stored: p.soc * c.usable / 100 });
            tt += step * 1000;
            if (p.soc >= to) break;
        }
        for (let k = 0; k < 12; k++) { tr.sample({ t: tt, kwIn: 0.1, soc: last.soc, cellT: last.cellT, speed: 0 }); tt += 10000; }
        if (st.open) tr.close('done');
    }
    st.sessions.forEach((x) => { x.demo = true; });
    return st.sessions;
}

module.exports = { rng, DemoDrive, DemoCharge, demoSessions, PROFILE };
