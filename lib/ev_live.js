'use strict';
/**
 * ev_live.js - the charge, live on the iPhone and the Apple Watch: the head unit puts its state into a relay on
 * the internet (relay/, a Cloudflare Worker of the owner's), the iPhone app (ios/) takes it out.
 *
 *   - Internet: only through the MGU Store's uplink (mgu-uplink: an LTE stick, a tethered phone, Wi-Fi). The app
 *     says "internet": true in its app.json (tools/build.py makes that package.json's mguInternet); the uplink then
 *     routes this app's uid, and no other part of the head unit. The head unit's own resolver does not reach the
 *     internet: names are resolved through the DNS servers of the uplink's lease (uplink.json in the app's data
 *     folder, else /run/mgu-uplink/lease.json; there only while the uplink is online).
 *   - End to end encrypted: AES-256-GCM with a key made here (live.json in the data folder, never in the repository),
 *     shown once as a QR code for the iPhone. The relay keeps ciphertext; its tokens are derived from the key.
 *   - HTTPS: with Node 8's own root certificates (2019), else with ev_roots.js's, else (config.live.tls "fallback",
 *     the default) without checking the certificate: the content stays encrypted and signed end to end, so a forged
 *     relay could only drop it. config.live.tls "strict" never does that.
 *   - Never in the recorder's way: put() only queues the newest document per slot; a loop of its own sends them,
 *     backs off when that fails (5 s, doubling, at most 60 s) and drops nothing but older versions.
 *
 *   const link = new LiveLink({ dataDir, log, relay: 'https://i4-live.<you>.workers.dev', enabled: () => bool });
 *   link.put('state', doc); link.put('curve', doc);      (lib/ev_livedoc.js makes them)
 *   link.pairUrl()   i4laden://pair?v=1&r=<relay>&c=<channel>&k=<key>  (the QR code)
 *   link.status()    what the app's iPhone page shows
 *   link.rekey()     a new key and channel (the old channel is deleted on the relay)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const ROOTS = require('./ev_roots');

const SLOTS = ['state', 'curve'];
const DNS_TTL = 5 * 60000;
const TIMEOUT = 15000;
// (Cloudflare turns some library user agents away, e.g. Python's: say what this is)
const USER_AGENT = 'i4ev_charge/0.3.0 (MGU)';
const CERT_ERRORS = ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED', 'CERT_CHAIN_TOO_LONG', 'CERT_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64url(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Buffer.from(t, 'base64');
}
const hmac = (key, label) => crypto.createHmac('sha256', key).update(label).digest();
const sha256hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** A pairing: the channel on the relay and the key, and what both ends derive from the key. */
class Pairing {
    constructor(channel, key, created) {
        if (!/^[0-9a-f]{32}$/.test(channel) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('bad pairing');
        this.channel = channel;
        this.key = key;
        this.created = created || Date.now();
        this.encKey = hmac(key, 'i4live enc v1');
        this.readToken = hmac(key, 'i4live read v1').toString('hex');
        this.writeToken = hmac(key, 'i4live write v1').toString('hex');
        this.readHash = sha256hex(this.readToken);
    }
    static make() { return new Pairing(crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32)); }
    static fromJson(j) { return new Pairing(j.channel, fromB64url(j.key), j.created); }
    /** From the pairing link (as the phone reads it): { pairing, relay }. */
    static fromUrl(u) {
        const x = new URL(u);
        if (x.protocol !== 'i4laden:') throw new Error('not a pairing link');
        const q = x.searchParams;
        return { pairing: new Pairing(q.get('c'), fromB64url(q.get('k'))), relay: q.get('r') };
    }
    toJson() { return { v: 1, channel: this.channel, key: b64url(this.key), created: this.created }; }
    url(relay) { return 'i4laden://pair?v=1&r=' + encodeURIComponent(relay) + '&c=' + this.channel + '&k=' + b64url(this.key); }
    aad(slot) { return Buffer.from('i4live|' + this.channel + '|' + slot + '|v1', 'utf8'); }
    /** A document sealed for a slot: base64 of nonce (12 bytes) | ciphertext | tag (16 bytes), as CryptoKit's
     * AES.GCM.SealedBox(combined:) reads it; the channel and slot are authenticated with it. */
    seal(slot, doc) {
        const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
        c.setAAD(this.aad(slot));
        const ct = Buffer.concat([c.update(JSON.stringify(doc), 'utf8'), c.final()]);
        return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
    }
    open(slot, blob) {
        const b = Buffer.from(blob, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', this.encKey, b.slice(0, 12));
        d.setAAD(this.aad(slot));
        d.setAuthTag(b.slice(b.length - 16));
        return JSON.parse(Buffer.concat([d.update(b.slice(12, b.length - 16)), d.final()]).toString('utf8'));
    }
}

/** A DNS server as a lease names it: an IP address (IPv4 also with :port). */
const dnsServer = (d) => typeof d === 'string' && (net.isIP(d) > 0 || /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(d));

/** The uplink's lease: { ip, dns: [...] } while it is online, else null. */
function readLease(files) {
    for (const f of files) {
        try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j && j.ip && Array.isArray(j.dns) && j.dns.some(dnsServer)) return j;
        } catch (e) { /* not there: not online through it */ }
    }
    return null;
}

