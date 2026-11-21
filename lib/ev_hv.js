'use strict';
/**
 * ev_hv.js - the high-voltage battery and a few other values, read with UDS ReadDataByIdentifier (0x22)
 * over the head unit's own diagnostic link (kit/diag.js, kit/dids.js).
 *
 * Made for BMW's fifth-generation eDrive (i4 G26, iX3 G08, iX): the battery unit SME answers at 0x07.
 * Every value has a list of candidates; the first that answers with a plausible number wins and is
 * asked first next time (fourth-generation identifiers come after the fifth-generation ones). The
 * candidates can be changed per car in app.json "config.hv" (merged over DEFAULTS by key).
 *
 * Sources of the identifiers and scalings: the OBDb captures of the iX3 and the iX
 * (github.com/OBDb/BMW-iX3, BMW-iX; CC BY-SA 4.0) and idrive7-apps' eDrive (MIT). On the i4 only the
 * instrument cluster's D107 / D10D are confirmed in OBDb: the battery's are the same unit generation,
 * not yet seen on a G26. The Diagnostics page of each app shows every raw reply.
 *
 *   const hv = new Hv(signals, log, spec.config && spec.config.hv);
 *   await hv.init();
 *   const p = await hv.power();      // { kw, v, a, t }: kw + = the battery gives power, - = it takes it
 *   const s = await hv.value('soc'); // number or null
 *   const e = await hv.group('energy');   // { stored, cap } or null
 */
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { linkQueue } = require('./ev_link');
const { isNum } = require('./ev_core');

const SME = 7, KOMBI = 96, LIM = 20;

/** Candidates per value. Numbers are decimal (JSON): ecu 96 = 0x60 (instrument cluster), 20 = 0x14 (charging unit). */
const DEFAULTS = {
    ecu: SME,
    // kW out of the battery = V x A / 1000 x powerSign. E561 / DD69 count + into the battery (charging, regen).
    powerSign: -1,
    soc: [
        { did: 'E5CE', bytes: 2, factor: 0.01, min: 0, max: 100, note: 'fifth generation: charge in 0.01 %' },
        { did: 'DDBC', bytes: 2, factor: 0.1, min: 0.5, max: 100, note: 'fourth generation (the iX3 answers zero here)' },
    ],
    energy: [
        { did: 'E5C7', fields: {
            stored: { bytes: 2, factor: 0.01, offset: -50, min: -2, max: 200 },
            cap: { at: 2, bytes: 2, factor: 0.01, offset: -50, min: 10, max: 200 } },
        note: 'energy stored now and usable capacity, kWh' },
    ],
    volt: [
        { did: 'E54D', timeoutMs: 900, bytes: 2, factor: 0.01, min: 150, max: 500, note: 'pack voltage, fifth generation (iX)' },
        { did: 'DD68', timeoutMs: 900, bytes: 2, factor: 0.01, min: 150, max: 500, note: 'pack voltage, fourth generation' },
        { did: 'DDB4', timeoutMs: 900, bytes: 2, factor: 0.01, min: 150, max: 500 },
    ],
    amp: [
        { did: 'E561', timeoutMs: 900, bytes: 4, factor: 0.01, signed: true, min: -1000, max: 1000, note: 'pack current, + into the battery' },
        { did: 'DD69', timeoutMs: 900, bytes: 4, factor: 0.01, signed: true, min: -1000, max: 1000 },
    ],
    temp: [
        { did: 'DDC0', fields: {
            min: { bytes: 2, factor: 0.01, signed: true, min: -40, max: 80 },
            max: { at: 2, bytes: 2, factor: 0.01, signed: true, min: -40, max: 80 },
            avg: { at: 4, bytes: 2, factor: 0.01, signed: true, min: -40, max: 80 } },
        note: 'cell temperatures: lowest, highest, average (the average on the iX)' },
    ],
    cellV: [
        { did: 'E553', fields: { min: { bytes: 2, factor: 0.001, min: 2.5, max: 4.4 }, max: { at: 2, bytes: 2, factor: 0.001, min: 2.5, max: 4.4 } } },
        { did: 'DDBF', fields: { min: { bytes: 2, factor: 0.001, min: 2.5, max: 4.4 }, max: { at: 2, bytes: 2, factor: 0.001, min: 2.5, max: 4.4 } } },
    ],
    odo: [
        { ecu: KOMBI, did: 'D10D', bytes: 4, min: 0, max: 2000000, note: 'odometer, km (confirmed on the i4)' },
    ],
    dcPlug: [
        { ecu: LIM, did: 'DEF7', at: 3, bytes: 1, min: 0, max: 1, note: 'DC plug connected (charging unit)' },
    ],
};

