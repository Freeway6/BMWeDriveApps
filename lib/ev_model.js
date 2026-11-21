'use strict';
/**
 * ev_model.js - what DC fast charging gives at a charge level and cell temperature, before the car's own
 * charges have taught anything (Precondition, Charge Curve's time to target).
 *
 * The curve is a typical published one for the i4's 83.9 kWh battery (80.7 kWh usable, up to 205 kW, 10-80 %
 * in about 31 min at a warm battery); the 70.2 kWh battery (eDrive35, up to 180 kW) is the same shape,
 * scaled. The temperature factor is an estimate: lithium-ion cells take full current only when warm (about
 * 25-40 °C at the cells) and much less when cold. Both are starting points, not BMW data: the charges the
 * car really does (learned grid) take their place where they exist.
 */
const { isNum, clamp, interp } = require('./ev_core');

const CURVE = [[0, 170], [5, 190], [10, 200], [15, 205], [20, 198], [25, 172], [30, 158], [35, 149], [40, 140], [45, 130],
    [50, 119], [55, 110], [60, 100], [65, 91], [70, 82], [75, 72], [80, 60], [85, 47], [90, 37], [95, 23], [100, 9]];
const RAMP_MIN = 1.5;            // a DC charge takes about this long to reach its power
const TEMP_FACTOR = [[-15, 0.08], [-10, 0.12], [0, 0.25], [5, 0.33], [10, 0.45], [15, 0.62], [20, 0.82], [25, 1],
    [38, 1], [42, 0.95], [46, 0.8], [50, 0.5], [55, 0.25]];
const HEAT_CHARGING = 0.2;       // °C/min the car's own heater adds while it DC-charges a battery under 20 °C
const BATTERIES = {
    '83.9': { usable: 80.7, peak: 205 },
    '70.2': { usable: 67.1, peak: 180 },
};
const IDEAL = [25, 38];          // °C at the cells for full power

/** kW the battery takes at soc (%) and cell temperature (°C, the coldest cell's), by the prior. */
function priorKw(soc, cellT, battery) {
    const b = BATTERIES[battery] || BATTERIES['83.9'];
    const p = interp(CURVE, clamp(soc, 0, 100)) * b.peak / 205;
    return isNum(cellT) ? p * interp(TEMP_FACTOR, cellT) : p;
}

/** The temperature factor alone (0..1). */
const tempFactor = (cellT) => (isNum(cellT) ? interp(TEMP_FACTOR, cellT) : null);

/**
 * Learned grid: the most each 10 % charge band x 5 °C temperature band has taken, from real charges.
 * grid = { 'soc|temp': kw }: soc band 0..9 (0-10 %, ...), temp band floor(T / 5).
 */
const gridKey = (soc, cellT) => Math.min(9, Math.floor(clamp(soc, 0, 99.9) / 10)) + '|' + Math.floor(cellT / 5);
function learn(grid, soc, cellT, kw) {
    if (!isNum(soc) || !isNum(cellT) || !isNum(kw) || kw <= 0) return false;
    const k = gridKey(soc, cellT);
    if (!(k in grid) || kw > grid[k]) { grid[k] = Math.round(kw * 10) / 10; return true; }
    return false;
}

/**
 * kW expected at soc and cellT: the learned value of that band when there is one (the most this car took
 * there; a charge limited by its charger only says "at least", so the prior when that is higher), else the
 * prior. charger: the station's kW (null: no limit).
 */
function expectKw(soc, cellT, o) {
    o = o || {};
    const prior = priorKw(soc, cellT, o.battery);
    let kw = prior;
    if (o.grid && isNum(cellT)) {
        const g = o.grid[gridKey(soc, cellT)];
        if (isNum(g)) kw = Math.max(g, prior);
    }
    return isNum(o.charger) && o.charger > 0 ? Math.min(kw, o.charger) : kw;
}

/**
 * Minutes from soc a to soc b, the cells starting at cellT: 1 % steps, each % takes usable / 100 kWh at the
 * expected power, plus RAMP_MIN for the start; the charge warms the cells (losses about 2.5 % of the power
 * into ~600 kJ/K, and HEAT_CHARGING under 20 °C; at most up to 35 °C where the cooling holds them).
 * Returns { min, endT } or null.
 */
function chargeMinutes(a, b, cellT, o) {
    o = o || {};
    if (!isNum(a) || !isNum(b) || b <= a) return null;
    const bat = BATTERIES[o.battery] || BATTERIES['83.9'], kwhPct = (o.usable || bat.usable) / 100;
    let t = isNum(cellT) ? cellT : 25, min = RAMP_MIN;
    for (let s = Math.floor(a); s < Math.ceil(b); s++) {
        const kw = Math.max(1, expectKw(s + 0.5, t, Object.assign({}, o, { battery: o.battery })));
        const h = kwhPct / kw;
        min += h * 60;
        if (t < 35) t = Math.min(35, t + 0.025 * kw * h * 3600 / 600 + (t < 20 ? HEAT_CHARGING * h * 60 : 0));
    }
    return { min, endT: t };
}

module.exports = { RAMP_MIN, HEAT_CHARGING, CURVE, TEMP_FACTOR, BATTERIES, IDEAL, priorKw, tempFactor, gridKey, learn, expectKw, chargeMinutes };