/** An error with a German text for the app's page. */
function failure(de, code) { const e = new Error(de); e.de = de; e.code = code || 'LIVE'; return e; }

/** One request: u (URL), o { ip, method, headers, body, tls: 'system' | 'roots' | 'insecure', agent, timeout }. */
function request(u, o) {
    return new Promise((resolve, reject) => {
        const secure = u.protocol === 'https:';
        const opts = {
            host: o.ip, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method: o.method,
            headers: Object.assign({ Host: u.host, 'User-Agent': USER_AGENT }, o.headers || {}), agent: o.agent, timeout: o.timeout || TIMEOUT,
        };
        if (o.body) opts.headers['Content-Length'] = Buffer.byteLength(o.body);
        if (secure) {
            if (!net.isIP(u.hostname)) opts.servername = u.hostname;
            if (o.tls === 'roots') opts.ca = ROOTS;
            if (o.tls === 'insecure') opts.rejectUnauthorized = false;
        }
        const req = (secure ? https : http).request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => { req.abort(); reject(failure('Relay antwortet nicht (Zeitüberschreitung)', 'ETIMEDOUT')); });
        req.on('error', reject);
        if (o.body) req.write(o.body);
        req.end();
    });
}

const nextTls = (mode, policy) => (mode === 'system' ? 'roots' : mode === 'roots' && policy !== 'strict' ? 'insecure' : null);

