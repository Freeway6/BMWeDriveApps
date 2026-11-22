/**
 * The relay on a computer, without Cloudflare: Node's http server in front of channel.js's handle(), each channel's
 * storage a Map in memory (gone when it stops). For the tests and to try the head unit's code and the apps on a
 * local network:
 *
 *   node relay/test/local.mjs [port]          (default 8787; the head unit's lib/ev_live.js takes http:// too)
 */
import http from 'node:http';
import { handle } from '../src/channel.js';

/** Storage like a Durable Object's: values kept as copies, an alarm time remembered. */
export function memoryStorage() {
    const m = new Map();
    const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    return {
        map: m,
        alarm: null,
        async get(k) { return copy(m.get(k)); },
        async put(k, v) { m.set(k, copy(v)); },
        async delete(k) { return m.delete(k); },
        async deleteAll() { m.clear(); this.alarm = null; },
        async setAlarm(t) { this.alarm = t; },
    };
}

export function startLocal(port, opts) {
    const o = opts || {};
    const channels = new Map();
    const clock = o.clock || (() => Date.now());
    const server = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = Buffer.concat(chunks);
            const url = 'http://' + (req.headers.host || 'localhost') + req.url;
            const r = new Request(url, { method: req.method, headers: req.headers, body: ['PUT', 'POST'].includes(req.method) ? body : undefined });
            let out;
            const path = new URL(url).pathname;
            if (path === '/v1/health') out = new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
            else {
                const m = /^\/v1\/c\/([0-9a-f]{32})/.exec(path);
                if (!m) out = new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
                else {
                    if (!channels.has(m[1])) channels.set(m[1], memoryStorage());
                    out = await handle(r, channels.get(m[1]), clock());
                }
            }
            res.writeHead(out.status, Object.fromEntries(out.headers));
            res.end(await out.text());
        } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(e && e.stack || e));
        }
    });
    return new Promise((resolve) => server.listen(port || 0, o.host || '127.0.0.1', () => resolve({ server, channels, port: server.address().port })));
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const port = Number(process.argv[2]) || 8787;
    startLocal(port, { host: '0.0.0.0' }).then((s) => console.log('i4 Live relay (local, in memory) on port ' + s.port));
}
