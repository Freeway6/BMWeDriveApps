/**
 * Tests of the relay (relay/src/worker.js) without Cloudflare: node relay/test/run.mjs
 */
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import worker from '../src/worker.js';
import { handle, MIN_WRITE_MS, KEEP_MS, MAX_BODY } from '../src/channel.js';
import { memoryStorage, startLocal } from './local.mjs';

const hex = (n) => randomBytes(n).toString('hex');
const sha = (t) => createHash('sha256').update(t).digest('hex');
const CH = hex(16), W = hex(32), R = hex(32);
const base = 'https://relay.test/v1/c/' + CH;
const put = (slot, body, token, read) => new Request(base + '/' + slot, {
    method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: Object.assign({ authorization: 'Bearer ' + token, 'content-type': 'application/json' }, read ? { 'x-i4-read': read } : {}),
});
const get = (token, q) => new Request(base + (q || ''), { headers: { authorization: 'Bearer ' + token } });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a new channel needs a token and the read hash', async () => {
    const st = memoryStorage();
    assert.strictEqual((await handle(new Request(base + '/state', { method: 'PUT', body: '{}' }), st, 1000)).status, 401);
    assert.strictEqual((await handle(put('state', { seq: 1, blob: 'eA==' }, W), st, 1000)).status, 400);
    assert.strictEqual(st.map.size, 0, 'nothing kept');
});

test('write, read, wrong tokens, the curve only when new', async () => {
    const st = memoryStorage();
    let r = await handle(put('state', { seq: 1, blob: 'c3RhdGU=' }, W, sha(R)), st, 1000);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, rt: 1000 });
    assert.strictEqual(st.alarm, 1000 + KEEP_MS, 'kept 30 days');
    r = await handle(put('curve', { seq: 7, blob: 'Y3VydmU=' }, W), st, 1200);
    assert.strictEqual(r.status, 200, 'the second write needs no read hash');
    r = await handle(get(R), st, 5000);
    assert.deepStrictEqual(await r.json(), { now: 5000, state: { seq: 1, rt: 1000, blob: 'c3RhdGU=' }, curve: { seq: 7, rt: 1200, blob: 'Y3VydmU=' } });
    r = await handle(get(R, '?have=7'), st, 5000);
    assert.deepStrictEqual((await r.json()).curve, { seq: 7, rt: 1200 }, 'no blob: the reader has it');
    assert.strictEqual((await handle(get(W), st, 5000)).status, 403, 'the write token does not read');
    assert.strictEqual((await handle(put('state', { seq: 2, blob: 'eA==' }, R), st, 9000)).status, 403, 'the read token does not write');
    assert.strictEqual((await handle(put('state', { seq: 2, blob: 'eA==' }, hex(32), sha(R)), st, 9000)).status, 403, 'nor does another one');
});

test('too often, bad bodies, too big', async () => {
    const st = memoryStorage();
    assert.strictEqual((await handle(put('state', { seq: 1, blob: 'eA==' }, W, sha(R)), st, 1000)).status, 200);
    assert.strictEqual((await handle(put('state', { seq: 2, blob: 'eA==' }, W), st, 1000 + MIN_WRITE_MS - 1)).status, 429);
    assert.strictEqual((await handle(put('curve', { seq: 2, blob: 'eA==' }, W), st, 1000 + 10)).status, 200, 'per slot');
    assert.strictEqual((await handle(put('state', 'not json', W), st, 5000)).status, 400);
    assert.strictEqual((await handle(put('state', { seq: 'x', blob: 'eA==' }, W), st, 5000)).status, 400);
    assert.strictEqual((await handle(put('state', { seq: 3, blob: 'x'.repeat(MAX_BODY) }, W), st, 5000)).status, 400);
    assert.strictEqual((await handle(put('state', { seq: 3, blob: 'eA==' }, W), st, 5000)).status, 200);
});

test('unknown channel, delete with the write token only', async () => {
    const st = memoryStorage();
    assert.strictEqual((await handle(get(R), st, 1)).status, 404);
    await handle(put('state', { seq: 1, blob: 'eA==' }, W, sha(R)), st, 1000);
    const del = (t) => new Request(base, { method: 'DELETE', headers: { authorization: 'Bearer ' + t } });
    assert.strictEqual((await handle(del(R), st, 2000)).status, 403);
    assert.strictEqual((await handle(del(W), st, 2000)).status, 200);
    assert.strictEqual((await handle(get(R), st, 3000)).status, 404, 'gone');
    assert.strictEqual(st.alarm, null);
});

test('the worker routes: health, root, bad paths, one object per channel', async () => {
    assert.deepStrictEqual(await (await worker.fetch(new Request('https://relay.test/v1/health'), {})).json(), { ok: true });
    assert.strictEqual((await worker.fetch(new Request('https://relay.test/'), {})).status, 200);
    assert.strictEqual((await worker.fetch(new Request('https://relay.test/v1/c/xyz'), {})).status, 404);
    const names = [];
    const env = { CHANNEL: { idFromName: (n) => { names.push(n); return n; }, get: () => ({ fetch: async () => new Response('ok') }) } };
    assert.strictEqual(await (await worker.fetch(get(R), env)).text(), 'ok');
    assert.deepStrictEqual(names, [CH]);
});

test('over HTTP: the local server', async () => {
    const s = await startLocal(0);
    try {
        const u = 'http://127.0.0.1:' + s.port + '/v1/c/' + CH;
        let r = await fetch(u + '/state', { method: 'PUT', body: JSON.stringify({ seq: 5, blob: 'eA==' }), headers: { authorization: 'Bearer ' + W, 'x-i4-read': sha(R) } });
        assert.strictEqual(r.status, 200);
        r = await fetch(u, { headers: { authorization: 'Bearer ' + R } });
        const j = await r.json();
        assert.strictEqual(j.state.seq, 5);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    } finally { s.server.close(); }
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
console.log('\n' + (tests.length - failed) + ' / ' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
