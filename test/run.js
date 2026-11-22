'use strict';
/**
 * Tests of the shared logic (lib/), without a car: node test/run.js
 *
 * The UDS path is tested end to end against a fake diagnostic transport that answers like a battery unit
 * (the TASU frame format kit/runtime/diag.js reads). lib/ requires './kit/...' as the built app does, so the
 * tests run from a staged copy: test/stage/ (lib + kit/runtime), made here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(__dirname, 'stage');
function copyDir(a, b) {
    try { fs.mkdirSync(b); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.readdirSync(a).forEach((f) => {
        const s = path.join(a, f), d = path.join(b, f);
        if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
    });
}
copyDir(path.join(ROOT, 'lib'), STAGE);
copyDir(path.join(ROOT, 'kit', 'runtime'), path.join(STAGE, 'kit'));
const L = (m) => require(path.join(STAGE, m));

let n = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, (what || '') + ' ' + a + ' not within ' + tol + ' of ' + b);

/* ---------------- ev_model ---------------- */
test('model: 10-80 % at a warm battery takes about 31 min', () => {
    const M = L('ev_model');
    near(M.chargeMinutes(10, 80, 25).min, 30.5, 2, '10-80');
    assert.ok(M.chargeMinutes(10, 80, 5).min > M.chargeMinutes(10, 80, 15).min, 'colder is slower');
    assert.ok(M.expectKw(15, 30) > 200 && M.expectKw(80, 30) < 70, 'curve shape');
    assert.strictEqual(Math.round(M.expectKw(20, 30, { charger: 50 })), 50, 'charger limit');
    near(M.expectKw(20, 30, { battery: '70.2' }), 198 * 180 / 205, 1, 'eDrive35');
});
test('model: a learned band raises the prior where the car did more', () => {
    const M = L('ev_model'), grid = {};
    assert.ok(M.learn(grid, 35, 12, 150));
    assert.ok(!M.learn(grid, 36, 13, 120), 'lower is not learned');
    near(M.expectKw(35, 12, { grid }), 150, 0.01, 'learned');
    near(M.expectKw(35, 30, { grid }), M.priorKw(35, 30), 0.01, 'other band: prior');
    M.learn(grid, 75, 30, 20);
    near(M.expectKw(75, 30, { grid }), M.priorKw(75, 30), 0.01, 'a slow charger does not lower it');
});

