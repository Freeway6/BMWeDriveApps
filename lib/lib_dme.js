'use strict';
/**
 * lib_dme.js - what the B58's engine unit (DME, 0x12; SGBD DME8FF_R: B58 / B48 / B38 in the G series) is asked, and
 * how its replies are read. Units are converted here: bar, °C, l, l/h, km, h.
 *
 * Identifiers, byte layouts and scalings: idrive7-apps' Live Data (apps/live_data/builtin/DME8FF_R.json, MIT, made
 * from the public SGBD reference) and M Vitals (config.dme, MIT); standard OBD-II PIDs (SAE J1979) as the fallback.
 * Each value tries its candidates in order; app.json config.dme can replace a value's list for one app.
 *
 *   const dme = new UdsReader(signals, log, dmeConfig(spec.config && spec.config.dme), DME);
 */
const DME = 18;            // 0x12

const u8 = (did, k, o, min, max, extra) => Object.assign({ did, bytes: 1, factor: k, offset: o || 0, min, max }, extra);
const u16 = (did, k, o, min, max, extra) => Object.assign({ did, bytes: 2, factor: k, offset: o || 0, min, max }, extra);
const s16 = (did, k, o, min, max, extra) => Object.assign({ did, bytes: 2, signed: true, factor: k, offset: o || 0, min, max }, extra);
const s8 = (did, k, o, min, max, extra) => Object.assign({ did, bytes: 1, signed: true, factor: k, offset: o || 0, min, max }, extra);
const obd = (pid, bytes, k, o, min, max, extra) => Object.assign({ obd: pid, bytes, factor: k, offset: o || 0, min, max }, extra);
const cyl = (dids, make) => dids.map(make);

const MISFIRE = ['4B23', '4B24', '4B25', '4B30', '4B31', '4B32'];
const ROUGH = ['4A30', '4A31', '4A32', '4A33', '4A34', '4A35'];
const INJ = ['55B4', '55B5', '55B6', '55B7', '55B8', '55B9'];
const IGN = ['4A49', '4A4A', '4A4C', '4A4D', '4A4E', '4A4F'];