class LiveLink {
    /**
     * o: { dataDir, log, relay (URL or empty: not set up), tls ('fallback' | 'strict'), enabled () => bool,
     *      systemDns (bool: use the system's resolver when there is no lease - a computer, not the head unit),
     *      leaseFiles (where to look for the lease) }
     */
    constructor(o) {
        this.o = o || {};
        this.log = this.o.log || { info() {}, warn() {} };
        this.relay = this.o.relay ? String(this.o.relay).replace(/\/+$/, '') : null;
        this.file = path.join(this.o.dataDir || '.', 'live.json');
        this.leaseFiles = this.o.leaseFiles || [path.join(this.o.dataDir || '.', 'uplink.json'),
            typeof process.getuid === 'function' ? '/var/opt/public/oap/oap_' + process.getuid() + '/data/uplink.json' : null,
            '/run/mgu-uplink/lease.json'].filter(Boolean);
        this.pairing = null;
        try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.pairing = Pairing.fromJson(j); } catch (e) { /* none yet: made when needed */ }
        this.pending = {};
        this.st = { lastOk: 0, lastError: null, lastErrorAt: 0, sent: 0, tls: null, lastTry: 0 };
        this.busy = false;
        this.timer = null;
        this.backoff = 0;
        this.nextAt = 0;
        this.dnsCache = {};
        this.agent = { http: new http.Agent({ keepAlive: true, maxSockets: 1 }), https: new https.Agent({ keepAlive: true, maxSockets: 1 }) };
        this.lastLogged = '';
    }

    get configured() { return !!this.relay; }
    enabled() { return this.configured && (!this.o.enabled || !!this.o.enabled()); }

    ensurePairing() {
        if (!this.pairing) { this.pairing = Pairing.make(); this.save(); }
        return this.pairing;
    }
    save() {
        try {
            const tmp = this.file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.pairing.toJson()), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (e) { this.log.warn('live: cannot save the pairing: ' + e.message); }
    }
    pairUrl() { return this.configured ? this.ensurePairing().url(this.relay) : null; }
    lease() { return readLease(this.leaseFiles); }

    /** Queue the newest document of a slot; false when live is off. */
    put(slot, doc) {
        if (SLOTS.indexOf(slot) < 0 || !doc || !this.enabled()) return false;
        this.pending[slot] = doc;
        this.schedule();
        return true;
    }
    schedule() {
        if (this.timer || this.busy) return;
        const wait = Math.max(0, this.nextAt - Date.now());
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    }
    async flush() {
        if (this.busy) return;
        if (!this.enabled()) { this.pending = {}; return; }        // switched off meanwhile: nothing goes out
        this.busy = true;
        try {
            for (const slot of SLOTS) {
                const doc = this.pending[slot];
                if (!doc) continue;
                await this.send(slot, doc);
                if (this.pending[slot] === doc) delete this.pending[slot];
            }
            this.backoff = 0;
            this.nextAt = 0;
        } catch (e) {
            this.backoff = Math.min(60000, Math.max(5000, this.backoff * 2));
            this.nextAt = Date.now() + this.backoff;
            this.fail(e);
        } finally { this.busy = false; }
        if (Object.keys(this.pending).length && this.enabled()) this.schedule();
    }
    fail(e) {
        const de = e && e.de ? e.de : 'Relay nicht erreichbar (' + (e && (e.code || e.message) || e) + ')';
        this.st.lastError = de;
        this.st.lastErrorAt = Date.now();
        if (de !== this.lastLogged) { this.lastLogged = de; this.log.warn('live: ' + de + (e && e.code ? ' [' + e.code + ']' : '')); }
    }

    async send(slot, doc) {
        const p = this.ensurePairing();
        this.st.lastTry = Date.now();
        const body = JSON.stringify({ seq: doc.seq, blob: p.seal(slot, doc) });
        const r = await this.call('PUT', '/v1/c/' + p.channel + '/' + slot, body, {
            authorization: 'Bearer ' + p.writeToken, 'x-i4-read': p.readHash, 'content-type': 'application/json' });
        if (r.status === 429) return;                       // sent too often: the next one follows anyway
        if (r.status === 403) throw failure('Relay lehnt ab (403): neu koppeln', 'HTTP403');
        if (r.status !== 200) throw failure('Relay antwortet ' + r.status, 'HTTP' + r.status);
        this.st.lastOk = Date.now();
        this.st.sent++;
        this.st.lastError = null;
        if (this.lastLogged) { this.lastLogged = ''; this.log.info('live: sending again'); }
    }

    /** A request to the relay: the host resolved here, TLS falling back as config.live.tls allows. */
    async call(method, p, body, headers) {
        if (!this.relay) throw failure('Kein Relay eingetragen', 'NORELAY');
        const u = new URL(this.relay + p);
        const ip = await this.resolve(u.hostname);
        const secure = u.protocol === 'https:';
        let mode = this.st.tls || 'system', retried = false;
        for (;;) {
            try {
                const r = await request(u, { ip, method, headers, body, tls: mode, agent: secure ? this.agent.https : this.agent.http });
                if (secure && this.st.tls !== mode) { this.st.tls = mode; this.log.info('live: TLS ' + mode); }
                return r;
            } catch (e) {
                const next = nextTls(mode, this.o.tls);
                if (secure && CERT_ERRORS.indexOf(e.code) >= 0 && next) { this.log.warn('live: TLS ' + mode + ': ' + e.code + ', next ' + next); mode = next; continue; }
                // a kept-alive connection the relay had closed: once more on a new one
                if (!retried && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) { retried = true; continue; }
                if (secure && CERT_ERRORS.indexOf(e.code) >= 0) throw failure('Zertifikat des Relays nicht prüfbar (' + e.code + ')', e.code);
                throw e;
            }
        }
    }

    resolve(host) {
        if (net.isIP(host)) return Promise.resolve(host);
        const c = this.dnsCache[host];
        if (c && c.until > Date.now()) return Promise.resolve(c.ip);
        const lease = this.lease();
        const keep = (ip) => { this.dnsCache[host] = { ip, until: Date.now() + DNS_TTL }; return ip; };
        if (!lease) {
            if (!this.o.systemDns) return Promise.reject(failure('Kein Internet: der Uplink des Stores ist nicht verbunden', 'OFFLINE'));
            return new Promise((res, rej) => dns.lookup(host, { family: 4 }, (err, ip) => (err ? rej(failure('DNS: ' + host + ' nicht gefunden', err.code)) : res(keep(ip)))));
        }
        return new Promise((res, rej) => {
            const r = new dns.Resolver();
            r.setServers(lease.dns.filter(dnsServer));
            r.resolve4(host, (err, list) => (err || !list || !list.length ? rej(failure('DNS: ' + host + ' nicht gefunden', err && err.code)) : res(keep(list[0]))));
        });
    }

    /** A new key and channel; the old channel is deleted on the relay (when it can be reached). */
    rekey() {
        const old = this.pairing;
        this.pairing = Pairing.make();
        this.save();
        this.pending = {};
        this.st.lastOk = 0;
        this.st.sent = 0;
        if (old && this.enabled()) {
            this.call('DELETE', '/v1/c/' + old.channel, null, { authorization: 'Bearer ' + old.writeToken })
                .then(() => this.log.info('live: old channel deleted'), (e) => this.log.warn('live: old channel not deleted: ' + (e.de || e.message)));
        }
        return this.pairing;
    }

    status() {
        const p = this.pairing;
        return { configured: this.configured, enabled: this.enabled(), relayHost: this.relay ? new URL(this.relay).host : null,
            uplink: this.lease() ? 'online' : this.o.systemDns ? 'system' : 'offline', lastOk: this.st.lastOk, lastError: this.st.lastError,
            lastErrorAt: this.st.lastErrorAt, sent: this.st.sent, tls: this.st.tls, channel: p ? p.channel : null, queued: Object.keys(this.pending).length };
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.agent.http.destroy();
        this.agent.https.destroy();
    }
}

module.exports = { LiveLink, Pairing, readLease, request, b64url, fromB64url, sha256hex, CERT_ERRORS, SLOTS };
