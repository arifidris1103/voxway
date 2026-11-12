// Traffic: lane-following vehicles with IDM car-following, signal compliance,
// pedestrian yielding and gap-accepting lane changes (used to merge past road works).
// The ego AV is a Vehicle too; its planner adds predicted-pedestrian constraints.

import * as THREE from 'three';
import { SIG } from '../world/RoadNetwork.js';
import { Materials } from '../vox/VoxAssets.js';
import { MAT } from '../vox/VoxMesher.js';
import { random } from './Random.js';

export const CAR_KEYS = [
  'cars/gt_white_orange', 'cars/classic_red_wing', 'cars/retro_panda_coupe', 'cars/hyper_black_blue',
  'cars/super_white_black', 'cars/gt_grey_red_lip', 'cars/sport_blue_lightbar',
  // open-wheel formula cars (keep these last: main.js cycles through them with F)
  'cars/formula_navy_blue', 'cars/formula_blue_pink', 'cars/formula_navy_red',
  'cars/formula_silver_teal', 'cars/formula_papaya', 'cars/formula_red',
];

/** Which traffic budget a lane counts towards: the streets, the lower viaduct, or the upper flyover with its ramps. */
const zoneOf = (lane) => (!lane.elevated ? 'ground' : lane.kind === 'ramp' || lane.y > 15 ? 'flyover' : 'viaduct');

const OPPOSITE = { SB: 'NB', NB: 'SB', EB: 'WB', WB: 'EB' };
const baseGroup = (g) => g.replace(/L$/, '');      // 'NSL' (left-turn arrow) -> 'NS'
const CONFLICT_CLEAR = 2.8;                        // paths closer than this (centre to centre) conflict
// A car waiting for one that crosses its path inside a junction stops with its nose WAIT_SHORT
// short of the other's path. It is committed to crossing (and the other car must wait) once it is on
// that path, or moving and too close to stop short of it without braking harder than B_COMMIT.
const WAIT_SHORT = 1.5, B_COMMIT = 3.5;
const committed = (v, toZone) => toZone < 0.5 || (v > 1.5 && (v * v) / (2 * B_COMMIT) > toZone - WAIT_SHORT);
const PULL_IN = true;      // the first permissive left-turner waits inside the junction, as drivers do

/** Seconds to cover `dist` metres from speed v, accelerating at `a` up to `vmax`. */
function timeToCover(dist, v, a, vmax) {
  if (dist <= 0) return 0;
  v = Math.min(v, vmax);
  const t1 = (vmax - v) / a, d1 = v * t1 + 0.5 * a * t1 * t1;
  if (d1 >= dist) return (-v + Math.sqrt(v * v + 2 * a * dist)) / a;
  return t1 + (dist - d1) / vmax;
}

/**
 * Where two connectors of one junction come within CONFLICT_CLEAR of each other, as arc-length
 * ranges on each: { a0, a1 } on A and { b0, b1 } on B, or null if they never do. Cached.
 */
function conflictZone(A, B) {
  const cache = A._cz || (A._cz = new Map());
  if (cache.has(B)) return cache.get(B);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  const pa = {}, pb = {}, ptsB = [];
  for (let t = 0; t <= B.length + 0.01; t += 0.5) { B.sample(t, pb); ptsB.push([pb.x, pb.z, t]); }
  for (let s = 0; s <= A.length + 0.01; s += 0.5) {
    A.sample(s, pa);
    for (const [x, z, t] of ptsB) {
      if ((pa.x - x) ** 2 + (pa.z - z) ** 2 < CONFLICT_CLEAR * CONFLICT_CLEAR) {
        if (s < a0) a0 = s;
        if (s > a1) a1 = s;
        if (t < b0) b0 = t;
        if (t > b1) b1 = t;
      }
    }
  }
  const z = a1 >= a0 ? { a0, a1, b0, b1 } : null;
  cache.set(B, z);
  (B._cz || (B._cz = new Map())).set(A, z && { a0: b0, a1: b1, b0: a0, b1: a1 });
  return z;
}

/** How far two branches of a fork run close enough side by side that a car on one is in the way on the other. Cached. */
function forkShared(A, B) {
  const cache = A._fork || (A._fork = new Map());
  if (cache.has(B)) return cache.get(B);
  const pa = {}, pb = {};
  let s = 0;
  for (; s <= Math.min(A.length, B.length); s += 0.5) {
    A.sample(s, pa);
    B.sample(s, pb);
    if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > 2.4) break;
  }
  cache.set(B, s);
  (B._fork || (B._fork = new Map())).set(A, s);
  return s;
}

/** Over how many metres before their join two merging lanes run close enough that cars on them would touch. Cached. */
function joinShared(A, B) {
  const cache = A._join || (A._join = new Map());
  if (cache.has(B)) return cache.get(B);
  const pa = {}, pb = {};
  let back = 0;
  for (; back <= Math.min(A.length, B.length); back += 0.5) {
    A.sample(A.length - back, pa);
    B.sample(B.length - back, pb);
    if (Math.hypot(pa.x - pb.x, pa.z - pb.z) > 2.4) break;
  }
  cache.set(B, back);
  (B._join || (B._join = new Map())).set(A, back);
  return back;
}

/** Does a ramp join this lane within `dist` metres (counted from the start of the lane)? */
function mergeAhead(lane, dist) {
  let d = 0;
  for (let l = lane; l && d < dist; ) {
    d += l.length;                                   // to the end of this piece
    const n = l.next.find((x) => x.kind !== 'ramp') || null;
    if (n && n.merge) return d < dist;
    l = n;
  }
  return false;
}

const LOOKAHEAD = 70;
const MERGE_LOOK = 160;      // a car on a ramp starts fitting in with the road's traffic this far before the join
const PLAN_AHEAD = MERGE_LOOK + 40;   // route chosen this far ahead (so a join is seen in time)
const ZIP_T = 0.6, RELAX_S = 8;      // headway in a zipper merge (s), and how long it takes to get back to the usual one
// Lane changes follow a "smootherstep": the sideways speed and acceleration both start and end at
// zero, so the car eases out of its lane and into the next one without a flick of the wheel.
const smooth = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const smoothRate = (u) => 30 * u * u * (1 - u) * (1 - u);       // its slope
let VID = 1;