/* ---------------- ev_charge ---------------- */
function charge(tr, from, to, cellT, startT, stepS) {
    const { DemoCharge } = L('ev_demo');
    const c = new DemoCharge({ soc0: from, cellT, charger: 200 });
    let t = startT;
    for (let s = 0; ; s += stepS) {
        const p = c.at(s / 60);
        tr.sample({ t, kwIn: p.kw, soc: p.soc, cellT: p.cellT, speed: 0 });
        t += stepS * 1000;
        if (p.soc >= to || s > 7200) break;
    }
    return t;
}
test('charge: a DC charge is found, measured and closed when the power stops', () => {
    const { ChargeTracker, between, span } = L('ev_charge');
    const st = {}, closed = [];
    const tr = new ChargeTracker(st, { onClose: (s) => closed.push(s) });
    let t = 1e12;
    for (let i = 0; i < 5; i++) { tr.sample({ t, kwIn: -0.7, soc: 8, speed: 0 }); t += 2000; }
    assert.strictEqual(st.open, null, 'standing is not charging');
    t = charge(tr, 8, 80, 22, t, 2);
    assert.ok(st.open, 'open while charging');
    for (let i = 0; i < 60; i++) { tr.sample({ t, kwIn: 0.1, soc: 80.1, speed: 0 }); t += 2000; }
    assert.strictEqual(closed.length, 1);
    const s = closed[0];
    assert.strictEqual(s.kind, 'DC');
    near(s.kwh, (80 - 8) * 0.807, 1.5, 'energy = charge added x kWh per %');
    near(between(s, 10, 80), 29, 3, '10-80 min');
    assert.deepStrictEqual([span(s).a, span(s).b], [10, 80]);
    assert.ok(s.points.length > 20 && s.points.length <= 160, 'curve points ' + s.points.length);
    assert.ok(s.peak > 150, 'peak ' + s.peak);
});
test('charge: driving off ends it; a session slept through is closed at the next start', () => {
    const { ChargeTracker } = L('ev_charge');
    const st = {};
    const tr = new ChargeTracker(st);
    let t = charge(tr, 30, 40, 25, 1e12, 5);
    assert.strictEqual(tr.sample({ t, kwIn: -20, soc: 40, speed: 12 }), 'end');
    assert.strictEqual(st.sessions.length, 1);
    t = charge(tr, 40, 45, 25, t + 60000, 5);
    assert.ok(st.open);
    assert.ok(tr.resume(t + 3600000, 70), 'slept through');
    const s = st.sessions[1];
    assert.strictEqual(s.soc1, 70);
    assert.ok(s.partial);
});
test('charge: a blip under 1 % and 0.5 kWh is not kept; the reference is of the same kind', () => {
    const { ChargeTracker, reference } = L('ev_charge');
    const st = {};
    const tr = new ChargeTracker(st);
    let t = 1e12;
    for (let i = 0; i < 4; i++) { tr.sample({ t, kwIn: 3, soc: 50, speed: 0 }); t += 2000; }
    for (let i = 0; i < 60; i++) { tr.sample({ t, kwIn: 0, soc: 50, speed: 0 }); t += 2000; }
    assert.strictEqual(st.sessions.length, 0);
    const a = { id: 1, kind: 'DC', soc0: 10, soc1: 80, points: [[0, 10, 100], [10, 80, 100]] };
    const b = { id: 2, kind: 'AC', soc0: 10, soc1: 80, points: [[0, 10, 11], [300, 80, 11]] };
    const c = { id: 3, kind: 'DC', soc0: 20, soc1: 60, points: [[0, 20, 150], [10, 60, 150]] };
    assert.strictEqual(reference([a, b, c], a, null).id, 3);
    assert.strictEqual(reference([a, b, c], b, null), null);
    assert.strictEqual(reference([a, b, c], c, 1).id, 1, 'pinned');
});

/* ---------------- ev_trip, ev_regen ---------------- */
test('trip: distance from speed, closed after 5 minutes standing', () => {
    const { TripClock } = L('ev_trip');
    const st = {}, closed = [];
    const tc = new TripClock(st, { onClose: (s) => closed.push(s) });
    let t = 0;
    for (let i = 0; i < 600; i++) { tc.speed(t, 60); t += 1000; }        // 10 min at 60 km/h
    near(st.open.km, 10, 0.05, 'km');
    for (let i = 0; i < 400; i++) { tc.speed(t, 0); t += 1000; tc.check(t); }
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(st.open, null);
});
test('regen: a stop gives back what the battery took, against the energy the car had to lose', () => {
    const { Braking } = L('ev_regen');
    const P = L('ev_phys');
    const evs = [];
    const b = new Braking({ onEvent: (e) => evs.push(e) });
    // 100 -> 0 km/h at 2 m/s², the motors giving back 70 % of the braking power
    let t = 0, v = 100;
    b.sample(t, 20, v);
    while (v > 0) {
        t += 500;
        const v1 = Math.max(0, v - 2 * 3.6 * 0.5), ms = P.kmh((v + v1) / 2);
        const brake = P.CAR.mass * 2 * ms / 1000 - P.roadKw(ms);
        v = v1;
        b.sample(t, -0.7 * brake, v);
    }
    assert.strictEqual(evs.length, 1);
    near(evs[0].eff, 0.7, 0.08, 'recovered share');
    near(evs[0].decel, 2, 0.3, 'decel');
});

