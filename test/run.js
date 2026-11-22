'use strict';
/**
 * Tests of the shared logic (lib/) and each app's own (apps/<id>/*.js other than main.js), without a car:
 * node test/run.js
 *
 * The UDS path is tested end to end against a fake diagnostic transport that answers like the B58's engine unit
 * (UDS 0x22 and OBD service 01 in the TASU frame format kit/runtime/diag.js reads). lib/ requires './kit/...' as the
 * built app does, so the tests run from a staged copy: test/stage/ (lib, the apps' modules, kit/runtime), made here.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(__dirname, 'stage');
function copyDir(a, b, only) {
    try { fs.mkdirSync(b); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.readdirSync(a).forEach((f) => {
        const s = path.join(a, f), d = path.join(b, f);
        if (fs.statSync(s).isDirectory()) { if (!only) copyDir(s, d); } else if (!only || only(f)) fs.copyFileSync(s, d);
    });
}
copyDir(path.join(ROOT, 'lib'), STAGE);
copyDir(path.join(ROOT, 'kit', 'runtime'), path.join(STAGE, 'kit'));
fs.readdirSync(path.join(ROOT, 'apps')).forEach((id) => copyDir(path.join(ROOT, 'apps', id), STAGE, (f) => /\.js$/.test(f) && f !== 'main.js' && !/^lib_/.test(f)));
const L = (m) => require(path.join(STAGE, m));

let n = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, (what || '') + ' ' + a + ' not within ' + tol + ' of ' + b);
const DAY = 86400000;

/* ---------------- lib_core ---------------- */
test('core: German numbers (comma, thousands, no -0) and weekdays', () => {
    const C = L('lib_core');
    assert.strictEqual(C.fmt(12.46, 1), '12,5');
    assert.strictEqual(C.fmt(44514, 0, true), '44.514');
    assert.strictEqual(C.fmt(-1234.5, 1, true), '-1.234,5');
    assert.strictEqual(C.fmt(-0.004, 2), '0,00');
    assert.strictEqual(C.fmt(null, 1), '--');
    const now = new Date(2026, 10, 22, 12, 0).getTime();          // a Sunday
    assert.strictEqual(C.when(new Date(2026, 10, 22, 9, 5).getTime(), now), '09:05');
    assert.strictEqual(C.when(new Date(2026, 10, 20, 18, 30).getTime(), now), 'Fr 18:30');
    assert.strictEqual(C.when(new Date(2026, 9, 3, 7, 0).getTime(), now), '03.10. 07:00');
});

/* ---------------- lib_flow ---------------- */
test('flow: the counter factor is learned from the engine unit, then gives l/h; it wraps at 16 bit', () => {
    const { Flow } = L('lib_flow');
    const f = new Flow(null), K = 0.0123;                        // l/h per count a second
    let raw = 65000, t = 0, changed = false;
    for (let i = 0; i < 300; i++) {
        raw = (raw + 50) % 65536;                                 // 500 counts a second at 10 Hz: 6.15 l/h
        t += 100;
        f.feed(raw, t);
        if (i % 10 === 9) changed = f.learn(500 * K, t) || changed;
    }
    assert.ok(changed, 'learned');
    near(f.k, K, 1e-6, 'factor');
    near(f.lph(t), 6.15, 0.01, 'l/h');
    assert.strictEqual(f.rateAt(t + 4000), 0, 'no counter for 3 s: engine off');
});
test('flow: litres over time and the time they cover; nothing across a gap', () => {
    const { Used } = L('lib_flow');
    const u = new Used();
    assert.strictEqual(u.add(3.6, 0), 0);
    near(u.add(3.6, 1000), 0.001, 1e-12, '3.6 l/h for 1 s');
    assert.strictEqual(u.dt, 1000);
    assert.strictEqual(u.add(3.6, 7000), 0, 'gap of 6 s');
    assert.strictEqual(u.dt, 0);
    assert.strictEqual(u.add(null, 8000), 0);
    assert.strictEqual(u.add(3.6, 9000), 0, 'after an unknown flow');
});