export class Vehicle {
  constructor(asset, lane, s, o = {}) {
    this.id = VID++;
    this.asset = asset;
    this.obj = asset.instantiate();
    this.obj.rotation.order = 'YXZ';
    this.parts = this.obj.userData.parts;
    this.mats = this.obj.userData.materials;
    const b = asset.bounds;
    this.length = b.max.z - b.min.z;
    this.width = asset.meta.width || b.max.x - b.min.x;
    this.height = b.max.y - b.min.y;
    this.wheelR = 5 * asset.voxelSize;
    this.wheelbase = this.length * 0.58;
    this.isEgo = !!o.ego;
    this.path = [lane];
    this.s = s;
    this.v = o.v ?? lane.speed * 0.7;
    this.a = 0;
    this.desire = o.desire ?? 0.82 + random() * 0.26;
    this.T = o.T ?? 1.0 + random() * 0.7;
    this.s0 = 2.0;
    this.amax = o.amax ?? 1.5 + random() * 0.8;
    this.bcomf = 2.6;
    this.courteous = random() < 0.6;
    this.lc = null;              // { from, u, dur }
    this.wantsLane = null;       // lane we are waiting to merge into
    this.pose = { x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0 };
    this.spin = 0;
    this.steer = 0;
    this.blocked = 0;            // seconds stopped (debug / deadlock breaker)
    this.reason = '';
    this.updatePose(0);
  }

  get lane() { return this.path[0]; }

  /** How fast a lane change progresses (per second): slower when crawling, so it isn't a sideways slide. */
  lcRate() { return (1 / this.lc.dur) * THREE.MathUtils.clamp(this.v / 6, 0.35, 1); }

  /**
   * Position on path[0], shifted sideways while a lane change is under way. The shift is measured
   * once, when the change starts (`lc.off`, metres to the right of travel), and then shrinks to
   * zero, so it carries on smoothly when the road continues into its next piece mid-change.
   */
  lateral(out) {
    const p = this.lane.sample(this.s, out);
    if (this.lc) {
      const rx = -Math.cos(p.heading), rz = Math.sin(p.heading);      // right of travel
      if (this.lc.off === undefined) {
        const q = this.lc.from.sample(this.s, {});
        this.lc.off = (q.x - p.x) * rx + (q.z - p.z) * rz;
      }
      const k = this.lc.off * (1 - smooth(Math.min(1, this.lc.u)));
      p.x += rx * k;
      p.z += rz * k;
    }
    return p;
  }

  updatePose(dt) {
    const p = this.lateral({});
    const prevX = this.pose.x, prevZ = this.pose.z;
    let heading = p.heading;
    if (this.lc && this.lc.u < 1) {
      // point the car the way it is actually moving: forward along the lane plus the sideways
      // speed of the lane change (which is zero at its start and end, so the turn eases in and out);
      // at very low speed the angle levels off smoothly instead of hitting a hard limit
      const sideways = this.lc.off * smoothRate(this.lc.u) * this.lcRate();     // m/s towards the new lane
      heading += 0.35 * Math.tanh(Math.atan2(sideways, Math.max(this.v, 3)) / 0.35);
    }
    this.pose.x = p.x;
    this.pose.z = p.z;
    this.pose.y = p.y;
    this.pose.heading = heading;
    if (dt > 0) {
      this.pose.vx = (p.x - prevX) / dt;
      this.pose.vz = (p.z - prevZ) / dt;
    }
    const o = this.obj;
    o.position.set(p.x, p.y, p.z);
    const ahead = this.lane.sample(Math.min(this.lane.length, this.s + 1.5), {});
    const grade = this.lane.yProfile ? -Math.atan2(ahead.y - p.y, 1.5) : 0;
    const pitch = THREE.MathUtils.clamp(-this.a * 0.007, -0.03, 0.05) + grade;
    o.rotation.set(o.rotation.x + (pitch - o.rotation.x) * Math.min(1, dt * 6), heading, 0);

    // wheels: spin + steer from path curvature
    this.spin += (this.v * dt) / this.wheelR;
    const q = {};
    this.lane.sample(Math.min(this.lane.length, this.s + 2), q);
    let dh = q.heading - p.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const steer = THREE.MathUtils.clamp(Math.atan(this.wheelbase * dh / 2), -0.5, 0.5);
    this.steer += (steer - this.steer) * Math.min(1, dt * 8);
    for (const [name, pv] of Object.entries(this.parts)) {
      if (!name.startsWith('wheel')) continue;
      pv.rotation.order = 'ZYX';
      pv.rotation.x = this.spin;
      pv.rotation.z = name.includes('F') ? this.steer : 0;
    }
    // brake lights
    this.mats[MAT.BRAKE] = this.a < -0.5 || this.v < 0.2 ? Materials.brakeOn : Materials.brakeOff;
  }
}

export function idm(v, v0, gap, dv, veh) {
  const sStar = veh.s0 + Math.max(0, v * veh.T + (v * dv) / (2 * Math.sqrt(veh.amax * veh.bcomf)));
  return veh.amax * (1 - Math.pow(v / Math.max(v0, 0.1), 4) - Math.pow(sStar / Math.max(gap, 0.05), 2));
}