/* ---------------- ev_coach ---------------- */
test('coach: slices by speed band, the usual, the last km', () => {
    const { Coach, lastKm } = L('ev_coach');
    const c = new Coach({});
    for (let i = 0; i < 100; i++) c.slice({ km: 0.3, kwh: 0.06, h: 0.3 / 120, amb: 5, mode: 'comfort', climate: true });
    for (let i = 0; i < 100; i++) c.slice({ km: 0.25, kwh: 0.0375, h: 0.25 / 90, amb: 5, mode: 'eco', climate: false });
    c.slice({ km: 0, kwh: 0.05, h: 0.04 });
    near(c.cons(c.bins.speed[5]), 20, 0.01, '110-130');
    near(c.cons(c.bins.speed[4]), 15, 0.01, '90-110');
    near(c.cons(c.bins.mode.eco), 15, 0.01, 'mode');
    near(c.cons(c.bins.climate.on), 20, 0.01, 'climate');
    near(c.usual(140), 20, 0.01, 'nearest band with data');
    near(c.expected([{ km: 1, h: 1 / 120 }, { km: 1, h: 1 / 95 }]), 0.35, 0.001);
    near(c.bins.stand.kwh, 0.05, 1e-9, 'standing kept apart');
    // speeding up from a stop and braking for the next one: in one piece, not split over two bands
    const c2 = new Coach({});
    for (let k = 0; k < 20; k++) { c2.slice({ km: 0.05, kwh: 0.03, h: 10 / 3600 }); c2.slice({ km: 0.1, kwh: 0.01, h: 10 / 3600 }); c2.slice({ km: 0.05, kwh: -0.012, h: 10 / 3600 }); }
    assert.strictEqual(c2.bins.speed.filter((b) => b.km > 0).length, 1, 'one band');
    const w = lastKm([{ km: 1, kwh: 0.2 }, { km: 2, kwh: 0.3 }, { km: 3, kwh: 0.5 }], 4);
    assert.deepStrictEqual([w.km, w.kwh], [5, 0.8]);
});

/* ---------------- ev_core: German formats ---------------- */
test('core: decimal comma, German weekdays, durations', () => {
    const C = L('ev_core');
    assert.strictEqual(C.fmt(12.345, 1), '12,3');
    assert.strictEqual(C.fmt(205, 0), '205');
    assert.strictEqual(C.fmt(null, 1), '--');
    const now = new Date(2026, 10, 20, 12, 0).getTime();               // a Friday
    assert.strictEqual(C.when(new Date(2026, 10, 19, 8, 5).getTime(), now), 'Do 08:05');
    assert.strictEqual(C.when(new Date(2026, 9, 3, 14, 5).getTime(), now), '03.10. 14:05');
    assert.strictEqual(C.dur(65 * 60000), '1:05 h');
    assert.strictEqual(C.consUnit('km'), 'kWh/100 km');
});

/* ---------------- ev_signals ---------------- */
test('signals: driving modes and vehicle states by name or number', () => {
    const { modeOf, conditionOf } = L('ev_signals');
    assert.strictEqual(modeOf('ECO_PRO_EFFICIENT'), 'eco');
    assert.strictEqual(modeOf(1), 'sport');
    assert.strictEqual(modeOf('COMFORT'), 'comfort');
    assert.strictEqual(modeOf('PERSONAL_SOMETHING'), 'comfort');
    assert.strictEqual(conditionOf('FAHREN'), 10);
    assert.strictEqual(conditionOf(3), 3);
});

/* ---------------- ev_hv: decoding and the UDS path ---------------- */
test('hv: fields of a reply (signed 4-byte current, offsets)', () => {
    const { Hv } = L('ev_hv');
    // 62 E5 61 then -123.45 A (two's complement, 0.01 A)
    const raw = (-12345 >>> 0).toString(16).padStart(8, '0').match(/../g).map((x) => parseInt(x, 16));
    near(Hv.field([0x62, 0xE5, 0x61].concat(raw), { bytes: 4, factor: 0.01, signed: true }), -123.45, 1e-9);
    // E5C7: stored 61.23 kWh = raw 11123 (x 0.01 - 50)
    near(Hv.field([0x62, 0xE5, 0xC7, 0x2B, 0x73], { bytes: 2, factor: 0.01, offset: -50 }), 61.23, 1e-9);
    assert.strictEqual(Hv.field([0x62, 0xDD, 0xC0, 0x01], { at: 2, bytes: 2 }), null, 'short reply');
});