/* ---------------- lib_coach ---------------- */
const piece = (km, l, h, o) => Object.assign({ km, l, h }, o || {});
test('coach: pieces by speed; cold ones and standing ones apart; usual and warm', () => {
    const { Coach } = L('lib_coach');
    const c = new Coach({});
    // 2.4 km at 100 km/h: 9 l/100 km, in 12 slices of 0.2 km (joined into pieces of 0.6 km)
    for (let i = 0; i < 12; i++) c.slice(piece(0.2, 0.018, 0.2 / 100, { amb: 12, mode: 'comfort', climate: false }));
    near(c.cons(c.bins.speed[4]), 9, 1e-9, '90-110');
    // cold: into bins.cold only
    c.slice(piece(0.6, 0.09, 0.6 / 40, { cold: true }));
    near(c.bins.cold.l, 0.09, 1e-12, 'cold bin');
    assert.strictEqual(c.bins.speed[1].km, 0, 'not in 30-50');
    // standing 6 min with 0.09 l: idling 0.9 l/h
    c.slice(piece(0, 0.09, 0.1));
    near(c.idle(), 0.9, 1e-9, 'idle l/h');
    near(c.usual(95), 9, 1e-9);
    near(c.usual(40), 9, 1e-9, 'nearest band with enough');
    near(c.warm(piece(1, 0, 1 / 100)), 0.09, 1e-9, 'moving: the usual');
    near(c.warm(piece(0, 0, 0.5)), 0.45, 1e-9, 'standing: idling');
    near(c.warmAll([piece(0.5, 0, 0.005), piece(0.5, 0, 0.005), piece(0, 0, 0.05)]), 0.09 + 0.045, 1e-9, 'slices joined');
    const r = c.compare([piece(0.5, 0.05, 0.005), piece(0.5, 0.05, 0.005, { cold: true })]);
    near(r.own, 0.05, 1e-12, 'cold piece left out');
});
test('coach: a condition against the usual at the same speeds', () => {
    const { Coach } = L('lib_coach');
    const c = new Coach({});
    for (let i = 0; i < 40; i++) c.slice(piece(0.5, 0.045, 0.5 / 100, { amb: 15, climate: false }));    // 9 l/100 km
    for (let i = 0; i < 20; i++) c.slice(piece(0.5, 0.0495, 0.5 / 100, { amb: -3, climate: true }));   // 10 % more
    // against the usual as it was then: it takes in the cold pieces too (9 l/100 km rising to 9.3), so a bit under 10 %
    const cold = c.vs(c.bins.temp[0]);
    assert.ok(cold > 0.07 && cold < 0.1, 'below 0 °C: ' + cold);
    near(c.vs(c.bins.climate.on), cold, 1e-9, 'climate on: the same pieces');
    assert.ok(Math.abs(c.vs(c.bins.temp[2])) < 0.01, '10-20 °C as usual');
    assert.strictEqual(c.vs(c.bins.temp[4]), null, 'nothing over 30 °C');
});

/* ---------------- lib_trip ---------------- */
test('trip: starts moving, ends after 5 min standing, distance from the speed', () => {
    const { TripClock } = L('lib_trip');
    const st = {}, closed = [];
    const tc = new TripClock(st, { onClose: (s) => closed.push(s) });
    let t = 0;
    for (let i = 0; i <= 600; i++) { tc.speed(t, 60); t += 1000; }     // 10 min at 60 km/h: 10 km
    for (let i = 0; i < 400; i++) { tc.speed(t, 0); t += 1000; tc.check(t); }
    assert.strictEqual(closed.length, 1);
    near(closed[0].km, 10, 0.02, 'km');
    assert.strictEqual(closed[0].reason, 'parked');
});

/* ---------------- lib_signals ---------------- */
test('signals: modes as iDrive 7 names them, vehicle states, oil level', () => {
    const { modeOf, conditionOf, oilLevelOf, MODE_LABEL } = L('lib_signals');
    assert.strictEqual(modeOf('ECO_PRO_EFFICIENT'), 'eco');
    assert.strictEqual(modeOf(4), 'comfort');
    assert.strictEqual(modeOf('SPORT_INDIVIDUAL'), 'sport');
    assert.strictEqual(modeOf(10), 'adaptive');
    assert.strictEqual(MODE_LABEL.eco, 'Eco Pro');
    assert.strictEqual(conditionOf('FAHREN'), 10);
    assert.strictEqual(oilLevelOf('MOTOROELSTAND_3_4'), 4);
    assert.strictEqual(oilLevelOf(9), null);
});

