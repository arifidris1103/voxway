// Pedestrian trajectory prediction - the swappable "brain" of the AV.
//
// This baseline is deliberately simple so a learned model can replace it:
//   * a 1 s observed history per agent (10 Hz, the same rate as the Waymo Open
//     Motion Dataset), velocity estimated from that history;
//   * hypothesis 1: constant velocity;
//   * hypothesis 2: "about to cross" when the pedestrian stands at a kerb facing
//     the road (body orientation is an observable cue), or "keeps crossing" when
//     a jaywalker pauses mid-road.
//
// Plug in your own model with sim.setPredictor(fn) - see README. The function
// receives WOMD-style observations and must return, per agent, a list of
// { prob, traj: [{ t, x, z }] } in world coordinates (x east, z south, metres).

import { LAYOUT, roadHalfWidth, WALK } from '../world/RoadNetwork.js';

export const HORIZON = 4.0;   // seconds
export const STEP = 0.25;     // seconds between predicted points

export class History {
  constructor(len = 11) { this.len = len; this.buf = new Map(); this.acc = 0; this.ticks = 0; }

  /** Sample all pedestrians at 10 Hz (exactly every 0.1 s: 6 steps at 60 Hz, 3 at 30 Hz). */
  update(dt, peds) {
    this.acc += dt;
    if (this.acc < 0.1 - 1e-6) return;
    this.acc -= 0.1;
    this.ticks++;
    for (const p of peds) {
      let b = this.buf.get(p);
      if (!b) { b = []; this.buf.set(p, b); }
      b.push({ x: p.pos.x, z: p.pos.z, h: p.heading });
      if (b.length > this.len) b.shift();
    }
  }

  get(p) { return this.buf.get(p) || []; }
}

export class BaselinePredictor {
  constructor() {
    this.avenues = LAYOUT.avenues.map((a) => ({ x: a.x, hw: roadHalfWidth(a) }));
    this.streets = LAYOUT.streets.map((s) => ({ z: s.z, hw: roadHalfWidth(s) }));
    this.name = 'baseline (constant velocity + kerb intent)';
    this.crosswalks = [];
  }

  /** Map context the AV observes: crosswalk polygons and their walk-signal state. */
  setContext({ crosswalks }) { this.crosswalks = crosswalks || []; }

  /** Signalised crosswalk whose kerb end the pedestrian is standing at, if any. */
  crosswalkAt(x, z) {
    for (const c of this.crosswalks) {
      const along = c.axis === 'x' ? Math.abs(x - c.cx) - c.hx : Math.abs(z - c.cz) - c.hz;
      const across = c.axis === 'x' ? Math.abs(z - c.cz) - c.hz : Math.abs(x - c.cx) - c.hx;
      if (along > -0.6 && along < 2.6 && across < 1.2) return c;
    }
    return null;
  }

  /** Nearest road edge: distance (negative = on the carriageway) and normal into the road. */
  roadEdge(x, z) {
    let best = null;
    for (const a of this.avenues) {
      const d = Math.abs(x - a.x) - a.hw;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, nx: Math.sign(a.x - x) || 1, nz: 0, width: a.hw * 2 };
    }
    for (const s of this.streets) {
      const d = Math.abs(z - s.z) - s.hw;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, nx: 0, nz: Math.sign(s.z - z) || 1, width: s.hw * 2 };
    }
    return best;
  }

  line(x, z, vx, vz, speed = null, delay = 0) {
    const pts = [];
    for (let t = STEP; t <= HORIZON + 1e-6; t += STEP) {
      const k = Math.max(0, t - delay);
      pts.push({ t, x: x + vx * k, z: z + vz * k });
    }
    return pts;
  }

  /**
   * @param {object} ped    pedestrian (pos, heading)
   * @param {Array} hist    [{x, z, h}] oldest -> newest at 10 Hz
   */
  predict(ped, hist) {
    const out = [];
    const n = hist.length;
    let vx = 0, vz = 0;
    if (n >= 2) {
      const a = hist[0], b = hist[n - 1];
      const T = (n - 1) * 0.1;
      vx = (b.x - a.x) / T;
      vz = (b.z - a.z) / T;
    }
    const x = ped.pos.x, z = ped.pos.z;
    const speed = Math.hypot(vx, vz);
    if (speed > 0.2) out.push({ prob: 0.75, kind: 'cv', traj: this.line(x, z, vx, vz) });
    else out.push({ prob: 0.75, kind: 'stay', traj: this.line(x, z, 0, 0) });

    const fx = Math.sin(ped.heading), fz = Math.cos(ped.heading);
    const sp = 1.6;
    const cw = speed < 0.9 ? this.crosswalkAt(x, z) : null;
    if (cw) {
      // waiting at a signalised crossing: the walk signal is the strongest cue
      const w = cw.walk();
      const prob = w === WALK.WALK ? 0.6 : w === WALK.FLASH ? 0.12 : 0.05;
      const dx = cw.axis === 'x' ? Math.sign(cw.cx - x) : 0, dz = cw.axis === 'z' ? Math.sign(cw.cz - z) : 0;
      out.push({ prob, kind: 'cross', traj: this.line(x, z, dx * sp, dz * sp, null, 0.5) });
    } else {
      const e = this.roadEdge(x, z);
      if (e) {
        const facing = fx * e.nx + fz * e.nz;
        if (e.d > -0.2 && e.d < 2.6 && facing > 0.55 && speed < 0.9) {
          // standing at the kerb mid-block looking at the road: may step out
          out.push({ prob: 0.45, kind: 'cross', traj: this.line(x, z, e.nx * sp, e.nz * sp, null, 0.6) });
        } else if (e.d < -0.2 && speed < 0.6) {
          // paused on the carriageway: likely to continue across
          const dir = facing >= 0 ? 1 : -1;
          out.push({ prob: 0.55, kind: 'resume', traj: this.line(x, z, e.nx * sp * dir, e.nz * sp * dir, null, 0.3) });
        }
      }
    }
    const tot = out.reduce((s, h) => s + h.prob, 0);
    for (const h of out) h.prob /= tot;
    return out;
  }
}
