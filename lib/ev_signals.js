'use strict';
/**
 * ev_signals.js - the vehicle signals these apps read over SOME/IP (no diagnostic request, nothing the
 * car has to wake up for). use: the groups to watch, each an interface the app lists in its app.json
 * "signals" (the runtime's spec has no "signals": the app names them here again).
 *
 *   const live = watchCar(signals, log, ['speed', 'env', 'cond', 'eff', 'fes', 'climate', 'lsc']);
 *   live.speed (km/h), live.ambient (°C), live.batt ({ avg, min, max } °C), live.mode ('sport' | 'comfort' |
 *   'eco' | 'adaptive' | null), live.cond (vehicle state 1..12), live.climate (bool), live.hvV (V), live.raw
 */
const { isNum, entries, one } = require('./ev_core');

const IF = {
    speed: 'de.bmw.infotainment.vehicle.Vehicle2',
    env: 'de.bmw.infrastructure.EnvironmentalInformation',
    eff: 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2',
    fes: 'de.bmw.infotainment.drivingexcitement.FES',
    cond: 'de.bmw.infrastructure.VehicleCondition',
    climate: 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
    lsc: 'de.bmw.infotainment.lsc.LSCDataSink',
};

// VehicleCondition.statusConditionVehicle: names or wire numbers. 1-3 parked (3: the customer not in the car),
// 5 in the car, 8 getting ready to drive, 10 driving, 12 drive readiness ending.
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };

// FES actualValueModeDrivingExperience: names and wire numbers (as idrive7-apps' ambient_config reads them)
const MODE_NAMES = { SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10 };
const MODE_OF = { 1: 'sport', 2: 'sport', 3: 'sport', 4: 'comfort', 5: 'comfort', 6: 'comfort', 7: 'eco', 8: 'eco', 9: 'eco', 10: 'adaptive', 28: 'sport' };
function modeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : MODE_NAMES[String(raw).toUpperCase()];
    if (n === undefined) {
        const w = String(raw).toUpperCase();
        return /ADAPTIV/.test(w) ? 'adaptive' : /SPORT|BOOST/.test(w) ? 'sport' : /ECO|EFFICIEN/.test(w) ? 'eco' : /COMFORT|PERSONAL/.test(w) ? 'comfort' : null;
    }
    return MODE_OF[n] || null;
}
// as the car names its modes (My Modes on iDrive 8 keep their English names in German)
const MODE_LABEL = { sport: 'Sport', comfort: 'Personal', eco: 'Efficient', adaptive: 'Adaptiv' };

function watchCar(signals, log, use, opts) {
    const groups = use || Object.keys(IF);
    const o = opts || {};
    // the car's battery temperature: raw + offset (X5 45e: -50); a function to follow a setting
    const battOffset = () => { const x = typeof o.battOffset === 'function' ? o.battOffset() : o.battOffset; return isNum(x) ? x : -50; };
    const live = { speed: null, speedT: 0, ambient: null, batt: null, battT: 0, mode: null, modeRaw: null, cond: null, condT: 0,
        climate: null, hvV: null, hvVT: 0, raw: {}, subs: [] };
    const seen = (what, v) => { live.raw[what] = JSON.stringify(v).slice(0, 300); };
    const watch = (iface, handlers, wopts) => {
        const g = Object.keys(IF).find((k) => IF[k] === iface);
        if (groups.indexOf(g) < 0) return;
        Promise.resolve(signals.watch(iface, '1', handlers, log, wopts)).then((s) => {
            live.subs.push(s);
            log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'));
        }).catch((e) => log.warn('signal ' + iface + ': ' + e));
    };
    watch(IF.speed, {
        statusCarSpeed2: (v) => {
            const k = v && v.speedVehicleCentreOfGravity;
            // (65535: no value; over 400 km/h: not a real one, as sent while the car wakes)
            const s = !isNum(k) || k * 0.015625 > 400 ? null : k * 0.015625;
            live.speed = s;
            if (s !== null) live.speedT = Date.now();
            if (o.onSpeed) o.onSpeed(s);
        },
    });
    watch(IF.env, {
        ExteriorTemperature: (v) => {
            const raw = v && v.temperatureExterior;
            if (isNum(raw) && raw !== 255) live.ambient = raw * 0.5 - 40;
        },
    });
    const battTemp = (raw) => { const v = isNum(raw) && raw !== 255 ? raw + battOffset() : null; return v !== null && v > -40 && v < 80 ? v : null; };
    watch(IF.eff, {
        statusBatteryTemperature: (v) => {
            seen('battery temp', v);
            const e = entries(v, 'actualValueTemperatureHighVoltageStorage')[0];
            if (!e) return;
            const b = { avg: battTemp(e.actualValueTemperatureHighVoltageStorage), min: battTemp(e.actualValueTemperatureHighVoltageStorageMinimum),
                max: battTemp(e.actualValueTemperatureHighVoltageStorageMaximum) };
            if (isNum(b.avg) || isNum(b.min)) { live.batt = b; live.battT = Date.now(); }
        },
    }, { pollMs: 30000 });
    watch(IF.fes, {
        statusFESVehicleDynamicSwitchHMI: (v) => {
            const raw = v && v.actualValueModeDrivingExperience;
            if (raw === undefined) return;
            if (String(raw) !== String(live.modeRaw)) log.info('driving mode: ' + JSON.stringify(raw));
            live.modeRaw = raw;
            live.mode = modeOf(raw);
        },
    });
    watch(IF.cond, {
        VehicleCondition: (v) => {
            const n = conditionOf(v && v.statusConditionVehicle);
            if (n !== undefined) { live.cond = n; live.condT = Date.now(); }
        },
    });
    const zones = {};
    watch(IF.climate, {
        statusClimateSystemOn: (v) => {
            seen('climate', v);
            entries(v, 'airConditioningOn').forEach((e) => { zones[String(e.operationZone)] = !!e.airConditioningOn; });
            const ks = Object.keys(zones);
            live.climate = ks.length ? ks.some((k) => zones[k]) : null;
        },
    }, { pollMs: 15000 });
    watch(IF.lsc, {
        statusHighVoltageStorage: (v) => {
            seen('HV voltage', v);
            const x = one(v, 'actualValueVoltageHighVoltageStorage');
            if (!isNum(x)) return;
            const volts = x > 1500 ? x / 10 : x;            // 0.1 V on the X5 45e
            if (volts > 150 && volts < 500) { live.hvV = volts; live.hvVT = Date.now(); }
        },
    });
    /** The car locked and left (vehicle state 1-3): reads that would keep it awake stop. */
    live.left = () => isNum(live.cond) && live.cond <= 3;
    /** Driving or ready to drive (vehicle state 8-12), or moving. */
    live.driving = () => (isNum(live.speed) && live.speed > 2) || (isNum(live.cond) && live.cond >= 8);
    return live;
}

module.exports = { watchCar, modeOf, MODE_LABEL, conditionOf, IF };
