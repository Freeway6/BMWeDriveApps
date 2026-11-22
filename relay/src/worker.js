/**
 * i4 Live relay: the Worker. Routes each channel to its own Durable Object; what a channel does is in channel.js
 * (the protocol is described there). Only the default export and the Durable Object class are exported here: the
 * Workers runtime takes every export of this module for an entry point.
 */
import { CHANNEL, PATH, handle, json } from './channel.js';

/** A channel: its Durable Object. */
export class Channel {
    constructor(state) { this.storage = state.storage; }
    fetch(req) { return handle(req, this.storage, Date.now()); }
    async alarm() { await this.storage.deleteAll(); }
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/health') return json({ ok: true });
        if (url.pathname === '/') return new Response('i4 Live relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        const m = PATH.exec(url.pathname);
        if (!m || !CHANNEL.test(m[1])) return json({ error: 'not found' }, 404);
        return env.CHANNEL.get(env.CHANNEL.idFromName(m[1])).fetch(req);
    },
};