/* ---------------- lib_uds + lib_dme against a fake engine unit ---------------- */
/** A fake TASU link: answers 0x22 (key 'ecu:DID') and OBD 01 (key 'ecu:OBD:PID') like the car does, else 7F 31. */
function fakeSignals(table) {
    let onResp = null;
    const frame = (ecu, uds) => ({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)), errorCode: 'NO_ERROR' });
    return {
        proxy: async () => ({}),
        on: async (p, name, fn) => { onResp = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, method, a) => {
            const obd = a.serviceID === 0x01, hex = (x) => x.toString(16).toUpperCase().padStart(2, '0');
            const key = a.targetAddress + ':' + (obd ? 'OBD:' + hex(a.udsData[0]) : hex(a.udsData[0]) + hex(a.udsData[1]));
            const body = table[key];
            const uds = !body ? [0x7F, a.serviceID, 0x31] : obd ? [0x41, a.udsData[0]].concat(body) : [0x62, a.udsData[0], a.udsData[1]].concat(body);
            setTimeout(() => onResp(frame(a.targetAddress, uds)), 3);
            return { TasuErrorEnum: 'NO_ERROR' };
        },
        watch: async () => ({ error: 'test' }),
    };
}
const be = (v, nb) => { const out = []; let x = v < 0 ? v + Math.pow(2, 8 * nb) : v; for (let i = 0; i < nb; i++) { out.unshift(x & 0xFF); x = Math.floor(x / 256); } return out; };
const quiet = { info() {}, warn() {}, error() {} };

test('dme: values by UDS, the OBD fallback, plausibility, groups', async () => {
    const { UdsReader } = L('lib_uds');
    const { DME, dmeConfig, refuellings } = L('lib_dme');
    const kqe = be(3, 2).concat(be(5, 2), be(40, 2), be(5000, 2), [3], be(5060, 2), [2], be(0, 2), [0], be(0, 2), [0], be(0, 2), [0]);
    const dme = new UdsReader(fakeSignals({
        '18:4402': be(196, 2),                  // oil 99 °C
        '18:5656': be(466, 2),                  // 2.0 l/h
        '18:OBD:05': [130],                     // coolant 90 °C (4300 does not answer)
        '18:5811': [255],                       // oil level: none (implausible), 442F answers
        '18:442F': [87],                        // 0.87 l above the minimum
        '18:5776': [110],                       // RON 98 - 3.0 = 95.0
        '18:4035': kqe,
    }), quiet, dmeConfig(), DME);
    await dme.init();
    assert.ok(dme.available);
    near(await dme.value('oilTemp'), 99, 1e-9, 'oil');
    near(await dme.value('fuelFlow'), 466 * 0.00429152, 1e-9, 'fuel flow');
    near(await dme.value('coolant'), 90, 1e-9, 'coolant by OBD');
    assert.strictEqual(dme.pick.coolant, 1, 'OBD remembered');
    near(await dme.value('oilLevel'), 0.87, 1e-9, 'oil level from the second candidate');
    near(await dme.value('fuelQuality'), 95.0, 0.01, 'octane');
    assert.strictEqual(await dme.value('boostAct'), null, 'nothing answers');
    const fills = refuellings(await dme.group('kqe'));
    assert.deepStrictEqual(fills, [{ km: 40000, q: 3 }, { km: 40480, q: 2 }]);
});

/* ---------------- Motor-Check (health.js) ---------------- */
function snapsOf(n, f) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(Object.assign({ t: Date.now() - (n - i) * 2 * DAY, kind: 'idle', odo: 40000 + i * 100, oilLevel: 1.0, ltft: 1.5,
        misfire1: 0, misfire2: 0, misfire3: 0, misfire4: 0, misfire5: 0, misfire6: 0, inj1: 1, inj2: 1, inj3: 1, inj4: 1, inj5: 1, inj6: 1,
        oilPress: 2.6, ambientP: 1.0, oilTemp: 95, plugsLeft: 30000, knockAdapt: -0.5 }, f ? f(i) : {}));
    return out;
}
test('health: a healthy engine is fine; misfires counted with a reset counter', () => {
    const { evaluate, misfireDeltas } = L('health');
    const r = evaluate(snapsOf(12), []);
    assert.strictEqual(r.cards.find((c) => c.id === 'cyl').state, 'ok');
    assert.strictEqual(r.cards.find((c) => c.id === 'oil').state, 'ok');
    const d = misfireDeltas([{ misfire1: 5 }, { misfire1: 9 }, { misfire1: 2 }], 1);
    assert.deepStrictEqual(d.map((x) => x.row[0]), [4, 2]);
});
test('health: cylinder 4 misfiring again and again: have it checked', () => {
    const { evaluate } = L('health');
    const r = evaluate(snapsOf(12, (i) => ({ misfire4: i * 3 })), []);
    const cyl = r.cards.find((c) => c.id === 'cyl');
    assert.strictEqual(cyl.state, 'check');
    assert.ok(/Zylinder 4/.test(cyl.note), cyl.note);
});
test('health: oil use from the level over the km, and a drop of the oil pressure', () => {
    const { evaluate } = L('health');
    // 0.7 l over 1100 km since the last top-up: 0.64 l/1000 km
    const r = evaluate(snapsOf(12, (i) => ({ oilLevel: 1.5 - i * 0.07 })), [], { oilWarn: 0.5 });
    near(r.oil.per1000, 0.7, 0.01, 'l/1000 km');
    assert.strictEqual(r.cards.find((c) => c.id === 'oil').state, 'watch');
    const p = evaluate(snapsOf(8, (i) => (i === 7 ? { oilPress: 1.9 } : {})), []);           // 0.9 bar against 1.6: -44 %
    assert.strictEqual(p.cards.find((c) => c.id === 'oil').state, 'check');
});