const DEFAULTS = {
    ecu: DME,
    // engine
    rpm: [s16('4807', 0.5, 0, 0, 9000), obd('0C', 2, 0.25, 0, 0, 9000)],
    coolant: [s16('4300', 0.1, -273.14, -40, 150), obd('05', 1, 1, -40, -40, 150)],
    oilTemp: [u16('4402', 0.75, -48, -40, 170), obd('5C', 1, 1, -40, -40, 170)],
    iat: [u8('580F', 0.75, -48, -40, 120), obd('0F', 1, 1, -40, -40, 120)],
    load: [u8('5813', 0.75, 0, 0, 191), obd('04', 1, 100 / 255, 0, 0, 100)],
    loadTarget: [u16('480C', 0.0234375, 0, 0, 250)],
    torque: [s16('5891', 0.5, 0, -300, 900)],
    battV: [u16('5853', 0.001, 0, 5, 18), obd('42', 2, 0.001, 0, 5, 18)],
    engineHours: [u16('583D', 0.1, 0, 0, 6600)],
    // oil (pressures absolute: the gauge pressure is oilPress - ambientP)
    ambientP: [u16('4201', 0.0000390625, 0, 0.5, 1.2), obd('33', 1, 0.01, 0, 0.5, 1.2)],          // outside air pressure, bar
    oilPress: [u16('4436', 0.001, 0, 0.5, 10), u16('586F', 0.001, 0, 0.5, 10)],
    oilLevel: [u8('5811', 0.01, 0, 0, 2.5), u8('442F', 0.01, 0, 0, 2.5)],           // litres above minimum (255 = none)
    oilLevelMm: [s16('4409', 0.004, 0, -80, 80)],
    fuelInOil: [u16('593A', 0.02133333, 0, 0, 1300)],
    oilKm: [u16('4404', 10, 0, 0, 600000)],
    oilLife: [{ did: '411A', fields: {
        hours: { bytes: 2, factor: 0.001953125, min: 0, max: 128 },
        fuel: { at: 2, bytes: 2, factor: 0.001953125, min: 0, max: 128 } } }],
    // fuel
    tank: [u8('583B', 1, 0, 0, 100)],
    fuelFlow: [u16('5656', 0.00429152, 0, 0, 300), obd('5E', 2, 0.05, 0, 0, 300)],      // l/h
    fuelQuality: [u8('5776', -0.02734375, 98, 85, 98.5)],                              // the adapted octane (RON 98 = factor 0)
    sinceRefuel: [u16('57E3', 1 / 60, 0, 0, 1000)],                                    // hours
    kqe: [{ did: '4035', fields: {
        low: { bytes: 2 }, medium: { at: 2, bytes: 2 }, high: { at: 4, bytes: 2 },
        km1: { at: 6, bytes: 2, factor: 8 }, q1: { at: 8, bytes: 1 },
        km2: { at: 9, bytes: 2, factor: 8 }, q2: { at: 11, bytes: 1 },
        km3: { at: 12, bytes: 2, factor: 8 }, q3: { at: 14, bytes: 1 },
        km4: { at: 15, bytes: 2, factor: 8 }, q4: { at: 17, bytes: 1 },
        km5: { at: 18, bytes: 2, factor: 8 }, q5: { at: 20, bytes: 1 } } }],
    railAct: [u16('58EF', 0.005, 0, 0, 400), obd('23', 2, 0.1, 0, 0, 400)],
    railTarget: [u16('5837', 0.005, 0, 0, 400)],
    lowPress: [u16('58F3', 0.001, 0, 0.5, 12)],
    lambda: [u16('5889', 0.000244140625, 0, 0.5, 1.6), obd('34', 2, 2 / 65536, 0, 0.5, 1.6)],
    lambdaTarget: [u16('5816', 0.000244140625, 0, 0.5, 1.6)],
    stft: [obd('06', 1, 0.78125, -100, -50, 50)],
    ltft: [obd('07', 1, 0.78125, -100, -50, 50)],
    mixAdapt: [u16('4A9D', 3.0517578e-05, 0, 0.5, 1.5)],
    injMean: [u16('546E', 3.052e-05, 0, 0.5, 1.5)],
    // boost (absolute, bar)
    boostAct: [u16('580B', 0.0000390625, 0, 0.2, 4), u16('4205', 0.000078125, 0, 0.2, 4), { did: 'F470', bytes: 2, at: 3, factor: 0.0003125, min: 0.2, max: 4 }],
    boostTarget: [u16('4AB0', 0.0000390625, 0, 0.2, 4), { did: 'F470', bytes: 2, at: 1, factor: 0.0003125, min: 0.2, max: 4 }],
    // ignition and knock (° crank angle)
    ignition: [s8('59FA', 0.75, 0, -40, 60), obd('0E', 1, 0.5, -64, -40, 60)],
    knockRetard: [s8('554C', 0.375, 0, -20, 20)],          // the mean of the cylinders' knock control retard
    knockAdapt: [s16('554A', 0.1, 0, -20, 20)],
    knockFlag: [u8('4A36', 1, 0, 0, 1)],
    // wear
    plugsLeft: [s16('5489', 100, 0, -100000, 200000), { did: '4163', at: 4, bytes: 2, signed: true, factor: 100, min: -100000, max: 200000 }],
    plugsKm: [{ did: '4163', at: 6, bytes: 4, min: 0, max: 1000000 }],
};
// per cylinder (1..6)
MISFIRE.forEach((d, i) => { DEFAULTS['misfire' + (i + 1)] = [u16(d, 1, 0, 0, 65000)]; });
ROUGH.forEach((d, i) => { DEFAULTS['rough' + (i + 1)] = [s16(d, 0.0625, 0, -500, 500)]; });
INJ.forEach((d, i) => { DEFAULTS['inj' + (i + 1)] = [u16(d, 3.052e-05, 0, 0.5, 1.5)]; });
IGN.forEach((d, i) => { DEFAULTS['ign' + (i + 1)] = [s16(d, 0.1, 0, -40, 60)]; });

const CYLINDERS = 6;
const names = (prefix) => { const out = []; for (let i = 1; i <= CYLINDERS; i++) out.push(prefix + i); return out; };

/** The candidates to use: DEFAULTS, a value's list replaced where app.json config.dme names it. */
function dmeConfig(cfg) {
    const out = {};
    Object.keys(DEFAULTS).forEach((k) => { out[k] = DEFAULTS[k]; });
    Object.keys(cfg || {}).forEach((k) => { if (k !== 'comment') out[k] = cfg[k]; });
    return out;
}

/** The DME's fuel quality range of a refuelling (KQE: 1 low, 2 medium, 3 high; 0 none). */
const QUALITY = { 1: 'niedrig', 2: 'mittel', 3: 'hoch' };

/** The refuellings in a KQE reply: [{ km, q }] (newest first as the DME keeps them; km 0 = none yet). */
function refuellings(k) {
    if (!k) return [];
    const out = [];
    for (let n = 1; n <= 5; n++) if (k['km' + n] > 0 && k['q' + n] >= 1 && k['q' + n] <= 3) out.push({ km: k['km' + n], q: k['q' + n] });
    return out;
}

module.exports = { DME, DEFAULTS, dmeConfig, CYLINDERS, names, QUALITY, refuellings, MISFIRE, ROUGH, INJ, IGN };
