'use strict';
/**
 * lib_phys.js - the car as a moving mass: what it takes to roll and push air, and the power that accelerates it.
 *
 * M340i (G20) defaults: 1745 kg (DIN, xDrive saloon) + 75 kg driver + 10 kg = 1830 kg, cd 0.26 x A 2.22 m²,
 * rolling resistance 0.011 (sport tyres). The setting "Auto mit Insassen" changes the mass.
 */
const RHO = 1.2, G = 9.81;
const CAR = { mass: 1830, cda: 0.26 * 2.22, crr: 0.011 };

/** Power (kW) air drag and rolling take at v (m/s). */
function roadKw(v, car) {
    const c = car || CAR;
    return (0.5 * RHO * c.cda * v * v * v + c.crr * c.mass * G * v) / 1000;
}

/** Power (kW) at the wheels to hold v (m/s) and accelerate at a (m/s²) on the flat. */
function wheelKw(v, a, car) {
    const c = car || CAR;
    return c.mass * a * v / 1000 + roadKw(v, c);
}

const kmh = (v) => v / 3.6;
const PS = 1.35962;            // PS per kW

module.exports = { CAR, roadKw, wheelKw, kmh, PS };