/** A fake TASU link: answers 0x22 requests to unit `ecu` from `table` { DID: [bytes] } like a car does. */
function fakeSignals(table) {
    let onResp = null;
    const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
    return {
        proxy: async () => ({}),
        on: async (p, name, fn) => { onResp = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, method, a) => {
            const did = (a.udsData[0] << 8 | a.udsData[1]).toString(16).toUpperCase().padStart(4, '0');
            const key = a.targetAddress + ':' + did;
            setTimeout(() => onResp(frame(a.targetAddress, table[key] ? [0x62, a.udsData[0], a.udsData[1]].concat(table[key]) : [0x7F, 0x22, 0x31])), 5);
            return { TasuErrorEnum: 'NO_ERROR' };
        },
        watch: async () => ({ error: 'test' }),
    };
}
const be = (v, n) => { const out = []; let x = v < 0 ? v + Math.pow(2, 8 * n) : v; for (let i = 0; i < n; i++) { out.unshift(x & 0xFF); x = Math.floor(x / 256); } return out; };
const quiet = { info() {}, warn() {}, error() {} };

test('hv: power from the battery unit (fifth generation: E54D x E561), sign and fallbacks', async () => {
    const { Hv } = L('ev_hv');
    // 370.00 V, +250.00 A into the battery (charging): out = -92.5 kW
    const hv = new Hv(fakeSignals({ '7:E54D': be(37000, 2), '7:E561': be(25000, 4), '7:E5CE': be(5432, 2), '7:E5C7': be(9383, 2).concat(be(13070, 2)),
        '7:DDC0': be(1850, 2).concat(be(2210, 2), be(2000, 2)), '96:D10D': be(23817, 4) }), quiet);
    await hv.init();
    assert.ok(hv.available);
    const p = await hv.power();
    near(p.kw, -92.5, 1e-6, 'kW out');
    near(await hv.value('soc'), 54.32, 1e-9);
    const e = await hv.group('energy');
    near(e.stored, 43.83, 1e-9); near(e.cap, 80.7, 1e-9);
    const tc = await hv.group('temp');
    assert.deepStrictEqual([tc.min, tc.max, tc.avg], [18.5, 22.1, 20]);
    assert.strictEqual(await hv.value('odo'), 23817);
    assert.strictEqual(hv.reader.pick.soc, 0, 'E5CE answered first');
});
test('hv: fourth-generation identifiers answer when the fifth-generation ones do not', async () => {
    const { Hv } = L('ev_hv');
    const hv = new Hv(fakeSignals({ '7:DD68': be(35000, 2), '7:DD69': be(-10000, 4), '7:DDBC': be(612, 2) }), quiet);
    await hv.init();
    const p = await hv.power();
    near(p.kw, 35, 1e-6, 'driving: out of the battery');
    near(await hv.value('soc'), 61.2, 1e-9);
    assert.strictEqual(hv.reader.pick.soc, 1);
});
test('hv: the current direction is learned from a charge, or set', () => {
    const { Hv } = L('ev_hv');
    const hv = new Hv(fakeSignals({}), quiet);
    hv.applySign('auto', null);
    let s = null;
    // standing, +60 kW raw (V x A as read): that is into the battery, so out = raw x -1
    for (let i = 0; i < 40 && !s; i++) s = hv.learnSign({ raw: 60, kw: -60 }, 0);
    assert.strictEqual(s, -1);
    const h2 = new Hv(fakeSignals({}), quiet);
    h2.applySign('reversed', null);
    assert.strictEqual(h2.powerSign(), 1);
    assert.strictEqual(h2.learnSign({ raw: 60 }, 0), null, 'set: not learned');
});

/* ---------------- live on the iPhone: ev_live, ev_livedoc ---------------- */
const os = require('os');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'i4live-'));
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('live: pairing link, derived tokens, sealed documents bound to channel and slot', () => {
    const { Pairing, sha256hex } = L('ev_live');
    const p = Pairing.make();
    assert.ok(/^[0-9a-f]{32}$/.test(p.channel) && /^[0-9a-f]{64}$/.test(p.readToken) && p.readToken !== p.writeToken);
    assert.strictEqual(p.readHash, sha256hex(p.readToken));
    const back = Pairing.fromUrl(p.url('https://i4-live.example.workers.dev'));
    assert.strictEqual(back.relay, 'https://i4-live.example.workers.dev');
    assert.strictEqual(back.pairing.readToken, p.readToken, 'the phone derives the same tokens');
    const doc = { v: 1, soc: 54.3, kw: 151.2, note: 'Zellen 31 °C' };
    const blob = p.seal('state', doc);
    assert.deepStrictEqual(back.pairing.open('state', blob), doc);
    assert.throws(() => p.open('curve', blob), 'another slot');
    assert.throws(() => Pairing.make().open('state', blob), 'another key');
    const raw = Buffer.from(blob, 'base64');
    assert.strictEqual(raw.length, 12 + Buffer.byteLength(JSON.stringify(doc)) + 16, 'nonce | ciphertext | tag');
});

