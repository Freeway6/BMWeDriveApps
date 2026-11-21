'use strict';
/**
 * ev_trip.js - drives: one starts when the car moves, ends after 5 minutes standing (or when the head unit
 * slept in between), and its distance is the speed signal added up.
 *
 *   const trips = new TripClock(state, { make: () => ({ out: 0 }), onClose(trip) {} });
 *   trips.speed(t, kmh)      // every speed signal
 *   trips.check(t)           // now and then: closes a drive that has stopped
 *   trips.open               // the drive going on, or null
 *
 * state (persisted by the app): { trips: [summary], open: trip | null }.
 */
const { isNum } = require('./ev_core');

const MOVE_KMH = 2;
const STAND_MS = 5 * 60000;
const GAP_MS = 10 * 60000;
const MAX_DT = 2000;          // a speed reading counts at most this long (a gap in the signal is not driven)

class TripClock {
    constructor(state, opts) {
        this.st = state;
        if (!Array.isArray(state.trips)) state.trips = [];
        if (state.open === undefined) state.open = null;
        this.o = opts || {};
        this.max = this.o.max || 100;
        this.last = null;          // [t, kmh]
    }
    get open() { return this.st.open; }

    speed(t, v) {
        if (!isNum(t) || !isNum(v)) return;
        let o = this.st.open;
        if (o && t - o.t1 > GAP_MS) { this.close('asleep'); o = null; }
        if (!o && v > MOVE_KMH) {
            o = this.st.open = Object.assign({ id: t, t0: t, t1: t, km: 0, movingMs: 0, standSince: 0, vmax: 0 }, this.o.make ? this.o.make(t) : {});
            this.last = null;
            if (this.o.onOpen) this.o.onOpen(o);
        }
        if (!o) { this.last = [t, v]; return; }
        if (this.last && t > this.last[0]) {
            const dt = Math.min(MAX_DT, t - this.last[0]);
            o.km += (v + this.last[1]) / 2 * dt / 3600000;
            if (v > 1) o.movingMs += dt;
        }
        if (v > 1) o.standSince = 0;
        else if (!o.standSince) o.standSince = t;
        if (v > o.vmax) o.vmax = v;
        o.t1 = t;
        this.last = [t, v];
    }

    /** Close a drive the car has stopped (standing 5 min, or nothing for 10 min). */
    check(t) {
        const o = this.st.open;
        if (!o) return null;
        if ((o.standSince && t - o.standSince > STAND_MS) || t - o.t1 > GAP_MS) return this.close(o.standSince ? 'parked' : 'asleep');
        return null;
    }

    close(reason) {
        const o = this.st.open;
        this.st.open = null;
        this.last = null;
        if (!o || o.km < 0.2) return null;
        if (o.standSince) o.t1 = Math.min(o.t1, o.standSince);
        o.reason = reason;
        delete o.standSince;
        const sum = this.o.summary ? this.o.summary(o) : o;
        if (sum) {
            this.st.trips.push(sum);
            if (this.st.trips.length > this.max) this.st.trips.splice(0, this.st.trips.length - this.max);
        }
        if (this.o.onClose) this.o.onClose(sum);
        return sum;
    }
}

module.exports = { TripClock, MOVE_KMH, STAND_MS, GAP_MS };