/** Values in app.json config.hv replace the default's list of that name (or a number like powerSign). */
function merge(cfg) {
    const out = {};
    Object.keys(DEFAULTS).forEach((k) => { out[k] = DEFAULTS[k]; });
    Object.keys(cfg || {}).forEach((k) => { if (k !== 'comment') out[k] = cfg[k]; });
    return out;
}

class Hv {
    constructor(signals, log, cfg) {
        this.log = log;
        this.cfg = merge(cfg);
        this.diag = new Diag(signals, log);
        this.diag.quiet = true;
        this.diag.busyLog = false;
        this.reader = new DidReader(this.diag, { ecu: this.cfg.ecu });
        this.exclusive = linkQueue(log);
        this.fails = {};
        this.last = {};              // name -> { v, t }
        this.sign = null;            // learned or set: +1 / -1 (null: cfg.powerSign)
        this.signVotes = { driveSum: 0, driveN: 0, chargeSum: 0, chargeN: 0 };
        this.volt = null;            // last pack voltage { v, t }
        this.reads = 0;
    }

    init() { return this.diag.init(); }
    get available() { return !!this.diag.available; }

    /** The candidates that answered, to remember across starts (pick) and put back with usePick(). */
    get pick() { return Object.assign({}, this.reader.pick); }
    usePick(p) { Object.assign(this.reader.pick, p || {}); }

    /** A value that failed 3 times in a row is asked again only every retryMs (a unit that is not there holds the link for its timeout). */
    due(name, retryMs) {
        const f = this.fails[name];
        return !f || f.n < 3 || Date.now() - f.t > (retryMs || 60000);
    }
    counted(name, v) {
        if (v === null) this.fails[name] = { n: (this.fails[name] ? this.fails[name].n : 0) + 1, t: Date.now() };
        else { delete this.fails[name]; this.last[name] = { v, t: Date.now() }; }
        return v;
    }

    /** One plain value by name (soc, odo, dcPlug, ...): number or null. */
    async value(name, urgent) {
        const list = this.cfg[name] || [];
        if (!list.length || !this.available || !this.due(name)) return null;
        this.reads++;
        const v = await this.exclusive(() => this.reader.value(name, list), urgent, name);
        return this.counted(name, v);
    }

