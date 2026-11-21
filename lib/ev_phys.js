'use strict';
/**
 * ev_phys.js - the car as a moving mass: what it takes to roll and push air, and what a stop gives back.
 *
 * i4 M50 defaults: 2290 kg empty (EU, with driver ~2365 kg), cd 0.25 x A 2.33 m², rolling resistance 0.009.
 * Settings in the apps change mass; the rest is good enough for shares (it only decides how much of a stop's
 * energy air and tyres took anyway).
 */
const RHO = 1.2, G = 9.81;
const CAR = { mass: 2365, cda: 0.25 * 2.33, crr: 0.009 };

/** Power (kW) air drag and rolling take at v (m/s). */
function roadKw(v, car) {
    const c = car || CAR;
    return (0.5 * RHO * c.cda * v * v * v + c.crr * c.mass * G * v) / 1000;
}

/** Kinetic energy (kWh) between speeds v0 and v1 (m/s). */
function kineticKwh(v0, v1, car) {
    const c = car || CAR;
    return 0.5 * c.mass * (v0 * v0 - v1 * v1) / 3.6e6;
}

/** Power (kW) at the wheels to hold v (m/s) and accelerate at a (m/s²) on the flat. */
function wheelKw(v, a, car) {
    const c = car || CAR;
    return c.mass * a * v / 1000 + roadKw(v, c);
}

const kmh = (v) => v / 3.6;

module.exports = { CAR, roadKw, kineticKwh, wheelKw, kmh };