test('live: forecast of a DC charge and of an AC charge', () => {
    const { forecast, minutesTo } = L('ev_livedoc');
    const fc = forecast(20, 30, 180, { battery: '83.9', peak: 205 });
    assert.deepStrictEqual(fc[0], [0, 20, 180]);
    assert.strictEqual(fc[fc.length - 1][1], 100);
    for (let i = 1; i < fc.length; i++) assert.ok(fc[i][0] > fc[i - 1][0] && fc[i][1] > fc[i - 1][1], 'rising');
    assert.ok(fc.every((x) => x[2] <= 205), 'never above the peak so far');
    const to80 = minutesTo(fc, 80);
    assert.ok(to80 > 15 && to80 < 35, '20 -> 80 % warm: ' + to80 + ' min');
    const slow = forecast(20, 30, 50, { battery: '83.9', peak: 50 });
    assert.ok(minutesTo(slow, 80) > 2 * to80, 'a 50 kW station');
    const ac = forecast(50, 20, 11, { battery: '83.9', ac: true });
    near(minutesTo(ac, 80), 30 * 0.807 / 11 * 60, 0.5, 'AC: constant power');
    assert.strictEqual(forecast(50, 20, 0.1, {}), null, 'not charging');
    assert.strictEqual(minutesTo([[0, 85, 40]], 80), 0);
});

/** A recorder's view after `minutes` of a demo DC charge. */
function demoView(minutes) {
    const { ChargeTracker } = L('ev_charge');
    const { DemoCharge, demoSessions } = L('ev_demo');
    const st = { sessions: demoSessions(4), open: null, grid: {}, pinned: null };
    const tr = new ChargeTracker(st), c = new DemoCharge({ soc0: 12, cellT: 22, charger: 200 }), t0 = Date.parse('2026-11-22T10:00:00Z');
    let p = null;
    for (let s = 0; s <= minutes * 60; s += 10) { p = c.at(s / 60); tr.sample({ t: t0 + s * 1000, kwIn: p.kw, soc: p.soc, cellT: p.cellT, cellTmax: p.cellT + 2, speed: 0, stored: p.soc * 0.807 }); }
    return { v: { st, open: st.open, now: { kwIn: p.kw, soc: p.soc, temp: { min: p.cellT, max: p.cellT + 2 }, energy: { stored: p.soc * 0.807, cap: 80.7 } }, cellT: p.cellT, link: true },
        t: t0 + minutes * 60000 };
}
const liveOpts = (t) => ({ t, seq: t, target: 80, battery: '83.9', price: { DC: 0.59, AC: 0.3 }, loss: { DC: 1.05, AC: 1.1 } });

test('live: the state and the curve of a charge going on, and when idle', () => {
    const D = L('ev_livedoc');
    const { v, t } = demoView(12);
    const s = D.stateDoc(v, liveOpts(t));
    assert.strictEqual(s.phase, 'charging');
    assert.strictEqual(s.kind, 'DC');
    assert.ok(s.soc > 12 && s.kw > 50 && s.session.kwh > 5, JSON.stringify(s).slice(0, 200));
    near(s.session.cost, s.session.kwh * 1.05 * 0.59, 0.01, 'cost');
    assert.ok(s.fc.length > 5 && s.fc[0][1] === s.soc);
    const c = D.curveDoc(v, liveOpts(t));
    assert.strictEqual(c.live, true);
    assert.strictEqual(c.id, s.session.id);
    assert.ok(c.pts.length > 10 && c.pts[0].length === 4);
    assert.ok(c.ref && c.ref.pts.length > 5, 'a reference among the earlier charges');
    assert.strictEqual(c.exp.pts.length, 21);
    const idle = D.stateDoc({ st: v.st, open: null, now: { soc: 64 }, cellT: 25, link: true }, liveOpts(t));
    assert.strictEqual(idle.phase, 'idle');
    assert.strictEqual(idle.fc, null);
    assert.ok(idle.last && idle.last.kwh > 0);
    assert.ok(JSON.stringify(s).length < 4000, 'small: ' + JSON.stringify(s).length + ' bytes');
});

