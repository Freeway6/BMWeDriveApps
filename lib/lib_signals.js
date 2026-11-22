'use strict';
/**
 * lib_signals.js - what the car sends the head unit by itself over SOME/IP (no request to any control unit, nothing
 * the car has to stay awake for). use: the groups to watch, each an interface the app lists in its app.json
 * "signals" (the runtime's spec has no "signals": the app names them here again).
 *
 *   const live = watchCar(signals, log, ['speed', 'env', 'cond', 'engine', 'tank', 'inj', 'fes', 'climate', 'accel', 'pedal', 'oil']);
 *   live.speed (km/h)   live.ambient (°C)   live.cond (vehicle state 1..12)   live.rpm   live.coolant / live.oil (°C)
 *   live.running (bool)   live.tank (l)   live.range (km)   live.odo (km)   live.inj (fuel injection counter, raw)
 *   live.mode ('sport' | 'comfort' | 'eco' | 'adaptive')   live.power / live.torquePct (% of max, sport display)
 *   live.torque (Nm)   live.climate (bool)   live.aLong (m/s²)   live.pedal (%)   live.oilLevel (0 below min .. 7 overfilled)
 *
 * Scalings as idrive7-apps' kit/car.js and Live Data (apps/live_data/signals.js, MIT) read them.
 */
const { isNum, entries } = require('./lib_core');

const IF = {
    speed: 'de.bmw.infotainment.vehicle.Vehicle2',
    env: 'de.bmw.infrastructure.EnvironmentalInformation',
    cond: 'de.bmw.infrastructure.VehicleCondition',
    engine: 'de.bmw.infotainment.vehicle.CDS',
    tank: 'de.bmw.infotainment.KombiIF',
    inj: 'de.bmw.infotainment.vehicle.CDS2',
    fes: 'de.bmw.infotainment.drivingexcitement.FES',
    climate: 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
    pedal: 'de.bmw.powertrain.AcceleratorPedal',
};

// VehicleCondition.statusConditionVehicle: 1-3 parked (3: the customer not in the car), 5 in the car, 8 getting ready
// to drive, 10 driving, 12 drive readiness ending
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };

// FES actualValueModeDrivingExperience: names and wire numbers (as idrive7-apps' ambient_config reads them)
const MODE_NAMES = { SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10 };
const MODE_OF = { 1: 'sport', 2: 'sport', 3: 'sport', 4: 'comfort', 5: 'comfort', 6: 'comfort', 7: 'eco', 8: 'eco', 9: 'eco', 10: 'adaptive' };
function modeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : MODE_NAMES[String(raw).toUpperCase()];
    if (n === undefined) {
        const w = String(raw).toUpperCase();
        return /ADAPTIV/.test(w) ? 'adaptive' : /SPORT/.test(w) ? 'sport' : /ECO/.test(w) ? 'eco' : /COMFORT/.test(w) ? 'comfort' : null;
    }
    return MODE_OF[n] || null;
}
// as the car names its modes on iDrive 7 (driving experience switch)
const MODE_LABEL = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', adaptive: 'Adaptiv' };

// Vehicle2.statusOilDipstick2.fluidLevelEngineOilRelative: names or numbers -> 0 (below min) .. 7 (overfilled)
const OIL_LEVEL = { MOTOROELSTAND_UNTER_MINIMUM: 0, MOTOROELSTAND_AM_MINIMUM: 1, MOTOROELSTAND_1_4: 2, MOTOROELSTAND_2_4: 3, MOTOROELSTAND_3_4: 4,
    MOTOROELSTAND_4_4: 5, MOTOROELSTAND_5_4: 6, MOTOROELSTAND_UEBERFUELLT: 7 };
const oilLevelOf = (x) => { const n = typeof x === 'number' ? x : OIL_LEVEL[x]; return isNum(n) && n >= 0 && n <= 7 ? n : null; };
const OIL_LEVEL_LABEL = ['unter Minimum', 'Minimum', '1/4', '2/4', '3/4', 'voll', 'über voll', 'überfüllt'];

const RUNNING = { MOTOR_AUS: false, MOTOR_STARTET: true, MOTOR_LAEUFT: true, 0: false, 1: true, 2: true };

