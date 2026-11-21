'use strict';
/**
 * ev_core.js - small helpers every app here shares: numbers, bands, units, JSON files.
 *
 * Runs on the head unit's Node 8.16: no optional chaining, no ??, no Array.flat, no recursive mkdir.
 */
const fs = require('fs');
const path = require('path');

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const KM_MI = 0.621371;

/** The index of the band v falls in: edges [a, b, c] give bands (-inf, a), [a, b), [b, c), [c, inf). */
function bandOf(v, edges) {
    if (!isNum(v)) return -1;
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    return i;
}

/** Labels for the bands of edges: ['< 30', '30-50', ..., '130+'] (unit appended to the last). */
function bandLabels(edges, unit) {
    const out = ['< ' + edges[0]];
    for (let i = 1; i < edges.length; i++) out.push(edges[i - 1] + '-' + edges[i]);
    out.push(edges[edges.length - 1] + '+');
    if (unit) out[out.length - 1] += ' ' + unit;
    return out;
}

/** Read a JSON file, or dflt when it is missing or broken. */
function readJson(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}

/** Write a JSON file whole or not at all (temp file renamed over it): a power cut never leaves half a file. */
function writeJson(file, obj, mode) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    if (mode) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
}

/** mkdir that does not mind an existing folder (Node 8 has no { recursive: true }). */
function ensureDir(dir) {
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return dir;
}

/**
 * A JSON state file, saved at most every minMs (and at exit): store.data is the object.
 *   const s = new Store(dir, 'state.json', { sessions: [] });  s.data.sessions.push(x); s.save();
 */
class Store {
    constructor(dir, name, dflt, log) {
        this.file = path.join(dir, name);
        this.log = log;
        this.data = Object.assign({}, dflt || {}, readJson(this.file, {}) || {});
        this.savedAt = 0;
        this.dirty = false;
        this.timer = null;
        process.on('exit', () => { if (this.dirty) this.flush(); });
    }
    /** Save soon (at most every minMs, default 20 s); force: now. */
    save(force, minMs) {
        this.dirty = true;
        const wait = (minMs == null ? 20000 : minMs) - (Date.now() - this.savedAt);
        if (force || wait <= 0) return this.flush();
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    }
    flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try { writeJson(this.file, this.data); this.dirty = false; this.savedAt = Date.now(); } catch (e) { if (this.log) this.log.warn('save ' + this.file + ': ' + e); }
    }
}

/** Distance and speed in the unit set ('km' or 'mi'). */
const dist = (km, unit) => (isNum(km) ? (unit === 'mi' ? km * KM_MI : km) : null);
/** Consumption kWh/100 km in the unit set: kWh/100 km, or mi/kWh for miles. */
function cons(kwh100, unit) {
    if (!isNum(kwh100)) return null;
    return unit === 'mi' ? (kwh100 > 0 ? 100 * KM_MI / kwh100 : null) : kwh100;
}
const consUnit = (unit) => (unit === 'mi' ? 'mi/kWh' : 'kWh/100km');
const temp = (c, unit) => (isNum(c) ? (unit === 'f' ? c * 9 / 5 + 32 : c) : null);

/** '14:05', 'Mon 14:05' or '03.11. 14:05' for a time stamp, as far back as it is. */
function when(t, now) {
    if (!isNum(t)) return '--';
    const d = new Date(t), n = new Date(now || Date.now());
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === n.toDateString()) return hm;
    if (n - d < 6 * 86400000) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + hm;
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '. ' + hm;
}

/** '1:05 h' or '12 min' for a duration in ms. */
function dur(ms) {
    if (!isNum(ms) || ms < 0) return '--';
    const m = Math.round(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ' h' : m + ' min';
}

/** Local day key 'YYYY-MM-DD' of a time stamp (charts per day). */
function dayKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * Linear interpolation in a table of [x, y] rows sorted by x (clamped at both ends).
 */
function interp(table, x) {
    if (!table.length || !isNum(x)) return null;
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (x <= table[i][0]) {
            const a = table[i - 1], b = table[i];
            return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
        }
    }
    return table[table.length - 1][1];
}

/** Every entry (recursively) of a SOME/IP value that has key: lists of zones, nested structs. */
function entries(v, key, out) {
    out = out || [];
    if (v && typeof v === 'object') {
        if (key in v) out.push(v);
        else Object.keys(v).forEach((k) => entries(v[k], key, out));
    }
    return out;
}
const one = (v, key) => { const e = entries(v, key)[0]; return e ? e[key] : undefined; };

module.exports = { isNum, clamp, KM_MI, bandOf, bandLabels, readJson, writeJson, ensureDir, Store, dist, cons, consUnit, temp, when, dur, dayKey, interp, entries, one };