test('live: the uplink lease (DNS servers only while online)', () => {
    const { readLease } = L('ev_live');
    const d = tmpDir(), a = path.join(d, 'a.json'), b = path.join(d, 'b.json');
    fs.writeFileSync(a, '{"ip":"10.0.0.2","dns":[]}');
    fs.writeFileSync(b, JSON.stringify({ interface: 'vethuplink', ip: '192.168.8.100', prefix: 24, router: '192.168.8.1', dns: ['192.168.8.1'], leaseSeconds: 86400 }));
    assert.strictEqual(readLease([path.join(d, 'none.json'), a]), null, 'no DNS server: not online');
    assert.strictEqual(readLease([a, b]).ip, '192.168.8.100');
});

/** A DNS server for one name: answers its A queries with 127.0.0.1. */
function fakeDns(name) {
    const dgram = require('dgram');
    const sock = dgram.createSocket('udp4');
    sock.on('message', (q, from) => {
        let i = 12; const labels = [];
        while (q[i]) { labels.push(q.slice(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; }
        const qEnd = i + 5, ok = labels.join('.') === name;
        const head = Buffer.from([q[0], q[1], 0x81, ok ? 0x80 : 0x83, 0, 1, 0, ok ? 1 : 0, 0, 0, 0, 0]);
        const answer = ok ? Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]) : Buffer.alloc(0);
        sock.send(Buffer.concat([head, q.slice(12, qEnd), answer]), from.port, from.address);
    });
    return new Promise((res) => sock.bind(0, '127.0.0.1', () => res(sock)));
}

test('live: put -> relay -> the phone reads and opens it; the name resolved through the lease', async () => {
    const { LiveLink, Pairing } = L('ev_live');
    const D = L('ev_livedoc');
    const { startLocal } = await import(path.join(ROOT, 'relay', 'test', 'local.mjs'));
    const relay = await startLocal(0);
    const dnsSrv = await fakeDns('relay.i4live.test');
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'uplink.json'), JSON.stringify({ ip: '10.1.2.3', dns: ['127.0.0.1:' + dnsSrv.address().port] }));
    const link = new LiveLink({ dataDir: d, relay: 'http://relay.i4live.test:' + relay.port, enabled: () => true, leaseFiles: [path.join(d, 'uplink.json')] });
    try {
        const { v, t } = demoView(9);
        const state = D.stateDoc(v, liveOpts(t)), curve = D.curveDoc(v, liveOpts(t));
        assert.ok(link.put('state', state) && link.put('curve', curve));
        assert.ok(await until(() => link.status().sent === 2), 'sent: ' + JSON.stringify(link.status()));
        assert.strictEqual(link.status().uplink, 'online');
        // the phone: only the pairing link
        const { pairing, relay: base } = Pairing.fromUrl(link.pairUrl());
        const r = await fetch('http://127.0.0.1:' + relay.port + '/v1/c/' + pairing.channel, { headers: { authorization: 'Bearer ' + pairing.readToken } });
        assert.ok(base.indexOf('relay.i4live.test') > 0);
        const j = await r.json();
        assert.deepStrictEqual(pairing.open('state', j.state.blob), state);
        assert.deepStrictEqual(pairing.open('curve', j.curve.blob), curve);
        assert.strictEqual(fs.statSync(path.join(d, 'live.json')).mode & 0o777, 0o600, 'the key: owner only');
        // a new pairing: the old channel goes from the relay
        const old = pairing.channel;
        link.rekey();
        assert.notStrictEqual(link.pairing.channel, old);
        assert.ok(await until(async () => (await fetch('http://127.0.0.1:' + relay.port + '/v1/c/' + old, { headers: { authorization: 'Bearer ' + pairing.readToken } })).status === 404), 'old channel deleted');
    } finally { link.stop(); relay.server.close(); dnsSrv.close(); }
});

