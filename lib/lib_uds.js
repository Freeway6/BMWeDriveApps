'use strict';
/**
 * lib_uds.js - values from a control unit with UDS ReadDataByIdentifier (0x22) or OBD-II service 01 over the head
 * unit's own diagnostic link (kit/diag.js, kit/dids.js). Read only: nothing else is ever sent.
 *
 * Every value has a list of candidates; the first that answers with a plausible number wins and is asked
 * first next time. A candidate: { ecu, did: '4402', bytes, at, factor, offset, signed, min, max } (kit/dids.js),
 * or { ecu, obd: '0C', ... }; a group: { did, fields: { name: { at, bytes, factor, offset, signed, min, max } } }.
 *
 *   const r = new UdsReader(signals, log, config, 18);
 *   await r.init();
 *   await r.value('oilTemp')      -> number or null
 *   await r.group('kqe')          -> { field: value } or null
 */
const { Diag, hex } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const { linkQueue } = require('./lib_link');

class UdsReader {
    constructor(signals, log, config, ecu) {
        this.log = log;
        this.cfg = config || {};
        this.diag = new Diag(signals, log);
        this.diag.quiet = true;
        this.diag.busyLog = false;
        this.reader = new DidReader(this.diag, { ecu: ecu == null ? this.cfg.ecu : ecu });
        this.exclusive = linkQueue(log);
        this.fails = {};
        this.last = {};             // name -> { v, t }
        this.reads = 0;
    }

    init() { return this.diag.init(); }
    get available() { return !!this.diag.available; }

    /** The candidates that answered, to remember across starts (pick) and put back with usePick(). */
    get pick() { return Object.assign({}, this.reader.pick); }
    usePick(p) { Object.assign(this.reader.pick, p || {}); }

    /** A value that failed 3 times in a row is asked again only every retryMs (a unit that is not there holds the link). */
    due(name, retryMs) {
        const f = this.fails[name];
        return !f || f.n < 3 || Date.now() - f.t > (retryMs || 120000);
    }
    counted(name, v) {
        if (v === null) this.fails[name] = { n: (this.fails[name] ? this.fails[name].n : 0) + 1, t: Date.now() };
        else { delete this.fails[name]; this.last[name] = { v, t: Date.now() }; }
        return v;
    }
    /** Whether a value has answered at least once (this start). */
    answers(name) { return !!this.last[name]; }

    /** One plain value by name: number or null. */
    async value(name, urgent) {
        const list = this.cfg[name] || [];
        if (!list.length || !this.available || !this.due(name)) return null;
        this.reads++;
        const v = await this.exclusive(() => this.reader.value(name, list), urgent, name);
        return this.counted(name, v);
    }

    /** One candidate with several fields in one reply: { field: value } (out of range or missing: null), or null. */
    async readFields(c) {
        const names = Object.keys(c.fields || {});
        if (!names.length) return null;
        const p = Object.assign({ ecu: c.ecu, did: c.did, timeoutMs: c.timeoutMs }, c.fields[names[0]]);
        const v0 = await this.reader.read(p);
        if (v0 === null) return null;
        const r = this.reader.raws[this.reader.key(p)];
        const bytes = r.bytes.split(' ').map((x) => parseInt(x, 16)), out = {};
        names.forEach((k, i) => { out[k] = i === 0 ? v0 : UdsReader.field(bytes, c.fields[k]); });
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

    /** A group of fields by name: { field: value } or null, starting with the candidate that answered last. */
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

    /** Several values in one go (each its own request): { name: value }. */
    async values(names, urgent) {
        const out = {};
        for (const n of names) out[n] = await this.value(n, urgent);
        return out;
    }

    /** Lines for the Diagnostics page. */
    diagLines() { return [['Abfragen', String(this.reads)]]; }

    /** Every value's last raw reply, for a Diagnostics page: [{ key, label, ok, bytes, why, value, t }]. */
    raws() {
        const r = this.reader.raws;
        return Object.keys(r).sort().map((k) => {
            const ecu = Number(k.split(':')[0]);
            return Object.assign({ key: k, label: '0x' + hex(ecu) + ' ' + k.split(':')[1] }, r[k]);
        });
    }
}

module.exports = { UdsReader };
