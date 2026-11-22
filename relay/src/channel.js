/**
 * channel.js - one channel of the i4 Live relay (worker.js routes each channel to its own Durable Object).
 *
 * The relay is a mailbox between the car and the phone. The head unit (Charge Curve app) puts the charge's state
 * and its curve in; the iPhone and the Apple Watch take them out. Everything in it is encrypted on the head unit
 * with a key only the car and the paired phone know (AES-256-GCM): the relay stores ciphertext, its size and when it
 * came, nothing else.
 *
 *   PUT    /v1/c/<channel>/<slot>    slot: state | curve; Authorization: Bearer <write token>; body { seq, blob }.
 *                                    The first write makes the channel; X-I4-Read then gives the SHA-256 (hex) of
 *                                    the read token. Later writes must bring the same write token.
 *   GET    /v1/c/<channel>?have=<n>  Authorization: Bearer <read token>
 *                                    -> { now, state: { seq, rt, blob } | null, curve: { seq, rt, blob } | null }
 *                                    (curve without its blob when its seq is the one the reader already has)
 *   DELETE /v1/c/<channel>           Authorization: Bearer <write token>: the channel is forgotten (a new pairing)
 *   GET    /v1/health                -> { ok: true }
 *
 * channel: 32 hex digits; tokens: 64 hex digits (HMAC-SHA256 of the pairing key, made on both ends). rt: when the
 * relay received the item (ms since 1970, the relay's clock), now: the relay's clock at the answer: a reader works
 * out an item's age from these two alone, whatever its own clock and the car's say.
 *
 * One Durable Object per channel keeps it (SQLite-backed, so it runs on the Workers Free plan). A channel nobody
 * wrote to for 30 days deletes itself.
 */

export const CHANNEL = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
export const PATH = /^\/v1\/c\/([0-9a-f]{32})(?:\/(state|curve))?$/;
export const MAX_BODY = 96 * 1024;
export const MIN_WRITE_MS = 400;          // per slot: the head unit sends every 10-30 s
export const KEEP_MS = 30 * 86400000;

export const json = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function sha256hex(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The same strings, compared in a time that does not depend on where they differ. */
function same(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let x = 0;
    for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return x === 0;
}

function bearer(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
    return m ? m[1] : null;
}

async function body(req) {
    const len = Number(req.headers.get('content-length'));
    if (len > MAX_BODY) return null;
    const text = await req.text();
    if (text.length > MAX_BODY) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * One request to one channel: storage is the channel's own (get, put, deleteAll, setAlarm), now the relay's clock.
 * Exported for the tests, which run it on a Map.
 */
export async function handle(req, storage, now) {
    const url = new URL(req.url);
    const m = PATH.exec(url.pathname);
    if (!m) return json({ error: 'not found' }, 404);
    const slot = m[2] || null;
    const token = bearer(req);
    if (!token) return json({ error: 'no token' }, 401);
    const hash = await sha256hex(token);
    let meta = await storage.get('meta');

    if (req.method === 'PUT' && slot) {
        if (!meta) {
            const read = (req.headers.get('x-i4-read') || '').toLowerCase();
            if (!TOKEN.test(read)) return json({ error: 'a new channel needs X-I4-Read' }, 400);
            meta = { w: hash, r: read, created: now };
            await storage.put('meta', meta);
        } else if (!same(meta.w, hash)) return json({ error: 'forbidden' }, 403);
        const b = await body(req);
        if (!b || typeof b.blob !== 'string' || !b.blob.length || typeof b.seq !== 'number' || !isFinite(b.seq)) return json({ error: 'bad body' }, 400);
        const prev = await storage.get(slot);
        if (prev && now - prev.rt < MIN_WRITE_MS) return json({ error: 'too often' }, 429);
        await storage.put(slot, { seq: b.seq, rt: now, blob: b.blob });
        await storage.setAlarm(now + KEEP_MS);
        return json({ ok: true, rt: now });
    }
    if (req.method === 'GET' && !slot) {
        if (!meta) return json({ error: 'no such channel' }, 404);
        if (!same(meta.r, hash)) return json({ error: 'forbidden' }, 403);
        const state = (await storage.get('state')) || null;
        let curve = (await storage.get('curve')) || null;
        const have = url.searchParams.get('have');
        if (curve && have !== null && Number(have) === curve.seq) curve = { seq: curve.seq, rt: curve.rt };
        return json({ now, state, curve });
    }
    if (req.method === 'DELETE' && !slot) {
        if (!meta) return json({ ok: true });
        if (!same(meta.w, hash)) return json({ error: 'forbidden' }, 403);
        await storage.deleteAll();
        return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
}

