'use strict';
/**
 * lib_demo.js - made-up data for the demo mode (setting "Demodaten") and the PC preview: an M340i (B58, 8HP) driving
 * through town, over country roads and on the motorway, worked out with lib_phys.js, and the readings the engine unit
 * would give.
 *
 *   const d = new DemoDrive(seed, { ambient, coolant, oil });  d.step(dt) -> { speed, rpm, gear, aLong, lph, coolant, oil, pedal, load, mode, climate }
 *   demoPull(seed) -> samples of a full-throttle pull in 3rd gear
 */
const { CAR, wheelKw, kmh } = require('./lib_phys');

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// [target km/h, seconds to hold it]
const PROFILE = [[0, 8], [48, 25], [0, 12], [52, 30], [30, 10], [50, 20], [0, 15], [80, 40], [95, 60], [65, 45],
    [100, 50], [120, 80], [140, 90], [110, 30], [128, 60], [80, 20], [60, 50], [0, 10], [45, 30], [0, 20]];
// ZF 8HP51 ratios and the final drive; tyre circumference (m)
const RATIOS = [5.0, 3.2, 2.143, 1.72, 1.314, 1.0, 0.822, 0.64], FINAL = 2.81, TYRE = 2.03;
const rpmFor = (kmhV, gear) => kmhV / 3.6 / TYRE * 60 * RATIOS[gear - 1] * FINAL;

/** The gear an automatic picks for a speed: the highest that keeps the engine over 1300 rpm (1800 accelerating). */
function gearFor(kmhV, accel) {
    const min = accel > 0.8 ? 1900 : 1300;
    for (let g = 8; g >= 1; g--) if (rpmFor(kmhV, g) >= min) return g;
    return 1;
}

class DemoDrive {
    constructor(seed, o) {
        o = o || {};
        this.r = rng(seed || 7);
        this.t = 0; this.i = 0; this.hold = 0;
        this.speed = 0; this.accel = 0; this.gear = 1;
        this.ambient = o.ambient == null ? 8 : o.ambient;
        this.coolant = o.coolant == null ? this.ambient : o.coolant;
        this.oil = o.oil == null ? this.ambient : o.oil;
        this.mode = 'comfort';
    }
    step(dt) {
        this.t += dt;
        const seg = PROFILE[this.i % PROFILE.length], target = seg[0], dv = target - this.speed;
        if (Math.abs(dv) < 0.5) this.accel = (this.r() - 0.5) * 0.15;
        else if (dv > 0) this.accel = Math.min(dv / 3.6 / 2, this.speed < 60 ? 2.4 : 1.3);
        else this.accel = Math.max(dv / 3.6 / 2, target === 0 ? -2.6 : -1.4);
        this.speed = Math.max(0, this.speed + this.accel * 3.6 * dt);
        if (Math.abs(this.speed - target) < 1) { this.hold += dt; if (this.hold >= seg[1]) { this.hold = 0; this.i++; this.mode = this.i % 9 < 3 ? 'eco' : this.i % 9 < 7 ? 'comfort' : 'sport'; } }
        this.gear = this.speed < 3 ? 1 : gearFor(this.speed, this.accel);
        const rpm = this.speed < 3 ? 650 + (this.coolant < 40 ? 250 : 0) : Math.max(900, rpmFor(this.speed, this.gear));
        const wheel = wheelKw(kmh(this.speed), this.accel);
        // the engine: 85 % of its power reaches the wheels, 1.5 kW for the ancillaries (more with the climate on: the
        // compressor in the heat, dehumidifying in the cold); fuel cut when coasting
        const climate = this.ambient < 16 || this.ambient > 24;
        const kw = wheel > 0 ? wheel / 0.85 + 1.5 + (climate ? (this.ambient > 24 ? 1.6 : 0.5) : 0) : 0;
        const bsfc = 240 + 2600 / (kw + 6);                    // g/kWh: poor at light load
        const coldness = Math.max(0, Math.min(1, (80 - this.coolant) / 70));
        let lph = wheel > 0 || this.speed < 3 ? Math.max(0.75 + (climate ? 0.15 : 0), kw * bsfc / 745) : 0;
        lph *= 1 + 0.4 * coldness;
        lph *= 1 + 0.004 * Math.max(0, 15 - this.ambient);     // cold air: denser, stiffer tyres and oils
        if (this.mode === 'sport') lph *= 1.05;
        else if (this.mode === 'eco') lph *= 0.97;
        // warming up: the coolant reaches 70 °C in about 8 min of driving from 10 °C, the oil 100 °C in about 20
        this.coolant = Math.min(92, this.coolant + dt * (0.08 + kw * 0.0025) * (this.coolant < 85 ? 1 : 0.2));
        this.oil = Math.min(102, this.oil + dt * (0.05 + kw * 0.0015) * (this.oil < 95 ? 1 : 0.2));
        return { speed: this.speed, rpm, gear: this.gear, aLong: this.accel, lph, coolant: this.coolant, oil: this.oil,
            pedal: Math.max(0, Math.min(100, kw / 2.75)), load: Math.min(160, 15 + kw * 0.5), mode: this.mode, climate };
    }
}

/**
 * A full-throttle pull in 3rd gear from 2000 to 6500 rpm, every 0.1 s: what the engine unit and the car would give.
 * o: { boostLoss (bar the turbo falls short), retard (° mean knock retard), railDrop (share), iatRise (K) }.
 */
function demoPull(seed, o) {
    o = o || {};
    const r = rng(seed || 5), out = [];
    let rpm = 2000, t = 0, iat = 22;
    const gear = 3, amb = 1.0;
    while (rpm < 6500) {
        const v = rpm / (60 * RATIOS[gear - 1] * FINAL) * TYRE;            // m/s
        // B58 (374 PS / 500 Nm): torque 500 Nm 1600-4500, then falling to the power peak
        const tq = rpm < 4500 ? 500 : 500 * 4500 / rpm * (1 - (rpm - 4500) / 30000);
        const kw = tq * rpm / 9549 * (1 - (o.boostLoss || 0) * 0.35);
        const a = (kw * 0.85 * 1000 / v - (0.5 * 1.2 * CAR.cda * v * v + CAR.crr * CAR.mass * 9.81)) / CAR.mass;
        const target = amb + (rpm < 5500 ? 1.15 : 1.15 - (rpm - 5500) / 4000);
        const spool = Math.min(1, t / 1.2);
        const actual = amb + (target - amb) * spool - (o.boostLoss || 0) * spool + (r() - 0.5) * 0.03;
        iat += 0.08 * (o.iatRise ? 2 : 1);
        out.push({ t: Math.round(t * 1000), rpm: Math.round(rpm), speed: v * 3.6, aLong: a, gear,
            boostTarget: target, boostAct: actual, railTarget: 350, railAct: 350 * (1 - (o.railDrop || 0) * Math.min(1, rpm / 6000)) - r() * 6,
            iat, lambda: 0.86 + (r() - 0.5) * 0.02, lambdaTarget: 0.86, knockRetard: Math.max(0, (o.retard || 0.3) * (0.5 + r())), load: 145 + r() * 5, pedal: 100 });
        rpm += a * 0.1 / TYRE * 60 * RATIOS[gear - 1] * FINAL;
        t += 0.1;
    }
    return out;
}

module.exports = { rng, DemoDrive, demoPull, PROFILE, RATIOS, FINAL, TYRE, rpmFor, gearFor };