/* ---------------- Sprit-Check (tank.js) ---------------- */
test('fuel: a filling is a rise of 5 l or more that stays 20 s; sloshing is not', () => {
    const { Tanks } = L('tank');
    const st = {}, tk = new Tanks(st, {});
    tk.fill(0, 50, 45, 39500);                                    // a tank going on
    assert.strictEqual(tk.level(1000, 20, 40000, true), null);
    assert.strictEqual(tk.level(2000, 22, 40000, true), null, 'small rise: sloshing');
    assert.strictEqual(st.lastLevel, 20, 'the lower level kept');
    assert.strictEqual(tk.level(3000, 58, 40000, true), null, 'seen once');
    assert.strictEqual(tk.level(10000, 58, 40000, true), null, 'not 20 s yet');
    const c = tk.level(25000, 58, 40000, true);
    assert.ok(c && Math.abs(c.litres - 38) < 1e-9, JSON.stringify(c));
    assert.strictEqual(tk.level(60000, 58, 40000, true), null, 'asked once');
});
test('fuel: per type, km-weighted consumption and cost; the verdict against the cheapest', () => {
    const { Tanks, summary, compare, verdict } = L('tank');
    const C = L('lib_core');
    const prices = { e10: 1.75, plus: 1.9 };
    const st = {}, tk = new Tanks(st, { price: (type) => prices[type] });
    let odo = 40000, t = 0;
    [['e10', 9.8, 1.4], ['plus', 9.3, 0.6], ['e10', 9.8, 1.4], ['plus', 9.3, 0.6]].forEach((x) => {
        st.lastType = x[0];
        tk.fill(t, 58, 45, odo);
        for (let i = 0; i < 20; i++) tk.load(x[2]);
        tk.fuel(500 * x[1] / 100, 500);
        odo += 500; t += 7 * DAY;
        st.cur.odo1 = odo;
    });
    tk.fill(t, 58, 45, odo);
    assert.strictEqual(st.tanks.length, 4);
    near(st.tanks[0].cons, 9.8, 1e-9);
    assert.strictEqual(st.tanks[0].by, 'flow');
    near(summary(st.cur).km, 0, 1e-9, 'the new tank');
    const rows = compare(st.tanks), e10 = rows.find((r) => r.type === 'e10'), plus = rows.find((r) => r.type === 'plus');
    near(e10.eur100, 9.8 * 1.75, 1e-9, 'e10 € per 100 km');
    near(plus.retard, 0.6, 1e-9, 'plus knock retard');
    const v = verdict(rows, C.fmt);
    assert.strictEqual(v.length, 1);
    assert.ok(/Super Plus gegen Super E10: 0,50 l\/100 km weniger, 0,8° weniger Zündrücknahme, 0,52 € je 100 km teurer/.test(v[0]), v[0]);
});