    /**
     * One candidate with several fields in one reply ({ did, fields: { name: { at, bytes, factor, ... } } }):
     * { field: value } (a field outside its min..max, or missing from a short reply: null), or null.
     */
    async readFields(c) {
        const names = Object.keys(c.fields || {});
        if (!names.length) return null;
        const p = Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs }, c.fields[names[0]]);
        const v0 = await this.reader.read(p);
        if (v0 === null) return null;
        const r = this.reader.raws[this.reader.key(p)];
        const bytes = r.bytes.split(' ').map((x) => parseInt(x, 16)), out = {};
        names.forEach((k, i) => {
            if (i === 0) { out[k] = v0; return; }
            out[k] = Hv.field(bytes, c.fields[k]);
        });
        return out;
    }

    /** A field's value from a positive 0x22 reply (bytes from 0x62 on), or null. */
    static field(bytes, f) {
        const at = 3 + (f.at || 0), n = f.bytes || 1;
        if (bytes.length < at + n) return null;
        let raw = 0;
        for (let j = 0; j < n; j++) raw = raw * 256 + bytes[at + j];
        if (f.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
        const v = raw * (f.factor == null ? 1 : f.factor) + (f.offset || 0);
        return (f.min != null && v < f.min) || (f.max != null && v > f.max) ? null : v;
    }

    /** A group of fields by name (energy, temp, cellV): { field: value } or null, starting with the candidate that answered last. */
    async group(name, urgent) {
        const list = this.cfg[name] || [];
        if (!list.length || !this.available || !this.due(name)) return null;
        this.reads++;
        const pick = this.reader.pick;
        const v = await this.exclusive(async () => {
            const start = pick[name] || 0;
            for (let k = 0; k < list.length; k++) {
                const i = (start + k) % list.length, r = await this.readFields(list[i]);
                if (r) { pick[name] = i; return r; }
            }
            return null;
        }, urgent, name);
        return this.counted(name, v);
    }

    /** +1 or -1: kW out of the battery = V x A / 1000 x this. */
    powerSign() { return this.sign || this.cfg.powerSign || -1; }

    /**
     * The battery's power now: { kw (+ = gives power), v, a, t } or null. The current every call, the voltage
     * at most every voltMs (it moves slowly; under load it sags, so not much older than a few seconds).
     */
    async power(urgent, voltMs) {
        const a = await this.value('amp', urgent !== false);
        if (a === null) return null;
        const maxAge = voltMs == null ? 4000 : voltMs;
        if (!this.volt || Date.now() - this.volt.t > maxAge) {
            const v = await this.value('volt', urgent !== false);
            if (v !== null) this.volt = { v, t: Date.now() };
        }
        if (!this.volt) return null;
        const raw = this.volt.v * a / 1000;
        return { kw: raw * this.powerSign(), raw, v: this.volt.v, a, t: Date.now() };
    }

    /**
     * Learn the current's direction from what the car does, unless set: standing with more than 12 kW is
     * charging (into the battery); driving for half an hour takes power out of it on balance. raw = V x A / 1000
     * as read. Returns the sign once it is known from this (else null).
     */
    vote(raw, speed) {
        if (!isNum(raw) || !isNum(speed)) return null;
        const s = this.signVotes;
        if (speed < 0.5 && Math.abs(raw) > 12) { s.chargeSum += raw; s.chargeN++; }
        else if (speed > 20) { s.driveSum += raw; s.driveN++; }
        // charging: raw's sign is "into"; out is the other way round
        if (s.chargeN >= 30) return Math.abs(s.chargeSum / s.chargeN) > 12 ? (s.chargeSum > 0 ? -1 : 1) : null;
        if (s.driveN >= 1800 && Math.abs(s.driveSum / s.driveN) > 1.5) return s.driveSum > 0 ? 1 : -1;
        return null;
    }

    /** The direction to use: setting mode ('auto' | 'normal' | 'reversed') and the sign learned before (or null). */
    applySign(mode, learned) {
        const base = this.cfg.powerSign || -1;
        this.sign = mode === 'normal' ? base : mode === 'reversed' ? -base : learned || null;
        this.signFixed = mode === 'normal' || mode === 'reversed' || !!learned;
    }

    /**
     * Auto mode: learn the direction from a power() reading at speed (km/h). Returns the sign when it has just
     * been learned (p.kw is turned round to it), else null.
     */
    learnSign(p, speed) {
        if (this.signFixed || !p) return null;
        const s = this.vote(p.raw, isNum(speed) ? speed : 0);
        if (!s) return null;
        this.sign = s; this.signFixed = true;
        p.kw = p.raw * s;
        if (this.log) this.log.info('battery current direction learned: ' + s);
        return s;
    }

    /** Every value's last raw reply, for a Diagnostics page: [{ key, label, ok, bytes, why, value, t }]. */
    raws() {
        const r = this.reader.raws;
        return Object.keys(r).sort().map((k) => {
            const ecu = Number(k.split(':')[0]);
            return Object.assign({ key: k, label: '0x' + hex(ecu) + ' ' + k.split(':')[1] }, r[k]);
        });
    }
}

module.exports = { Hv, DEFAULTS, merge, SME, KOMBI, LIM };