test('live: offline without a lease; the error is kept and retried later', async () => {
    const { LiveLink } = L('ev_live');
    const d = tmpDir();
    const link = new LiveLink({ dataDir: d, relay: 'https://i4-live.example.workers.dev', enabled: () => true, leaseFiles: [path.join(d, 'none.json')] });
    try {
        link.put('state', { v: 1, seq: 1, t: 1 });
        assert.ok(await until(() => link.status().lastError), 'an error');
        assert.ok(/Uplink/.test(link.status().lastError), link.status().lastError);
        assert.strictEqual(link.status().uplink, 'offline');
        assert.strictEqual(link.status().queued, 1, 'kept for later');
        assert.ok(link.nextAt > Date.now(), 'backing off');
        const off = new LiveLink({ dataDir: d, relay: 'https://x.test', enabled: () => false });
        assert.strictEqual(off.put('state', { seq: 1 }), false, 'live off: nothing queued');
        off.stop();
        // switched off after something was queued: it is dropped, not sent
        let on = true;
        const later = new LiveLink({ dataDir: d, relay: 'https://x.test', enabled: () => on, leaseFiles: [] });
        later.pending.state = { seq: 2 };
        on = false;
        await later.flush();
        assert.deepStrictEqual(later.pending, {});
        assert.strictEqual(later.status().lastError, null, 'not tried');
        later.stop();
    } finally { link.stop(); }
});

test('live: TLS - a certificate no root knows: unchecked only with the fallback policy', async () => {
    const { request } = L('ev_live');
    const { execSync } = require('child_process');
    const d = tmpDir();
    try { execSync('openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -keyout ' + path.join(d, 'k.pem') + ' -out ' + path.join(d, 'c.pem'), { stdio: 'ignore' }); } catch (e) { console.log('     (no openssl: skipped)'); return; }
    const https = require('https');
    const srv = https.createServer({ key: fs.readFileSync(path.join(d, 'k.pem')), cert: fs.readFileSync(path.join(d, 'c.pem')) }, (req, res) => { res.end('{"ok":true}'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { URL } = require('url');
    const u = new URL('https://localhost:' + srv.address().port + '/v1/health');
    try {
        await assert.rejects(request(u, { ip: '127.0.0.1', method: 'GET', tls: 'system' }), (e) => L('ev_live').CERT_ERRORS.indexOf(e.code) >= 0);
        await assert.rejects(request(u, { ip: '127.0.0.1', method: 'GET', tls: 'roots' }), (e) => L('ev_live').CERT_ERRORS.indexOf(e.code) >= 0);
        const r = await request(u, { ip: '127.0.0.1', method: 'GET', tls: 'insecure' });
        assert.strictEqual(r.status, 200);
        const { LiveLink } = L('ev_live');
        const strict = new LiveLink({ dataDir: d, relay: 'https://127.0.0.1:' + srv.address().port, tls: 'strict', enabled: () => true });
        await assert.rejects(strict.call('GET', '/v1/health', null, {}), (e) => /Zertifikat/.test(e.de));
        strict.stop();
        const loose = new LiveLink({ dataDir: d, relay: 'https://127.0.0.1:' + srv.address().port, tls: 'fallback', enabled: () => true });
        assert.strictEqual((await loose.call('GET', '/v1/health', null, {})).status, 200);
        assert.strictEqual(loose.status().tls, 'insecure');
        loose.stop();
    } finally { srv.close(); }
});

test('live: the QR code on the iPhone page holds the pairing link', () => {
    const QR = L('kit/qr');
    const { Pairing } = L('ev_live');
    const url = Pairing.make().url('https://i4-live.someone.workers.dev');
    const code = QR.encode(Buffer.from(url), { ecl: 'M' });
    assert.ok(code.version <= 10, 'version ' + code.version + ' for ' + url.length + ' bytes');
    const calls = [];
    const w = L('ev_ui').qr({ fillRect: (x, y, ww, h, c) => calls.push([x, y, ww, h, c]) }, 0, 0, 340, url);
    assert.strictEqual(w % (code.size + 8), 0, 'whole pixels a module');
    assert.ok(w <= 340 && w >= 240, 'width ' + w);
    assert.ok(calls.length < code.size * code.size / 3, calls.length + ' rectangles');
});

/* ---------------- run ---------------- */
(async () => {
    for (const [name, fn] of tests) {
        n++;
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
    }
    console.log('\n' + (n - failed) + ' / ' + n + ' passed');
    process.exit(failed ? 1 : 0);
})();