/* ---------------- Pull-Check (pull.js) ---------------- */
function pullOf(o, seed) {
    const { demoPull } = L('lib_demo');
    const CH = ['boostAct', 'boostTarget', 'knockRetard', 'railAct', 'boostAct', 'boostTarget', 'iat', 'lambda', 'railTarget', 'knockRetard', 'lambdaTarget'];
    const fast = [], dme = [];
    demoPull(seed || 5, o).forEach((x, k) => {
        fast.push({ t: x.t, rpm: x.rpm, speed: x.speed, aLong: x.aLong, pedal: 100 });
        const nm = CH[k % CH.length];
        dme.push({ t: x.t, n: nm, v: x[nm], rpm: x.rpm });
    });
    return { fast, dme };
}
test('pull: a healthy pull in 3rd gear: every check fine, power plausible', () => {
    const { analyze, gearOf } = L('pull');
    const a = analyze(pullOf(), { ambient: 12 });
    assert.strictEqual(a.gear, 3);
    assert.deepStrictEqual(a.checks.map((c) => c.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.ok(a.peak.kw > 170 && a.peak.kw < 260, 'wheel kW ' + a.peak.kw);
    assert.strictEqual(gearOf(1600, 100), 8);
    assert.strictEqual(gearOf(500, 50), null, 'idle');
});
test('pull: boost short of its target and heavy knock retard are found; power against the reference', () => {
    const { analyze, versus } = L('pull');
    const ref = analyze(pullOf(), { ambient: 12 });
    const weak = analyze(pullOf({ boostLoss: 0.35, retard: 3.5 }), { ambient: 12 });
    assert.strictEqual(weak.checks.find((c) => c.id === 'boost').state, 'check');
    assert.strictEqual(weak.checks.find((c) => c.id === 'knock').state, 'check');
    assert.strictEqual(weak.state, 'check');
    assert.ok(versus(weak, ref) < -0.05, 'weaker: ' + versus(weak, ref));
    near(versus(ref, ref), 0, 1e-9, 'itself');
});

/* ---------------- Verbrauchs-Coach (drive.js) ---------------- */
/** Drives with the demo car: [ambient, seconds, coolant at the start]; slices every 10 s, as the app cuts them. */
function drives(list, st) {
    const { Recorder } = L('drive');
    const { DemoDrive } = L('lib_demo');
    const r = new Recorder(st || {}, { ambient: () => 10 });
    let tt = new Date(2026, 9, 1, 8, 0).getTime();
    list.forEach((x, k) => {
        const d = new DemoDrive(3 + k, { ambient: x[0], coolant: x[2], oil: x[2] });
        let l = 0, last = tt;
        for (let i = 0; i < x[1]; i++) {
            const s = d.step(1);
            r.speed(tt, s.speed);
            l += s.lph / 3600;
            if (tt - last >= 10000) { r.fuel(tt, l, tt - last, { amb: x[0], mode: s.mode, climate: s.climate, coolant: s.coolant }); l = 0; last = tt; }
            tt += 1000;
        }
        for (let i = 0; i < 400; i++) { r.speed(tt, 0); tt += 1000; }
        r.check(tt);
        tt += DAY;
    });
    return r;
}
test('coach: cold and warm starts, the time to get warm, the extra fuel once warm is learned', () => {
    const r = drives([[10, 1800, 88], [10, 1800, 12], [10, 1800, 12]]);
    const t = r.st.trips;
    assert.strictEqual(t.length, 3);
    assert.strictEqual(t[0].coldStart, false);
    assert.strictEqual(t[1].coldStart, true);
    assert.ok(t[1].warmMin > 3 && t[1].warmMin < 15, 'warm after ' + t[1].warmMin + ' min');
    assert.ok(t[2].extra > 0.05 && t[2].extra < 0.6, 'extra ' + t[2].extra + ' l');
    assert.ok(Math.abs(t[0].vs) < 0.1, 'a warm drive like the usual: ' + t[0].vs);
    near(t[0].cons, t[0].l / t[0].lKm * 100, 0.01, 'l/100 km');
    assert.ok(r.coach.bins.cold.km > 2 && r.coach.bins.cold.km < t[1].km, 'cold km apart');
});
test('coach: months and cold start statistics; a short drive never gets warm', () => {
    const { months, coldStats } = L('drive');
    const st = {};
    drives([[8, 1800, 88], [8, 1800, 10], [8, 300, 10], [8, 1800, 10]], st);
    const m = months(st, 2, new Date(2026, 9, 20).getTime());
    assert.deepStrictEqual(m.map((x) => x.label), ['Sep', 'Okt']);
    assert.strictEqual(m[1].trips, 4);
    assert.strictEqual(m[1].coldStarts, 3);
    assert.strictEqual(m[1].never, 1);
    const s = coldStats(st.trips);
    assert.strictEqual(s.starts, 3);
    assert.strictEqual(s.never, 1);
    assert.ok(s.share > 0.1 && s.share < 0.8, 'cold against warm ' + s.share);
});
test('coach: a slice whose fuel is known for less than 80 % of it counts for the distance only', () => {
    const { Recorder } = L('drive');
    const r = new Recorder({}, {});
    let t = 0;
    for (let i = 0; i <= 60; i++) { r.speed(t, 72); if (i % 10 === 0) r.fuel(t, 0.02, i === 30 ? 5000 : 10000, { coolant: 90 }); t += 1000; }
    const o = r.open;
    near(o.km, 1.2, 0.01, 'km');
    near(o.lKm, 1.0, 0.01, 'km with the fuel known');
    near(o.l, 0.1, 1e-9, 'litres');
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
