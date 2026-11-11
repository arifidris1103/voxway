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

const LOOKAHEAD = 70;
const smooth = (u) => u * u * (3 - 2 * u);
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

  /** Signed lateral offset of the vehicle from path[0] during a lane change. */
  lateral(out) {
    const p = this.lane.sample(this.s, out);
    if (this.lc) {
      const q = this.lc.from.sample(this.s, {});
      const k = 1 - smooth(Math.min(1, this.lc.u));
      p.x += (q.x - p.x) * k;
      p.z += (q.z - p.z) * k;
    }
    return p;
  }

  updatePose(dt) {
    const p = this.lateral({});
    const prevX = this.pose.x, prevZ = this.pose.z;
    let heading = p.heading;
    if (this.lc) {
      // yaw into the lane change
      const side = Math.sign(this.lc.side || 0);
      heading += side * Math.sin(Math.min(1, this.lc.u) * Math.PI) * 0.12;
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
    for (const lane of this.net.entries) {
      const zone = zoneOf(lane), isVia = lane.elevated;
      if (n[zone] >= this.target[zone]) continue;
      const t = (this.spawnClock.get(lane) || 0) - dt;
      if (t > 0) { this.spawnClock.set(lane, t); continue; }
      const first = (this.occ.get(lane) || [])[0];
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
      if (i + 1 < veh.path.length) { dist += veh.path[i + 1].length; i++; if (dist > LOOKAHEAD + 40) break; continue; }
      const last = veh.path[veh.path.length - 1];
      if (!last.next.length || dist > LOOKAHEAD + 40) break;
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
      if (v.lc && v.lc.u < 0.7) put(v.lc.from, v, v.s);
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
      // fork: a car that just took the other branch still overlaps our path for the first metres
      if (i > 0 && veh.path[i - 1].next.length > 1) {
        for (const sib of veh.path[i - 1].next) {
          if (sib === lane) continue;
          for (const e of this.occ.get(sib) || []) {
            if (e.veh === veh || e.s > 30) continue;
            const gap = base + e.s - (veh.length + e.veh.length) / 2;
            if (gap > -1 && (!best || gap < best.gap)) best = { veh: e.veh, gap: Math.max(0.3, gap), dv: veh.v - e.veh.v };
          }
        }
      }
      // zipper merge: vehicles on the other lane feeding the same junction take turns
      const nxt = veh.path[i + 1];
      const dMe = base + lane.length;
      if (nxt && nxt.merge && dMe < 50) {
        for (const sib of nxt.prev) {
          if (sib === lane) continue;
          for (const e of this.occ.get(sib) || []) {
            if (e.veh === veh) continue;
            const dOther = sib.length - e.s;
            const ahead = dOther < dMe - 0.6 || (Math.abs(dOther - dMe) <= 0.6 && e.veh.id < veh.id);
            if (!ahead) continue;
            let gap = dMe - dOther - (veh.length + e.veh.length) / 2;
            // side by side: hang back and slot in behind it before the two lanes converge
            if (gap < 2) gap = Math.max(0.3, dMe - 14 - veh.length / 2);
            if (!best || gap < best.gap) best = { veh: e.veh, gap: Math.max(0.3, gap), dv: veh.v - e.veh.v, merge: true };
          }
        }
      }
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
    const stopAt = (dist, why, vObs = 0) => {
      const gap = dist - veh.length / 2;
      const a = idm(veh.v, v0, Math.max(0.05, gap), veh.v - vObs, veh);
      if (a < acc) { acc = a; reason = why; }
    };

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
      const a = idm(veh.v, v0, L.gap, L.dv, veh);
      if (a < acc) { acc = a; reason = L.courtesy ? 'letting merge' : 'following'; }
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
      // signal at the start of a connector
      if (lane.signal && i > 0 && fault !== 'red_light') {
        const st = lane.signal.inter.signal.state(lane.signal.group);
        const d = startD;
        const brakeD = (veh.v * veh.v) / (2 * 3.2);
        let stop = st === SIG.RED || (st === SIG.YELLOW && d > brakeD + 1.5);
        let why = st === SIG.GREEN ? 'queue' : st === SIG.YELLOW ? 'yellow' : 'red light';
        // don't block the box (queued cars, or a crash in / just past the junction)
        if (!stop) {
          const dep = veh.path[i + 1];
          const occ = dep && this.occ.get(dep);
          if (occ && occ.length && occ[0].s < veh.length + 2 && occ[0].veh.v < 1.5) stop = true;
          else if (this.movementBlocked(lane, veh)) { stop = true; why = 'accident ahead'; }
          else if (d > 2 && (this.inBox.get(lane.signal.inter) || []).some((o) => o.lane.signal.group !== lane.signal.group)) {
            stop = true;
            why = 'junction busy';
          }
        }
        if (stop && d > -1) stopAt(d - 0.4, why);
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
    if (lane.right) {
      const a = next(lane.right);
      const clear = !a || a.s - veh.s > (speeder ? 18 : 60);           // speeders cut back in early
      if ((speeder ? veh.passing : true) && clear && this.tryLaneChange(veh, lane.right, false, mode)) {
        veh.lastLc = this.time;
        veh.passing = false;
      }
    }
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
    // look across the ends of the target lane too (expressway pieces and forks)
    if (!lead) for (const n of target.next) for (const e of this.occ.get(n) || []) {
      if (e.veh !== veh) gapF = Math.min(gapF, target.length - veh.s + e.s - (e.veh.length + veh.length) / 2);
    }
    if (!foll) for (const p of target.prev) for (const e of this.occ.get(p) || []) {
      const g = veh.s + p.length - e.s - (e.veh.length + veh.length) / 2;
      if (e.veh !== veh && g < gapB) { gapB = g; fv = e.veh.v; }
    }
    const needF = (urgent ? 1.5 : 3) + veh.v * 0.5;
    const closing = Math.max(0, fv - veh.v);
    const needB = (urgent ? 1.5 : 3) + (gapB < 1e9 ? fv * 0.6 + closing * 1.5 : 0);
    if (relaxed === 'blind') { /* no mirror / blind-spot check at all */ }
    else if (relaxed) { if (gapF < 1 + veh.v * 0.12 || gapB < 1) return false; }   // squeezes into small gaps
    else if (gapF < needF || gapB < needB) return false;
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
        veh.lc.u += dt / veh.lc.dur;
        if (veh.lc.u >= 1) veh.lc = null;
      }
      while (veh.s > veh.lane.length) {
        if (veh.path.length < 2) this.planPath(veh);
        if (veh.path.length < 2) { exits.push(veh); break; }
        veh.s -= veh.lane.length;
        veh.path.shift();
        if (veh.lc) veh.lc = null;
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
