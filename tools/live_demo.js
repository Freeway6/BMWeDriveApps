#!/usr/bin/env node
'use strict';
/**
 * live_demo.js - a DC charge as the head unit would send it, without the car: to try the relay and the iPhone and
 * Watch apps. It pairs like the head unit (the same QR code, here in the terminal), then sends a simulated charge
 * (lib/ev_demo.js) through lib/ev_live.js, exactly the head unit's code.
 *
 *   node tools/live_demo.js https://i4-live.<name>.workers.dev      a charge from 12 % in real time (about 45 min)
 *   node tools/live_demo.js <relay> --fast 10                        ten times as fast
 *   node tools/live_demo.js <relay> --sleep-at 50 --sleep-for 8      no sending from 50 % for 8 minutes of the charge:
 *                                                                    the head unit asleep, the iPhone on its forecast
 *   node tools/live_demo.js <relay> --new                            a new pairing (scan again)
 *   node tools/live_demo.js http://127.0.0.1:8787                    the local relay (relay/test/local.mjs)
 *
 * The pairing is kept in dist/live-demo/live.json (one demo car); the real one lives on the head unit only.
 */
const fs = require('fs');
const path = require('path');
const { LiveLink } = require('../lib/ev_live');
const D = require('../lib/ev_livedoc');
const M = require('../lib/ev_model');
const { ChargeTracker } = require('../lib/ev_charge');
const { DemoCharge, demoSessions } = require('../lib/ev_demo');
const QR = require('../kit/runtime/qr');