export class Traffic {
  constructor(scene, net, assets, { ground = 70, viaduct = 28, flyover = 90 } = {}) {
    this.scene = scene;
    this.net = net;
    this.assets = assets;
    this.target = { ground, viaduct, flyover };
    this.vehicles = [];
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);
    this.occ = new Map();
    this.spawnClock = new Map();
    this.peds = null;          // set by the sim (Pedestrians)
    this.ego = null;
    this.stats = { spawned: 0 };
  }

  carKeys() { return CAR_KEYS.filter((k) => this.assets[k]); }

  randomAsset() {
    const keys = this.carKeys();
    return this.assets[keys[Math.floor(random() * keys.length)]];
  }

  add(veh) {
    this.vehicles.push(veh);
    this.group.add(veh.obj);
    this.planPath(veh);
    return veh;
  }

  remove(veh) {
    this.group.remove(veh.obj);
    this.vehicles.splice(this.vehicles.indexOf(veh), 1);
  }

  // ------------------------------------------------------------ population
  populate() {
    const roadLanes = this.net.lanes.filter((l) => l.kind === 'road' && l.length > 40);
    const viaLanes = this.net.lanes.filter((l) => l.kind === 'viaduct' && l.length > 40 && zoneOf(l) === 'viaduct');
    const flyLanes = this.net.lanes.filter((l) => l.kind === 'viaduct' && l.length > 40 && zoneOf(l) === 'flyover');
    const place = (lanes, n) => {
      const total = lanes.reduce((a, l) => a + l.length, 0);
      let tries = 0;
      while (n > 0 && tries++ < n * 30) {
        // longer lanes get proportionally more cars
        let r = random() * total, lane = lanes[0];
        for (const l of lanes) { r -= l.length; if (r <= 0) { lane = l; break; } }
        const s = 10 + random() * (lane.length - 20);
        if (lane.closed && s > lane.closed.s0 - lane.closed.taper - 10 && s < lane.closed.s1 + 5) continue;
        if (this.vehicles.some((v) => v.lane === lane && Math.abs(v.s - s) < 12)) continue;
        this.add(new Vehicle(this.randomAsset(), lane, s));
        n--;
      }
    };
    place(roadLanes, this.target.ground);
    place(viaLanes, this.target.viaduct);
    place(flyLanes, this.target.flyover);
  }

  spawnAtEntries(dt) {
    const n = { ground: 0, viaduct: 0, flyover: 0 };
    for (const v of this.vehicles) if (!v.isEgo) n[zoneOf(v.lane)]++;
    // the nearest car on each entry lane, as things stand now (the occupancy lists are from the start
    // of the step: a car may have changed into the lane since)
    const firstOn = new Map();
    const note = (l, v) => { if (l && l.prev.length === 0 && (!firstOn.has(l) || v.s < firstOn.get(l).s)) firstOn.set(l, { s: v.s, veh: v }); };
    for (const v of this.vehicles) { note(v.lane, v); if (v.lc) note(v.lc.from, v); }
    for (const lane of this.net.entries) {
      const zone = zoneOf(lane), isVia = lane.elevated;
      if (n[zone] >= this.target[zone]) continue;
      const t = (this.spawnClock.get(lane) || 0) - dt;
      if (t > 0) { this.spawnClock.set(lane, t); continue; }
      const first = firstOn.get(lane);
      // enough room to stop behind the first car (queues can back up to the map edge)
      const v0 = first ? Math.min(lane.speed * 0.8, first.veh.v + 3) : lane.speed * 0.8;
      if (first && first.s < 14 + (v0 * v0) / (2 * 3)) { this.spawnClock.set(lane, 0.5); continue; }
      this.add(new Vehicle(this.randomAsset(), lane, 0, { v: v0 }));
      n[zone]++;
      this.stats.spawned++;
      this.spawnClock.set(lane, (zone === 'flyover' ? 1.6 : isVia ? 2.5 : 5) + random() * (zone === 'flyover' ? 2.4 : isVia ? 3 : 7));
    }
  }

  // ---------------------------------------------------------------- routing
  /** Extend the planned path at least LOOKAHEAD metres ahead. */
  planPath(veh) {
    let dist = veh.path[0].length - veh.s;
    let i = 0;
    while (true) {
      if (i + 1 < veh.path.length) { dist += veh.path[i + 1].length; i++; if (dist > PLAN_AHEAD) break; continue; }
      const last = veh.path[veh.path.length - 1];
      if (!last.next.length || dist > PLAN_AHEAD) break;
      const nxt = veh.isEgo && veh.planner ? veh.planner.chooseNext(veh, last) : this.chooseNext(last);
      if (!nxt) break;
      veh.path.push(nxt);
      dist += nxt.length;
      i++;
    }
  }

  chooseNext(lane) {
    const opts = lane.next;
    if (opts.length === 1) return opts[0];
    const w = opts.map((c) => (c.movement === 'straight' ? 0.62 : 0.19));
    let r = random() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < opts.length; k++) { r -= w[k]; if (r <= 0) return opts[k]; }
    return opts[opts.length - 1];
  }

  // ---------------------------------------------------------------- update
  rebuildOccupancy() {
    this.occ.clear();
    const put = (lane, veh, s) => {
      let l = this.occ.get(lane);
      if (!l) { l = []; this.occ.set(lane, l); }
      l.push({ veh, s });
    };
    for (const v of this.vehicles) {
      if (v.wreck) continue;                     // wrecks are obstacles, see Incidents.blocking
      put(v.lane, v, v.s);
      if (v.lc && v.lc.from && v.lc.u < 0.7) put(v.lc.from, v, v.s);
    }
    for (const l of this.occ.values()) l.sort((a, b) => a.s - b.s);
    // vehicles inside each junction (for the box-clear check)
    this.inBox = new Map();
    for (const v of this.vehicles) {
      if (v.wreck || v.lane.kind !== 'connector') continue;
      if (!this.inBox.has(v.lane.inter)) this.inBox.set(v.lane.inter, []);
      this.inBox.get(v.lane.inter).push(v);
    }
  }

  /** Nearest vehicle ahead along veh's planned path. */
  leader(veh) {
    let base = -veh.s;
    let best = null;
    for (let i = 0; i < veh.path.length && base < LOOKAHEAD; i++) {
      const lane = veh.path[i];
      const list = this.occ.get(lane);
      if (list) {
        for (const e of list) {
          if (e.veh === veh) continue;
          const d = base + e.s;
          if (d <= 0.01) continue;
          const gap = d - (veh.length + e.veh.length) / 2;
          if (!best || gap < best.gap) best = { veh: e.veh, gap, dv: veh.v - e.veh.v };
        }
      }
      // fork: a car that took the other branch still overlaps our path for the first metres (also
      // once we are on our branch ourselves: a left-turner waiting in the junction, say)
      const from = i > 0 ? veh.path[i - 1] : lane.prev.length === 1 ? lane.prev[0] : null;
      if (from && from.next.length > 1) {
        for (const sib of from.next) {
          if (sib === lane) continue;
          const shared = forkShared(lane, sib);
          for (const e of this.occ.get(sib) || []) {
            if (e.veh === veh || e.s - e.veh.length / 2 > shared) continue;
            const gap = base + e.s - (veh.length + e.veh.length) / 2;
            if (gap > -1 && (!best || gap < best.gap)) best = { veh: e.veh, gap: Math.max(0.3, gap), dv: veh.v - e.veh.v };
          }
        }
      }
      // (where a ramp joins, the cars on the other branch are handled by mergeConstraint)
      if (best) return best;
      // a courteous driver lets a waiting merger in from the next lane
      if (i === 0 && veh.courteous && !veh.isEgo) {
        for (const adj of [lane.left, lane.right]) {
          if (!adj) continue;
          for (const e of this.occ.get(adj) || []) {
            if (e.veh.wantsLane === lane && e.s > veh.s && e.s - veh.s < 22) {
              const gap = e.s - veh.s - (veh.length + e.veh.length) / 2;
              if (!best || gap < best.gap) best = { veh: e.veh, gap: Math.max(0.5, gap), dv: veh.v - e.veh.v, courtesy: true };
            }
          }
        }
        if (best) return best;
      }
      base += lane.length;
    }
    return best;
  }

  /**
   * Longitudinal constraints along the path: stop lines, crosswalk pedestrians,
   * pedestrians in the lane, road-work closures and slower curves.
   * Returns { acc, reason }.
   */
  constraints(veh, v0) {
    let acc = veh.amax * (1 - Math.pow(veh.v / Math.max(v0, 0.1), 4));
    let reason = 'cruise';
    // soft: brake no harder than it takes to stop 1 m short (IDM alone brakes hard for a stop
    // that comes up close, like a car waiting for a gap inside the junction)
    const stopAt = (dist, why, vObs = 0, soft = false) => {
      const gap = dist - veh.length / 2;
      let a = idm(veh.v, v0, Math.max(0.05, gap), veh.v - vObs, veh);
      if (soft && gap > 1.2) a = Math.max(a, -(veh.v * veh.v) / (2 * (gap - 1)));
      if (a < acc) { acc = a; reason = why; }
    };
    if (veh.goThrough && veh.v < 0.5) veh.goThrough = null;        // stopped: decides afresh

    const fault = veh.fault?.type;
    let L = this.leader(veh);
    if (L && fault === 'distracted' && !L.veh.isEgo) L = null;     // not looking at the road
    if (L && fault === 'speeding' && !L.veh.isEgo && L.gap > veh.v * veh.fault.react + 1.5) L = null;  // tailgates, reacts late
    // a driver at fault still slams the brakes at the last moment for the AV
    if (fault && (!L || !L.veh.isEgo) && this.incidents && this.incidents.threatensEgo(veh)) {
      acc = -8;
      reason = 'emergency brake';
    }
    if (L) {
      // just merged in behind someone at a zipper's short headway: open the gap back up gently
      const since = veh.relaxed === undefined ? Infinity : this.time - veh.relaxed;
      const p = since < RELAX_S ? { s0: veh.s0, T: Math.min(veh.T, ZIP_T + (veh.T - ZIP_T) * (since / RELAX_S)), amax: veh.amax, bcomf: veh.bcomf } : veh;
      const a = idm(veh.v, v0, L.gap, L.dv, p);
      if (a < acc) { acc = a; reason = L.courtesy ? 'letting merge' : 'following'; }
    }
    if (fault !== 'distracted') {
      const m = this.mergeConstraint(veh, v0);
      if (m && m.acc < acc) ({ acc, reason } = m);
    }

    let base = -veh.s;
    const peds = this.peds;
    for (let i = 0; i < veh.path.length && base < LOOKAHEAD; i++) {
      const lane = veh.path[i];
      const startD = base;              // distance from vehicle to lane start
      // slow for curves
      if (lane.speed < veh.v && i > 0 && fault !== 'speeding') {
        const d = Math.max(1, startD - veh.length / 2);
        const a = (lane.speed * lane.speed - veh.v * veh.v) / (2 * d);
        if (a < acc) { acc = Math.max(a, -4); reason = 'turn'; }
      }
      // signal at the start of a connector, and the give-way rules in the junction (checked inside it too)
      if (lane.signal && fault !== 'red_light' && (i > 0 || lane.kind === 'connector')) {
        const sig = lane.signal.inter.signal;
        const g = lane.signal.group, g0 = baseGroup(g);
        const d = startD;                      // negative once inside the junction
        const brakeD = (veh.v * veh.v) / (2 * 3.2);
        let held = false, permissive = false;
        if (i > 0) {
          let st = sig.state(g);
          // protected-permissive left turn: besides its own arrow phase, a left turn may go on the
          // main green, giving way to oncoming traffic (see junctionConflict)
          permissive = lane.movement === 'left' && st === SIG.RED && sig.state(g0) === SIG.GREEN;
          if (permissive) st = SIG.GREEN;
          let stop = st === SIG.RED || (st === SIG.YELLOW && d > brakeD + 1.5);
          let why = st === SIG.GREEN ? 'queue' : st === SIG.YELLOW ? 'yellow' : 'red light';
          // don't block the box (queued cars, or a crash in / just past the junction)
          if (!stop) {
            const dep = veh.path[i + 1];
            const occ = dep && this.occ.get(dep);
            if (occ && occ.length && occ[0].s < veh.length + 2 && occ[0].veh.v < 1.5) stop = true;
            else if (d - 0.4 - veh.length / 2 >= (veh.v * veh.v) / (2 * 3.5) - 0.5 && this.waitingInBox(veh, lane, veh.path[i - 1])) stop = true;
            else if (this.movementBlocked(lane, veh)) { stop = true; why = 'accident ahead'; }
            else if (d > 2 && (this.inBox.get(lane.signal.inter) || []).some((o) => baseGroup(o.lane.signal.group) !== g0)) {
              stop = true;                                  // cross traffic still clearing the junction
              why = 'junction busy';
            }
          }
          if (stop) { stopAt(d - 0.4, why); held = true; }
        }
        if (!held) {
          const c = this.junctionConflict(veh, lane, d, permissive);
          if (c) stopAt(c.at, c.why, 0, !c.hard);
          // decided to go: it keeps going with a smaller gap (see junctionConflict)
          else if (i > 0 && veh.v > 1 && d < brakeD + 4) veh.goThrough = lane;
        }
      }
      // pedestrians on crosswalks this lane passes over
      if (peds && !lane.elevated) {
        for (const c of lane.conflicts) {
          const d0 = startD + c.s0;
          if (d0 < -1 || d0 > 45) continue;
          if (peds.blocksCrosswalk(c.cw, lane, (c.s0 + c.s1) / 2, veh)) stopAt(d0 - 1.2, 'yield crosswalk');
        }
        // jaywalkers standing in this lane
        const hit = peds.inLane(lane, i === 0 ? veh.s : 0, veh);
        if (hit) stopAt(startD + hit.s - 2.5, 'pedestrian in lane');
      }
      // crashed vehicles blocking this lane
      const blk = this.incidents && this.incidents.blocking(lane, i === 0 ? veh.s : 0, veh.width);
      if (blk) stopAt(startD + blk.s - 1.5, 'accident ahead');
      // road works
      if (lane.closed && !veh.lc) {
        const d = startD + lane.closed.s0 - lane.closed.taper;
        if (d > -2) stopAt(Math.max(0.1, d), 'merge: lane closed');
      }
      base += lane.length;
    }
    return { acc, reason };
  }

  /** Expressway lane changes by choice: pass slower traffic on the left, then keep right. */
  overtake(veh) {
    const lane = veh.lane;
    if (lane.kind !== 'viaduct' || veh.lc || this.time - (veh.lastLc ?? -99) < 6) return;
    if (veh.path.slice(1, 3).some((l) => l.kind === 'ramp')) return;     // taking a ramp: keep the lane
    const f = veh.fault, speeder = f?.type === 'speeding';
    const mode = speeder ? (f.blind ? 'blind' : true) : false;
    const v0 = lane.speed * veh.desire;
    const next = (l) => {
      let best = null;
      for (const e of this.occ.get(l) || []) if (e.veh !== veh && e.s > veh.s && (!best || e.s < best.s)) best = e;
      return best;
    };
    const L = this.leader(veh);
    if (lane.left && L && L.gap < (speeder ? 60 : 35) && L.veh.v < v0 - (speeder ? 1 : 3)) {
      const a = next(lane.left);
      if ((!a || a.s - veh.s > 30 || a.veh.v > L.veh.v + 2) && this.tryLaneChange(veh, lane.left, false, mode)) {
        veh.lastLc = this.time;
        veh.passing = true;
      }
      return;
    }
    // keep right, but not into a lane that a ramp joins just ahead: leave that room to the merging cars
    if (lane.right && !mergeAhead(lane.right, veh.s + 150)) {
      const a = next(lane.right);
      const clear = !a || a.s - veh.s > (speeder ? 18 : 60);           // speeders cut back in early
      if ((speeder ? veh.passing : true) && clear && this.tryLaneChange(veh, lane.right, false, mode)) {
        veh.lastLc = this.time;
        veh.passing = false;
      }
    }
  }

  /**
   * Where a ramp joins a road (the road's lane piece after the join has `merge` set), the cars on
   * the ramp and on the road take turns like a zipper. The two lanes run side by side for the last
   * few tens of metres, close enough that cars on them would touch: before that point each pair
   * agrees once who goes first (the one nearer the join, kept unless the other gets clearly ahead),
   * and the one behind eases back, gently and early, to a safe gap by the time it gets there. Past
   * that point the order is simply who is in front, and the one behind follows it like a car in its
   * own lane.
   * Returns { acc, reason } or null.
   */
  mergeConstraint(veh, v0) {
    let base = -veh.s, acc = Infinity, reason = 'following';
    for (let i = 0; i < veh.path.length - 1 && base < MERGE_LOOK; i++) {
      const lane = veh.path[i], nxt = veh.path[i + 1];
      const dMe = base + lane.length;                 // distance to the join
      base += lane.length;
      if (!nxt.merge || dMe <= 0 || dMe > MERGE_LOOK) continue;
      const why = lane.kind === 'ramp' ? 'merge: giving way' : 'letting merge';
      for (const sib of nxt.prev) {
        if (sib === lane) continue;
        const c = joinShared(lane, sib);              // the last c metres run side by side
        const t = Math.max(0.5, (dMe - c) / Math.max(veh.v, 3));     // time to get there
        // follow the car in front more loosely far from the join, so the room opens up gradually
        const loose = { s0: veh.s0, T: ZIP_T * THREE.MathUtils.clamp(1 - (dMe - c) / MERGE_LOOK, 0.3, 1), amax: veh.amax, bcomf: veh.bcomf };
        for (const e of this.occ.get(sib) || []) {
          const o = e.veh;
          if (o === veh) continue;
          const dO = sib.length - e.s;
          const rel = dMe - dO;                        // > 0: the other car is nearer the join
          if (rel < -60 || rel > 120) continue;
          const half = (veh.length + o.length) / 2;
          let a = Infinity;
          if (dMe <= c || dO <= c) {
            // side by side already: whoever is in front goes, the other follows it, at the short
            // headway of a zipper merge (it drops back to its usual one gradually after the join)
            if (!this.zipFirst(veh, o, rel, true)) continue;
            a = idm(veh.v, v0, Math.max(0.1, rel - half), veh.v - o.v, { s0: veh.s0, T: ZIP_T, amax: veh.amax, bcomf: veh.bcomf });
            veh.relaxed = this.time;
          } else {
            if (!this.zipFirst(veh, o, rel)) continue;  // we go first: it makes room for us
            const room = half + 2 + 0.6 * o.v + Math.max(0, veh.v - o.v);
            if (rel >= room) a = idm(veh.v, v0, rel - half, veh.v - o.v, loose);
            else {
              // fall back by `drop` before the lanes meet (it pulls away by itself if it is faster)
              const drop = room - rel - Math.max(0, o.v - veh.v) * t;
              if (drop > 0) a = -Math.min(3.5, (2 * drop) / (t * t));
            }
          }
          if (a < acc) { acc = a; reason = why; }
        }
      }
    }
    return acc < Infinity ? { acc, reason } : null;
  }

  /**
   * Does car `o` go before car `veh` where their lanes join? Decided once per pair, see
   * mergeConstraint; `now`: decide by who is in front this moment (once they are side by side).
   */
  zipFirst(veh, o, rel, now = false) {
    const z = this.zip || (this.zip = new Map());
    const key = veh.id < o.id ? veh.id + ':' + o.id : o.id + ':' + veh.id;
    let rec = z.get(key);
    if (!rec || now || this.time - rec.t > 1) {      // a new pair (or one not seen for a while)
      rec = { first: rel > 0.5 || (Math.abs(rel) <= 0.5 && (rec ? rec.first === o.id : o.id < veh.id)) ? o.id : veh.id, t: this.time };
      z.set(key, rec);
    } else if (rec.first === o.id && rel < -4) rec.first = veh.id;     // it fell clearly behind us
    else if (rec.first === veh.id && rel > 4) rec.first = o.id;       // it got clearly ahead
    rec.t = this.time;
    if (z.size > 400) for (const [k, r] of z) if (this.time - r.t > 2) z.delete(k);
    return rec.first === o.id;
  }

  /**
   * Is a car standing in the junction in our way on connector `con` (on it, or on another branch
   * from our lane where it still runs alongside ours)? Then we wait at the stop line rather than
   * pull in behind it and block the box.
   */
  waitingInBox(veh, con, from) {
    for (const sib of from.next) {
      const shared = sib === con ? Infinity : forkShared(con, sib);
      for (const e of this.occ.get(sib) || []) {
        if (e.veh !== veh && e.veh.v < 1.5 && e.s - e.veh.length / 2 < shared) return true;
      }
    }
    return false;
  }

  /** Is the movement through connector `con` blocked by a wreck (in the box or just past it)? */
  movementBlocked(con, veh) {
    const inc = this.incidents;
    if (!inc || !inc.wrecks.length) return false;
    if (inc.blocking(con, 0, veh.width)) return true;
    const dep = con.next[0];
    const b = dep && inc.blocking(dep, 0, veh.width);
    return !!(b && b.s < veh.length + 8);
  }

  /**
   * Give-way rules where paths cross inside a junction, between the two directions of a road (they
   * share a green). `d`: distance from the car's centre to the start of connector `con`, negative
   * once inside. Returns { why, at, hard }: wait `at` metres ahead (at the stop line while the car
   * can still stop there comfortably, otherwise short of the oncoming lanes), or null to go.
   *  - a car that can no longer stop short of a crossing path is committed to it: the others wait;
   *  - a car standing on our path: wait for it;
   *  - a left turn gives way to oncoming straight and right-turning traffic: on the main green
   *    (`permissive`) it goes only if it can clear the oncoming path, with a margin, before the
   *    next oncoming car gets there. The first one in line pulls forward into the junction to wait;
   *  - opposite left turns whose paths cross (wide junctions) take turns: first to arrive goes.
   */
  junctionConflict(veh, con, d, permissive) {
    const I = con.inter, opp = I.approaches[OPPOSITE[con.dir]];
    if (!opp) return null;
    const sig = I.signal;
    const mine = con.movement === 'left' ? 1 : 0;                    // 1 = gives way
    // once it has decided to go it needs a smaller gap to keep going (no dithering at the line)
    const margin = (veh.isEgo ? 2.0 : 1.0) * (veh.goThrough === con ? 0.4 : 1);
    const lineGap = d - 0.4 - veh.length / 2;                        // nose to the stop line
    const atLine = lineGap > -0.8 && lineGap >= (veh.v * veh.v) / (2 * 3.5) - 0.5;
    // (permissive) we must be through before the cross road gets its green
    if (permissive && atLine && veh.goThrough !== con) {
      const tThrough = timeToCover(d + con.length + veh.length / 2, veh.v, veh.amax, con.speed);
      if (sig.timeToCrossGreen(baseGroup(con.signal.group)) < tThrough + 1) return { why: 'yellow', at: d - 0.4 };
    }
    let res = null, first = Infinity;
    for (const ap of opp) {
      for (const B of ap.next) {
        if (B.inter !== I || !B.signal) continue;
        const z = conflictZone(con, B);
        if (!z) continue;
        const toZone = d + z.a0 - veh.length / 2;                    // our nose to their path
        if (d + z.a1 + veh.length / 2 <= 0) continue;                // our tail is past it
        const theirs = B.movement === 'left' ? 1 : 0;
        if (toZone < 0.5) continue;                                  // on it: clear it
        if (committed(veh.v, toZone)) {
          // too late to stop comfortably: brake hard only for a car standing on our path
          for (const e of this.occ.get(B) || []) {
            const Y = e.veh, posY = -e.s;
            if (Y === veh || Y.wreck || posY + z.b0 - Y.length / 2 > 0.5 || posY + z.b1 + Y.length / 2 <= 0) continue;
            const tOut = (posY + z.b1 + Y.length / 2) / Math.max(Y.v, 0.1);
            if (tOut > timeToCover(toZone, veh.v, veh.amax, con.speed)) {
              const at = d + z.a0 - (WAIT_SHORT - 1);
              if (!res || at < res.at) res = { why: 'junction busy', at, hard: true };
            }
          }
          continue;
        }
        first = Math.min(first, z.a0);
        const tClear = timeToCover(d + z.a1 + veh.length / 2, veh.v, veh.amax, con.speed);
        const eta = timeToCover(toZone, veh.v, veh.amax, con.speed);
        const check = (Y, posY) => {        // posY: distance from Y's centre to the start of B
          if (Y === veh || Y.wreck) return null;
          if (posY + z.b1 + Y.length / 2 <= 0) return null;          // already past our path
          const toZoneY = posY + z.b0 - Y.length / 2;
          if (toZoneY < 0.5) return mine && !theirs ? 'oncoming traffic' : 'junction busy';   // on our path
          if (posY > 0) {
            // will it come? (it stops for its own red, or for a yellow it can still stop for)
            const stY = sig.state(B.signal.group);
            const permY = theirs && stY === SIG.RED && sig.state(baseGroup(B.signal.group)) === SIG.GREEN;
            if (stY === SIG.RED && !permY) return null;
            if (stY === SIG.YELLOW && posY > (Y.v * Y.v) / (2 * 3.2) + 1.5) return null;
          }
          // standing in a queue behind another standing car (a left-turner waiting in the junction,
          // say): it isn't coming yet, so it mustn't hold us up (we'd all wait for each other)
          if (Y.v < 0.5) {
            const L = this.leader(Y);
            if (L && L.veh.v < 0.5 && L.gap < 8) return null;
          }
          const etaY = timeToCover(toZoneY, Y.v, Y.amax, B.speed * (Y.desire || 1));
          let theyGoFirst;
          if (committed(Y.v, toZoneY)) theyGoFirst = true;           // it can't stop for us any more
          else if (mine !== theirs) theyGoFirst = mine > theirs;     // straight / right before left
          else theyGoFirst = etaY < eta - 0.5 || (Math.abs(etaY - eta) <= 0.5 && Y.id < veh.id);
          if (!theyGoFirst || etaY > tClear + margin) return null;
          return mine && !theirs ? 'oncoming traffic' : 'junction busy';
        };
        let why = null;
        for (const e of this.occ.get(B) || []) if ((why = check(e.veh, -e.s))) break;
        if (!why) {
          for (const e of this.occ.get(ap) || []) {
            if (e.veh.path[1] === B && (why = check(e.veh, ap.length - e.s))) break;
          }
        }
        if (why && (!res || !res.hard)) res = { why, at: Infinity };
      }
    }
    // a left turn doesn't set off across the oncoming lanes while people are crossing (or about to
    // cross) the road it turns into: it would end up waiting for them in the oncoming traffic's way
    if (mine && first < Infinity && !res && this.peds) {
      for (const c of con.conflicts) {
        if (c.s0 > first && this.peds.blocksCrosswalk(c.cw, con, (c.s0 + c.s1) / 2, veh)) { res = { why: 'yield crosswalk', at: Infinity }; break; }
      }
    }
    if (res && !res.hard) {
      // wait at the stop line, or (the first in line on a permissive green, or a car already past
      // the line) short of the oncoming lanes
      const lead = permissive && mine && res.why === 'oncoming traffic' && PULL_IN &&
        !(this.occ.get(con) || []).some((e) => e.veh !== veh);
      res.at = atLine && !lead ? d - 0.4 : d + first - (WAIT_SHORT - 1);
    }
    return res;
  }

  /** Drivers take another exit when theirs is blocked by a crash (the AV re-plans in EgoPlanner). */
  reroute(veh) {
    const lane = veh.lane, con = veh.path[1];
    if (lane.kind !== 'road' || !con || con.kind !== 'connector' || !this.movementBlocked(con, veh)) return;
    const alt = lane.next.filter((c) => c !== con && !this.movementBlocked(c, veh));
    if (!alt.length) return;
    veh.path = [lane, alt[Math.floor(random() * alt.length)]];
    this.planPath(veh);
  }

  /** Try a lane change into `target` (adjacent, parallel). */
  tryLaneChange(veh, target, urgent, relaxed = false) {
    const list = this.occ.get(target) || [];
    let lead = null, foll = null;
    for (const e of list) {
      if (e.veh === veh) continue;
      if (e.s >= veh.s) { if (!lead || e.s < lead.s) lead = e; } else if (!foll || e.s > foll.s) foll = e;
    }
    let gapF = lead ? lead.s - veh.s - (lead.veh.length + veh.length) / 2 : 1e9;
    let gapB = foll ? veh.s - foll.s - (foll.veh.length + veh.length) / 2 : 1e9;
    let fv = foll ? foll.veh.v : 0;
    let leadVeh = lead ? lead.veh : null, follVeh = foll ? foll.veh : null;
    // look across the ends of the target lane too (expressway pieces and forks)
    if (!lead) for (const n of target.next) for (const e of this.occ.get(n) || []) {
      const g = target.length - veh.s + e.s - (e.veh.length + veh.length) / 2;
      if (e.veh !== veh && g < gapF) { gapF = g; leadVeh = e.veh; }
    }
    if (!foll) for (const p of target.prev) for (const e of this.occ.get(p) || []) {
      const g = veh.s + p.length - e.s - (e.veh.length + veh.length) / 2;
      if (e.veh !== veh && g < gapB) { gapB = g; fv = e.veh.v; follVeh = e.veh; }
    }
    // the target lane starts at a fork: cars that took the other branch (an exit ramp, say) still run
    // alongside it for the first metres
    if (target.prev.length === 1) {
      for (const sib of target.prev[0].next) {
        if (sib === target) continue;
        const shared = forkShared(target, sib);
        for (const e of this.occ.get(sib) || []) {
          if (e.veh === veh || e.s - e.veh.length / 2 > shared) continue;
          const g = Math.abs(e.s - veh.s) - (e.veh.length + veh.length) / 2;
          if (e.s >= veh.s) { if (g < gapF) { gapF = g; leadVeh = e.veh; } }
          else if (g < gapB) { gapB = g; fv = e.veh.v; follVeh = e.veh; }
        }
      }
    }
    const needF = (urgent ? 1.5 : 3) + veh.v * 0.5;
    const closing = Math.max(0, fv - veh.v);
    const needB = (urgent ? 1.5 : 3) + (gapB < 1e9 ? fv * 0.6 + closing * 1.5 : 0);
    if (relaxed === 'blind') { /* no mirror / blind-spot check at all */ }
    else if (relaxed) { if (gapF < 1 + veh.v * 0.12 || gapB < 1) return false; }   // squeezes into small gaps
    else {
      if (gapF < needF || gapB < needB) return false;
      // and only a gap that nobody has to brake hard for: not us behind the new leader, and not the
      // car we pull in front of (the safety rule of the MOBIL lane-change model)
      const bSafe = urgent ? 4.5 : 3;
      if (leadVeh && idm(veh.v, target.speed * veh.desire, gapF, veh.v - leadVeh.v, veh) < -bSafe) return false;
      if (follVeh && !follVeh.wreck && idm(fv, target.speed * (follVeh.desire || 1), gapB, fv - veh.v, follVeh) < -bSafe) return false;
    }
    const from = veh.lane;
    const side = target === from.left ? 1 : -1;
    veh.lc = { from, u: 0, dur: relaxed ? 1.3 : 2.4, side };
    veh.path = [target];
    veh.wantsLane = null;
    this.planPath(veh);
    return true;
  }

  /** Mandatory lane changes: road works, and (for the ego) the lane needed for the next turn. */
  laneDecisions(veh) {
    if (veh.lc) return;
    const lane = veh.lane;
    if (lane.kind === 'connector') return;
    let target = null;
    veh.avoiding = false;
    const blk = this.incidents && this.incidents.blocking(lane, veh.s, veh.width);
    if (blk && blk.s - veh.s < 150) {
      const free = (l) => l && !this.incidents.blocking(l, Math.max(0, veh.s - 5), veh.width);
      target = free(lane.left) ? lane.left : free(lane.right) ? lane.right : null;
      if (target) {
        veh.avoiding = true;
        veh.wantsLane = target;
        this.tryLaneChange(veh, target, blk.s - veh.s < 30);
        return;
      }
    }
    if (lane.closed && veh.s < lane.closed.s1) target = lane.left || lane.right;
    if (!target && veh.isEgo && veh.planner) {
      target = veh.planner.desiredLane(veh);
      // never merge back into a lane that still has a wreck ahead
      if (target && this.incidents && this.incidents.blocking(target, Math.max(0, veh.s - 5), veh.width)) target = null;
    }
    if (!target) { veh.wantsLane = null; if (!veh.isEgo) this.overtake(veh); return; }
    const distToEnd = lane.closed ? lane.closed.s0 - lane.closed.taper - veh.s : lane.length - veh.s;
    veh.wantsLane = target;
    this.tryLaneChange(veh, target, distToEnd < 30);
  }

  update(dt) {
    this.time = (this.time || 0) + dt;
    this.rebuildOccupancy();
    const crashes = this.incidents && this.incidents.wrecks.length > 0;
    for (const veh of this.vehicles) {
      if (veh.planner || veh.wreck) continue;
      this.laneDecisions(veh);
      if (crashes) this.reroute(veh);
    }
    for (const veh of this.vehicles) {
      if (veh.wreck) continue;
      const lane = veh.lane;
      let v0 = lane.speed * veh.desire;
      let res;
      if (veh.isEgo && veh.planner) {
        this.laneDecisions(veh);
        res = veh.planner.control(veh, this, v0);
      } else {
        res = this.constraints(veh, v0);
      }
      veh.a = THREE.MathUtils.clamp(res.acc, -8.5, veh.amax);
      veh.reason = res.reason;
    }
    const exits = [];
    for (const veh of this.vehicles) {
      if (veh.wreck) continue;
      veh.v = Math.max(0, veh.v + veh.a * dt);
      veh.s += veh.v * dt;
      veh.blocked = veh.v < 0.1 ? veh.blocked + dt : 0;
      if (veh.lc) {
        veh.lc.u += dt * veh.lcRate();
        if (veh.lc.u >= 1) veh.lc = null;
      }
      while (veh.s > veh.lane.length) {
        if (veh.path.length < 2) this.planPath(veh);
        if (veh.path.length < 2) { exits.push(veh); break; }
        if (veh.lc && veh.lc.off === undefined) veh.lateral({});    // measure the shift before moving on
        veh.s -= veh.lane.length;
        veh.path.shift();
        if (veh.goThrough && veh.goThrough !== veh.lane) veh.goThrough = null;   // through the junction
        // a lane change carries on into the next piece of road (it used to end there, and the car
        // jumped sideways); the lane it left continues alongside, if there is one
        if (veh.lc) veh.lc.from = veh.lc.from?.next.find((n) => n.left === veh.lane || n.right === veh.lane) || null;
        this.planPath(veh);
      }
      if (veh.path.length < 3) this.planPath(veh);
      veh.updatePose(dt);
      if (veh.fault?.type === 'speeding' && veh.lane.kind === 'ramp' && veh.v > veh.lane.speed * 1.3 && this.incidents) {
        this.incidents.spinOut(veh);                    // too fast for the curve
      }
    }
    for (const veh of exits) {
      if (veh.isEgo) {                     // safety net: the AV should always re-join its loop
        if (this.onEgoDeadEnd) this.onEgoDeadEnd(veh); else { veh.s = veh.lane.length; veh.v = 0; }
        continue;
      }
      this.remove(veh);
    }
    this.spawnAtEntries(dt);
  }
}
