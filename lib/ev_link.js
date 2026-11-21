'use strict';
/**
 * ev_link.js - one request at a time on the head unit's diagnostic link (per app), urgent reads first.
 * After URGENT_RUN urgent turns in a row a waiting normal read goes next, so a fast power poll never
 * starves the slow reads (charge, temperatures).
 *
 * After the link queue of idrive7-apps' eDrive (apps/edrive/linkqueue.js, MIT, cauliflowermossgrape).
 *
 *   const exclusive = linkQueue(log);
 *   await exclusive(fn, urgent, label)   -> fn's result, after the turns ahead of it
 */
const URGENT_RUN = 3, STALL_MS = 1500;

function linkQueue(log) {
    const queue = [];
    let pumping = false, urgentRun = 0;
    async function pump() {
        if (pumping) return;
        pumping = true;
        while (queue.length) {
            const wait = urgentRun >= URGENT_RUN ? queue.findIndex((x) => !x.urgent) : -1;
            const j = wait > 0 ? queue.splice(wait, 1)[0] : queue.shift(), t0 = Date.now();
            urgentRun = j.urgent ? urgentRun + 1 : 0;
            try { j.res(await j.fn()); } catch (e) { j.rej(e); }
            const ms = Date.now() - t0;
            if (ms > STALL_MS) { exclusive.stalls = (exclusive.stalls || 0) + 1; if (log) log.warn('link held ' + ms + ' ms by ' + j.label); }
        }
        pumping = false;
    }
    const exclusive = (fn, urgent, label) => new Promise((res, rej) => {
        const j = { fn, res, rej, urgent: !!urgent, label: label || (urgent ? 'urgent' : 'read') };
        if (urgent) { const k = queue.findIndex((x) => !x.urgent); queue.splice(k < 0 ? queue.length : k, 0, j); } else queue.push(j);
        pump();
    });
    exclusive.pending = () => queue.length;
    return exclusive;
}

module.exports = { linkQueue, URGENT_RUN };