function args() {
    const a = process.argv.slice(2), o = { relay: null, fast: 1, sleepAt: null, sleepFor: 8, fresh: false, soc0: 12, cellT: 18, charger: 200 };
    for (let i = 0; i < a.length; i++) {
        const k = a[i], v = a[i + 1];
        if (k === '--fast') { o.fast = Math.max(1, Number(v)); i++; } else if (k === '--sleep-at') { o.sleepAt = Number(v); i++; } else if (k === '--sleep-for') { o.sleepFor = Number(v); i++; } else if (k === '--new') o.fresh = true;
        else if (k === '--soc') { o.soc0 = Number(v); i++; } else if (k === '--cell') { o.cellT = Number(v); i++; } else if (k === '--charger') { o.charger = Number(v); i++; } else if (!o.relay && /^https?:\/\//.test(k)) o.relay = k;
        else { console.error('unknown: ' + k); process.exit(2); }
    }
    if (!o.relay) { console.error('usage: node tools/live_demo.js <relay URL> [--fast N] [--sleep-at %] [--sleep-for min] [--new] [--soc %] [--cell °C] [--charger kW]'); process.exit(2); }
    return o;
}

/** The QR code in the terminal: two modules a character, black on white. */
function terminalQr(text) {
    const c = QR.encode(Buffer.from(text, 'utf8'), { ecl: 'M' }), n = c.size, q = 2;
    const dark = (x, y) => x >= 0 && y >= 0 && x < n && y < n && c.get(x, y);
    const lines = [];
    for (let y = -q; y < n + q; y += 2) {
        let l = '';
        for (let x = -q; x < n + q; x++) {
            const a = dark(x, y), b = dark(x, y + 1);
            l += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
        }
        lines.push('\x1b[30;47m' + l + '\x1b[0m');
    }
    return lines.join('\n');
}

async function main() {
    const o = args();
    const dir = path.join(__dirname, '..', 'dist', 'live-demo');
    fs.mkdirSync(dir, { recursive: true });
    if (o.fresh) try { fs.unlinkSync(path.join(dir, 'live.json')); } catch (e) { /* none */ }
    const log = { info: (m) => console.log('  ' + m), warn: (m) => console.log('  ! ' + m) };
    const link = new LiveLink({ dataDir: dir, log, relay: o.relay, enabled: () => true, systemDns: true, leaseFiles: [] });
    const url = link.pairUrl();
    console.log('\nPairing (scan with the iPhone camera, open in "i4 Laden"):\n\n' + terminalQr(url) + '\n\n' + url + '\n');

    // earlier charges, for the reference and what the car has learned
    const st = { sessions: demoSessions(6), open: null, grid: {}, pinned: null };
    st.sessions.filter((s) => s.kind === 'DC').forEach((s) => s.points.forEach((p) => M.learn(st.grid, p[1], p[3], p[2])));
    const charge = new DemoCharge({ soc0: o.soc0, cellT: o.cellT, charger: o.charger });
    const tr = new ChargeTracker(st, { onStart: () => console.log('  charge started'), onClose: (s) => console.log('  charge ended: ' + s.soc0.toFixed(0) + ' -> ' + s.soc1.toFixed(0) + ' %, ' + s.kwh.toFixed(1) + ' kWh') });
    const t0 = Date.now(), every = Math.max(2000, 15000 / o.fast), lastPt = charge.pts[charge.pts.length - 1];
    let lastState = 0, curveKey = '', asleep = false, ended = 0, wasOpen = null;
    const opts = (t) => ({ t, seq: t, target: 80, battery: '83.9', price: { DC: 0.59, AC: 0.3 }, loss: { DC: 1.05, AC: 1.1 } });

    const tick = () => {
        const real = Date.now(), min = (real - t0) / 60000 * o.fast, simT = t0 + min * 60000;
        const done = min * 60 > lastPt.s + 30;
        const p = done ? { soc: lastPt.soc, kw: 0, cellT: lastPt.cellT } : charge.at(min);
        tr.sample({ t: simT, kwIn: p.kw, soc: p.soc, cellT: p.cellT, cellTmax: p.cellT + 2, speed: 0, stored: p.soc * 0.807 });
        const v = { st, open: st.open, now: { kwIn: p.kw, soc: p.soc, temp: { min: p.cellT, max: p.cellT + 2 }, energy: { stored: p.soc * 0.807, cap: 80.7 } }, cellT: p.cellT, link: true };
        const sleeping = o.sleepAt !== null && p.soc >= o.sleepAt && st.open && min - (o.sleptAt || (o.sleptAt = min)) < o.sleepFor;
        if (sleeping !== asleep) { asleep = sleeping; console.log(asleep ? '  head unit asleep (simulated): nothing sent, the iPhone goes by the forecast' : '  head unit awake again'); }
        // the state every few seconds, and at once when the charge starts or ends
        const changed = wasOpen !== !!st.open;
        wasOpen = !!st.open;
        if (!asleep && (real - lastState >= every || changed)) {
            const doc = D.stateDoc(v, opts(real));
            // the forecast in real minutes when the charge runs faster than real time
            if (doc.fc && o.fast !== 1) doc.fc = doc.fc.map((x) => [Math.round(x[0] / o.fast * 100) / 100, x[1], x[2]]);
            link.put('state', doc);
            lastState = real;
            process.stdout.write('  ' + new Date(real).toTimeString().slice(0, 8) + '  ' + p.soc.toFixed(1) + ' %  ' + p.kw.toFixed(0) + ' kW  ' + p.cellT.toFixed(1) + ' °C   sent ' + link.status().sent + (link.status().lastError ? '   ' + link.status().lastError : '') + '\n');
            const s = st.open || st.sessions[st.sessions.length - 1];
            const key = s.id + ':' + s.points.length + ':' + !!st.open;
            if (key !== curveKey) { link.put('curve', D.curveDoc(v, opts(real))); curveKey = key; }
        }
        if (!st.open && tr.st.sessions.length && done) ended = ended || real;
        if (ended && real - ended > 5000) { console.log('  done'); link.stop(); process.exit(0); }
    };
    tick();
    setInterval(tick, Math.max(250, 1000 / Math.min(o.fast, 4)));
}

main().catch((e) => { console.error(e); process.exit(1); });