function watchCar(signals, log, use, opts) {
    const groups = use || Object.keys(IF);
    const o = opts || {};
    const live = { speed: null, speedT: 0, ambient: null, cond: null, rpm: null, rpmT: 0, coolant: null, oil: null, running: null, runningT: 0,
        tank: null, range: null, odo: null, tankT: 0, inj: null, injT: 0, mode: null, modeRaw: null, power: null, torquePct: null, torque: null,
        climate: null, aLong: null, aLongT: 0, pedal: null, pedalT: 0, oilLevel: null, raw: {}, subs: [] };
    const seen = (what, v) => { live.raw[what] = JSON.stringify(v).slice(0, 300); };
    const watch = (group, handlers, wopts) => {
        if (groups.indexOf(group) < 0) return;
        const iface = IF[group];
        Promise.resolve(signals.watch(iface, '1', handlers, log, wopts)).then((s) => {
            live.subs.push(s);
            log.info('signal ' + iface.split('.').pop() + (s.error ? ' error: ' + s.error : ' subscribed'));
        }).catch((e) => log.warn('signal ' + iface + ': ' + e));
    };
    const vehicle2 = {};
    if (groups.indexOf('speed') >= 0) vehicle2.statusCarSpeed2 = (v) => {
        const k = v && v.speedVehicleCentreOfGravity;
        const s = !isNum(k) || k * 0.015625 > 400 ? null : k * 0.015625;
        live.speed = s;
        if (s !== null) live.speedT = Date.now();
        if (o.onSpeed) o.onSpeed(s);
    };
    if (groups.indexOf('oil') >= 0) vehicle2.statusOilDipstick2 = (v) => { seen('oil level', v); const n = oilLevelOf(v && v.fluidLevelEngineOilRelative); if (n !== null) live.oilLevel = n; };
    if (Object.keys(vehicle2).length) {
        Promise.resolve(signals.watch(IF.speed, '1', vehicle2, log, { pollMs: groups.indexOf('oil') >= 0 ? 60000 : undefined })).then((s) => {
            live.subs.push(s);
            log.info('signal Vehicle2' + (s.error ? ' error: ' + s.error : ' subscribed'));
        });
    }
    watch('env', {
        ExteriorTemperature: (v) => { const raw = v && v.temperatureExterior; if (isNum(raw) && raw !== 255) live.ambient = raw * 0.5 - 40; },
    });
    watch('cond', {
        VehicleCondition: (v) => { const n = conditionOf(v && v.statusConditionVehicle); if (n !== undefined) live.cond = n; },
    });
    watch('engine', {
        statusEngineSpeed2: (v) => {
            const r = v && v.actualValueRPMEngineCrankshaft;
            live.rpm = isNum(r) && r !== 65535 ? r * 0.25 : null;
            if (live.rpm !== null) live.rpmT = Date.now();
            if (o.onRpm) o.onRpm(live.rpm);
        },
        statusEngineTemperature: (v) => {
            const c = v && v.temperatureEngineDrive, l = v && v.temperatureEngineOilDrive;
            live.coolant = isNum(c) && c !== 255 ? c - 48 : live.coolant;
            live.oil = isNum(l) && l !== 255 ? l - 48 : live.oil;
        },
        statusEngineStatus: (v) => {
            const r = v && v.statusEngineRunDrive;
            if (r in RUNNING) { live.running = RUNNING[r]; live.runningT = Date.now(); }
        },
    });
    watch('tank', {
        statusRangeTankStatus: (v) => {
            seen('tank', v);
            if (!v) return;
            if (isNum(v.fluidLevelFuelTank) && v.fluidLevelFuelTank < 255) live.tank = v.fluidLevelFuelTank;
            if (isNum(v.range) && v.range < 4095) live.range = v.range;
            if (isNum(v.mileageKilometre) && v.mileageKilometre > 0 && v.mileageKilometre < 16777215) live.odo = v.mileageKilometre;
            live.tankT = Date.now();
            if (o.onTank) o.onTank(live);
        },
    }, { pollMs: 10000 });
    const cds2 = {};
    if (groups.indexOf('inj') >= 0) cds2.statusInjectionVolume = (v) => {
        const c = v && v.injectionVolumeFuelEngine;
        if (isNum(c)) { live.inj = c; live.injT = Date.now(); if (o.onInj) o.onInj(c, live.injT); }
    };
    if (groups.indexOf('accel') >= 0) cds2.statusLongitudinalAccelerationMassCenter = (v) => {
        const a = v && v.longitudinalAccelerationCentreOfGravity;
        if (isNum(a) && a !== 65535) { live.aLong = a * 0.002 - 65; live.aLongT = Date.now(); }
    };
    if (Object.keys(cds2).length) {
        Promise.resolve(signals.watch(IF.inj, '1', cds2, log)).then((s) => {
            live.subs.push(s);
            log.info('signal CDS2' + (s.error ? ' error: ' + s.error : ' subscribed'));
        });
    }
    watch('fes', {
        statusFESVehicleDynamicSwitchHMI: (v) => {
            const raw = v && v.actualValueModeDrivingExperience;
            if (raw === undefined) return;
            if (String(raw) !== String(live.modeRaw)) log.info('driving mode: ' + JSON.stringify(raw));
            live.modeRaw = raw;
            live.mode = modeOf(raw);
        },
        statusVehicleDynamicEngine: (v) => {
            const p = v && v.displaySportEnginePower, q = v && v.displaySportEngineTorque;
            live.power = isNum(p) && p !== 255 ? p : null;
            live.torquePct = isNum(q) && q !== 255 ? q : null;
        },
        statusActualValueTorque2: (v) => {
            const q = v && v.actualValueTorqueCrankshaft;
            live.torque = isNum(q) && q < 4095 ? q * 0.5 - 1023.5 : null;
        },
    });
    const zones = {};
    watch('climate', {
        statusClimateSystemOn: (v) => {
            seen('climate', v);
            entries(v, 'airConditioningOn').forEach((e) => { zones[String(e.operationZone)] = !!e.airConditioningOn; });
            const ks = Object.keys(zones);
            live.climate = ks.length ? ks.some((k) => zones[k]) : null;
        },
    }, { pollMs: 15000 });
    watch('pedal', {
        AngleAcceleratorPedal: (v) => {
            const a = v && v.actualValueAngleAcceleratorPedal;
            if (isNum(a)) { const p = a * 0.025; if (p > -2 && p < 102) { live.pedal = Math.max(0, Math.min(100, p)); live.pedalT = Date.now(); } }
        },
    });
    /** The car locked and left (vehicle state 1-3): reads that would keep it awake stop. */
    live.left = () => isNum(live.cond) && live.cond <= 3;
    /** The engine runs: its state signal, else an engine speed over 300 seen in the last 3 s. */
    live.engineOn = () => (live.running !== null && Date.now() - live.runningT < 60000 ? live.running : isNum(live.rpm) && live.rpm > 300 && Date.now() - live.rpmT < 3000);
    /** Driving or ready to drive (vehicle state 8-12), or moving. */
    live.driving = () => (isNum(live.speed) && live.speed > 2) || (isNum(live.cond) && live.cond >= 8);
    return live;
}

module.exports = { watchCar, modeOf, MODE_LABEL, conditionOf, oilLevelOf, OIL_LEVEL_LABEL, IF };
