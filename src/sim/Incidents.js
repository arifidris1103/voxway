// Vehicle accidents for safety-critical training data.
//
// Ordinary traffic never crashes (IDM is collision-free), so incidents are caused
// the way they happen on real roads: a driver makes a mistake.
//   distracted          stops reacting to the car ahead       -> rear-end
//   red_light           enters the junction on red            -> T-bone / near miss
//   unsafe_lane_change  cuts into an occupied lane            -> sideswipe
// Collisions are detected with oriented boxes, resolved with an impulse (cars slide
// and spin), and the wrecks stay on the road as obstacles until they are cleared.
// Every incident is logged as a labelled event for the scenario export.

import * as THREE from 'three';
import { SIG } from '../world/RoadNetwork.js';
import { Materials } from '../vox/VoxAssets.js';
import { MAT } from '../vox/VoxMesher.js';
import { random, shuffle } from './Random.js';

const KINDS = ['distracted', 'red_light', 'unsafe_lane_change'];
const WRECK_TIME = 42;           // seconds before a wreck is towed away
const rand = (a, b) => a + random() * (b - a);

/** Crash type from the geometry of the impact. */
function classify(a, b) {
  let dh = Math.abs(a.pose.heading - b.pose.heading) % (2 * Math.PI);
  if (dh > Math.PI) dh = 2 * Math.PI - dh;
  if (dh > 2.4) return 'head_on';
  if (dh > 0.8) return 't_bone';
  const fx = Math.sin(a.pose.heading), fz = Math.cos(a.pose.heading);
  const dx = b.pose.x - a.pose.x, dz = b.pose.z - a.pose.z;
  return Math.abs(dx * fx + dz * fz) > 1.7 * Math.abs(dz * fx - dx * fz) ? 'rear_end' : 'sideswipe';
}

/** Oriented box of a vehicle in the ground plane (slightly shrunk). */
function obb(v) {
  const h = v.pose.heading;
  return { x: v.pose.x, z: v.pose.z, fx: Math.sin(h), fz: Math.cos(h), hl: v.length * 0.47, hw: v.width * 0.45 };
}

/** Separating-axis test for two oriented rectangles. */
function overlap(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ax, az] of [[a.fx, a.fz], [-a.fz, a.fx], [b.fx, b.fz], [-b.fz, b.fx]]) {
    const ra = a.hl * Math.abs(a.fx * ax + a.fz * az) + a.hw * Math.abs(-a.fz * ax + a.fx * az);
    const rb = b.hl * Math.abs(b.fx * ax + b.fz * az) + b.hw * Math.abs(-b.fz * ax + b.fx * az);
    if (Math.abs(dx * ax + dz * az) > ra + rb) return false;
  }
  return true;
}

export class Incidents {
  constructor(scene, net, traffic, peds, assets, { rate = 1 / 75 } = {}) {
    this.scene = scene;
    this.net = net;
    this.traffic = traffic;
    this.peds = peds;
    this.assets = assets;
    this.rate = rate;                 // automatic incidents per second
    this.clock = 25;                  // first one after ~25 s
    this.events = [];                 // labelled events (for the WOMD-style export)
    this.wrecks = [];
    this.time = 0;
    this.stats = { collisions: 0, violations: 0 };
    this.onEvent = null;
    this.group = new THREE.Group();
    this.group.name = 'incidents';
    scene.add(this.group);
    // debris + smoke particles (instanced voxels)
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.debris = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.6 }), 400);
    this.debris.count = 0;
    this.debris.castShadow = true;
    this.debrisList = [];
    this.smoke = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false }), 240);
    this.smoke.count = 0;
    this.smokeList = [];
    this.group.add(this.debris, this.smoke);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._c = new THREE.Color();
  }

  log(type, ids, x, z, extra = {}) {
    const e = { t: +this.time.toFixed(2), type, ids, x: +x.toFixed(2), z: +z.toFixed(2), ...extra };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    if (this.onEvent) this.onEvent(e);
    return e;
  }

  // -------------------------------------------------------------- triggers
  candidates(near, prefer, kind) {
    const e = this.traffic.ego, fast = kind === 'speeding';
    const list = this.traffic.vehicles.filter((v) => !v.isEgo && !v.wreck && !v.fault && v.v > 4
      && (fast ? v.lane.kind === 'viaduct' : !v.lane.elevated));
    // speeders: near the AV (often behind it, so they overtake it), same level and direction first
    const c = fast && e ? e.pose : near;
    const d = (v) => Math.hypot(v.pose.x - c.x, v.pose.z - c.z);
    const score = (v) => d(v) + (prefer && !fast && !prefer.has(v.lane) ? 500 : 0)
      + (fast && e ? (Math.abs(v.pose.y - e.pose.y) > 2 ? 800 : 0) + (Math.cos(v.pose.heading - e.pose.heading) < 0.8 ? 400 : 0) : 0);
    return list.filter((v) => d(v) < (fast ? 320 : 160)).sort((a, b) => score(a) - score(b));
  }

  /** Lanes on the AV's planned path and their neighbours (crashes there affect the AV). */
  egoLanes(ego) {
    const set = new Set();
    for (const l of ego.path) { set.add(l); if (l.left) set.add(l.left); if (l.right) set.add(l.right); }
    return set;
  }

  /** Cause an incident near `near` ({x, z}), preferring drivers on `prefer` lanes; true if one started. */
  trigger(kind, near, prefer = null) {
    const kinds = kind ? [kind] : shuffle([...KINDS]);
    for (const k of kinds) {
      for (const v of this.candidates(near, prefer, k)) {
        if (k === 'speeding') {
          v.fault = { type: 'speeding', until: this.time + 50, react: rand(0.08, 0.3), blind: random() < 0.45 };
          v.desire = rand(1.4, 1.55);
          v.T = 0.6;
          v.amax = Math.max(v.amax, 2.8);
          this.stats.violations++;
          return this.started(v, 'speeding');
        }
        if (k === 'distracted') {
          const L = this.traffic.leader(v);
          if (!L || L.veh.isEgo || L.veh.wreck || L.gap < 5 || L.gap > 45) continue;
          if (!(L.veh.v < v.v - 1.5 || L.veh.a < -0.4 || L.veh.v < 1)) continue;
          v.fault = { type: 'distracted', until: this.time + 8 };
          return this.started(v, 'distracted');
        }
        if (k === 'red_light') {
          let d = -v.s, hit = null;
          for (let i = 0; i < v.path.length && d < 70; i++) {
            const l = v.path[i];
            if (l.signal && i > 0) { hit = { l, d }; break; }
            d += l.length;
          }
          if (!hit || hit.d < 12 || hit.d > 60) continue;
          if (hit.l.signal.inter.signal.state(hit.l.signal.group) === SIG.GREEN) continue;
          v.fault = { type: 'red_light', until: this.time + 14 };
          v.desire = 1.15;
          this.stats.violations++;
          return this.started(v, 'red_light');
        }
        if (k === 'unsafe_lane_change') {
          const e = this.traffic.ego;
          if (v.lane.kind !== 'road' || v.lc || (e && Math.hypot(e.pose.x - v.pose.x, e.pose.z - v.pose.z) < 15)) continue;
          for (const adj of [v.lane.left, v.lane.right]) {
            if (!adj) continue;
            const nb = (this.traffic.occ.get(adj) || []).find((e) => !e.veh.isEgo && !e.veh.wreck && Math.abs(e.s - v.s) < 2.5 && e.veh.v > 3);
            if (!nb) continue;
            v.lc = { from: v.lane, u: 0, dur: 1.5, side: adj === v.lane.left ? 1 : -1 };
            v.path = [adj];
            this.traffic.planPath(v);
            v.fault = { type: 'unsafe_lane_change', until: this.time + 4 };
            return this.started(v, 'unsafe_lane_change');
          }
        }
      }
    }
    return false;
  }

  started(v, type) {
    const name = { red_light: 'red_light_violation', unsafe_lane_change: 'unsafe_lane_change', distracted: 'distracted_driver', speeding: 'speeding' }[type];
    this.log(name, [v.id], v.pose.x, v.pose.z, { at_fault: v.id, ...(type === 'speeding' ? { over_limit: +v.desire.toFixed(2), elevated: true } : {}) });
    return true;
  }

  // -------------------------------------------------------------- crashes
  crash(a, b) {
    const ax = a.pose.vx || Math.sin(a.pose.heading) * a.v, az = a.pose.vz || Math.cos(a.pose.heading) * a.v;
    const bx = b.wreck ? b.wreck.vx : b.pose.vx || Math.sin(b.pose.heading) * b.v;
    const bz = b.wreck ? b.wreck.vz : b.pose.vz || Math.cos(b.pose.heading) * b.v;
    let nx = b.pose.x - a.pose.x, nz = b.pose.z - a.pose.z;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const vn = (ax - bx) * nx + (az - bz) * nz;
    const J = Math.max(0.5, (1.25 * vn) / 2);
    const rel = Math.hypot(ax - bx, az - bz);
    const spin = Math.min(2.6, J * 0.32 + rel * 0.05);
    const sgn = random() < 0.5 ? -1 : 1;
    const fault = a.fault?.type || b.fault?.type || 'chain';
    const atFault = a.fault ? a.id : b.fault ? b.id : a.wreck ? a.id : null;
    const kind = a.wreck || b.wreck ? 'chain' : classify(a, b);
    for (const [v, vx, vz, s] of [[a, ax - J * nx, az - J * nz, sgn], [b, bx + J * nx, bz + J * nz, -sgn]]) {
      if (v.wreck) { v.wreck.vx = vx; v.wreck.vz = vz; v.wreck.omega += s * spin * 0.5; v.wreck.t = 0; continue; }
      v.wreck = { vx, vz, omega: s * spin, roll: rand(-0.05, 0.05), t: 0, clear: WRECK_TIME + rand(-8, 8), lane: v.lane };
      v.fault = null;
      v.v = 0;
      v.a = 0;
      v.lc = null;
    }
    this.stats.collisions++;
    const mx = (a.pose.x + b.pose.x) / 2, mz = (a.pose.z + b.pose.z) / 2;
    this.log('collision', [a.id, b.id], mx, mz, { kind, cause: fault, at_fault: atFault, rel_speed: +rel.toFixed(2), elevated: a.pose.y > 2 });
    this.burst(a, mx, mz, rel);
    this.burst(b, mx, mz, rel);
    if (a.pose.y < 2) this.peds.gawk?.(mx, mz, 30);
    if (!a.wreck.triangle) this.placeTriangle(a.wreck.lane || a.lane, a);
  }

  burst(v, x, z, rel) {
    const n = Math.min(26, 8 + Math.round(rel * 1.5));
    const pal = v.asset.palette;
    for (let i = 0; i < n && this.debrisList.length < 400; i++) {
      const idx = 1 + Math.floor(random() * 3);
      const col = new THREE.Color().setRGB(pal[(idx - 1) * 4] / 255, pal[(idx - 1) * 4 + 1] / 255, pal[(idx - 1) * 4 + 2] / 255, THREE.SRGBColorSpace);
      const a = random() * Math.PI * 2, sp = rand(1, 3.5) + rel * 0.15;
      this.debrisList.push({
        x: x + rand(-0.6, 0.6), y: v.pose.y + rand(0.4, 1.0), z: z + rand(-0.6, 0.6),
        vx: Math.cos(a) * sp, vy: rand(1.5, 4), vz: Math.sin(a) * sp, s: rand(0.08, 0.22), r: random() * 3,
        col, ground: v.pose.y, owner: v,
      });
    }
    v.wreck.smoke = 9;
  }

  placeTriangle(lane, v) {
    if (!lane || lane.kind === 'connector' || !this.assets['props/warning_triangle']) return;
    const pr = lane.project(v.pose.x, v.pose.z);
    const s = Math.max(1, pr.s - 22);
    const p = lane.sample(s, {});
    const tri = this.assets['props/warning_triangle'].instantiate({ castShadow: false });
    tri.position.set(p.x, p.y + 0.01, p.z);
    tri.rotation.y = Math.atan2(-p.hx, -p.hz);
    tri.visible = false;
    this.group.add(tri);
    v.wreck.triangle = tri;
    v.wreck.triAt = 4;
  }

  // -------------------------------------------------------------- update
  update(dt, time, ego) {
    this.time = time;
    const vehicles = this.traffic.vehicles;

    // automatic incidents somewhere the AV can see them (often right ahead of it)
    if (this.rate > 0) {
      this.clock -= dt;
      if (this.clock <= 0) {
        const p = ego.planner?.path;
        const near = p && p.length > 40 && random() < 0.6 ? p[Math.min(p.length - 1, 55)] : { x: ego.pose.x, z: ego.pose.z };
        const kind = random() < (ego.pose.y > 2 ? 0.75 : 0.25) ? 'speeding' : null;   // highway speeders
        const ok = this.trigger(kind, near, random() < 0.65 ? this.egoLanes(ego) : null);
        this.clock = ok ? rand(0.6, 1.4) / this.rate : 4;
      }
    }

    // faults expire
    for (const v of vehicles) {
      if (v.fault && time > v.fault.until && !v.wreck) { v.fault = null; v.nearMissLogged = false; v.desire = Math.min(v.desire, 1.08); }
    }

    // collision detection among ground vehicles (the AV is excluded from crashes)
    const live = vehicles.filter((v) => !v.isEgo);
    const moving = (v) => v.wreck && Math.hypot(v.wreck.vx, v.wreck.vz) > 1;
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        // only drivers at fault (or a wreck still sliding) can cause a collision
        const ma = moving(a), mb = moving(b);
        if (!a.fault && !b.fault && !ma && !mb) continue;
        if (a.wreck && b.wreck) continue;
        if (Math.abs(a.pose.y - b.pose.y) > 2) continue;              // different levels
        if (Math.abs(a.pose.x - b.pose.x) > 6 || Math.abs(a.pose.z - b.pose.z) > 6) continue;
        if (overlap(obb(a), obb(b))) this.crash(a.fault || ma ? a : b, a.fault || ma ? b : a);
      }
    }

    // wreck dynamics: slide, spin down, hazard lights, smoke, then clear away
    for (const v of vehicles) {
      const w = v.wreck;
      if (!w) continue;
      w.t += dt;
      const sp = Math.hypot(w.vx, w.vz);
      const dec = 7.5 * dt;
      if (sp > dec) { w.vx -= (w.vx / sp) * dec; w.vz -= (w.vz / sp) * dec; } else { w.vx = 0; w.vz = 0; }
      w.omega *= Math.exp(-2.8 * dt);
      const ox = v.pose.x, oz = v.pose.z, oh = v.pose.heading;
      v.pose.x += w.vx * dt;
      v.pose.z += w.vz * dt;
      v.pose.heading += w.omega * dt;
      // the AV is an immovable obstacle for a sliding wreck
      if ((w.vx || w.vz || w.omega) && ego && Math.abs(ego.pose.y - v.pose.y) < 2 && overlap(obb(v), obb(ego))) {
        v.pose.x = ox; v.pose.z = oz; v.pose.heading = oh;
        w.vx = w.vz = w.omega = 0;
      }
      // on the expressway the parapets and the median barrier keep a wreck on the deck
      if (w.lane && w.lane.elevated) {
        const pr = w.lane.project(v.pose.x, v.pose.z);
        const ls = w.lane.sample(Math.min(pr.s, w.lane.length), {});
        const rel = v.pose.heading - ls.heading;
        const ext = Math.abs(Math.sin(rel)) * v.length / 2 + Math.abs(Math.cos(rel)) * v.width / 2;   // body half-width across the lane
        // room from the lane centre to the median barrier (left) and the parapet (right)
        const [room0, room1] = w.lane.kind === 'ramp' ? [3.95, 3.95] : w.lane.index === 0 ? [1.9, 5.85] : [5.4, 2.35];
        if (pr.d + ext > room1 || pr.d - ext < -room0) {
          v.pose.x = ox; v.pose.z = oz; v.pose.heading = oh;
          w.vx *= 0.3; w.vz *= 0.3; w.omega *= 0.4;
        }
        v.pose.y = ls.y;
      }
      v.pose.vx = w.vx;
      v.pose.vz = w.vz;
      v.obj.position.set(v.pose.x, v.pose.y, v.pose.z);
      v.obj.rotation.set(0, v.pose.heading, w.roll);
      v.mats[MAT.BRAKE] = Math.floor(time * 3) % 2 ? Materials.brakeOn : Materials.brakeOff;
      if (w.smoke > 0) {
        w.smoke -= dt;
        if (this.smokeList.length < 240 && random() < dt * 12) {
          this.smokeList.push({ x: v.pose.x + Math.sin(v.pose.heading) * v.length * 0.35, y: v.pose.y + 0.9, z: v.pose.z + Math.cos(v.pose.heading) * v.length * 0.35, vy: rand(0.6, 1.2), life: 0, max: rand(2, 3.5), s: rand(0.25, 0.4), wx: rand(0.2, 0.9), wz: rand(-0.3, 0.5) });
        }
      }
      if (w.triangle && w.t > w.triAt) w.triangle.visible = true;
    }
    // separate wrecks that ended up overlapping
    const wrecks = vehicles.filter((v) => v.wreck);
    for (let i = 0; i < wrecks.length; i++) {
      for (let j = i + 1; j < wrecks.length; j++) {
        const a = wrecks[i], b = wrecks[j];
        if (!overlap(obb(a), obb(b))) continue;
        let nx = b.pose.x - a.pose.x, nz = b.pose.z - a.pose.z;
        const nl = Math.hypot(nx, nz) || 1;
        a.pose.x -= (nx / nl) * 0.05; a.pose.z -= (nz / nl) * 0.05;
        b.pose.x += (nx / nl) * 0.05; b.pose.z += (nz / nl) * 0.05;
      }
    }
    // tow away: a puff of smoke and the wreck shrinks out
    for (const v of wrecks) {
      const w = v.wreck;
      if (w.t < w.clear) continue;
      if (!w.towing) { w.towing = true; this.puff(v, 12); }
      const k = 1 - (w.t - w.clear) / 0.7;
      if (k > 0) { v.obj.scale.setScalar(Math.max(0.02, k)); continue; }
      if (v.wreck.triangle) this.group.remove(v.wreck.triangle);
      this.debrisList = this.debrisList.filter((d) => d.owner !== v);
      this.log('cleared', [v.id], v.pose.x, v.pose.z);
      this.traffic.remove(v);
    }
    this.wrecks = vehicles.filter((v) => v.wreck);
    this.updateParticles(dt);
  }

  updateParticles(dt) {
    const m = this._m, q = this._q, sc = new THREE.Vector3(), p = new THREE.Vector3();
    let n = 0;
    for (const d of this.debrisList) {
      if (d.y > d.ground + d.s / 2 || d.vy > 0) {
        d.vy -= 9.8 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.r += dt * 6;
        if (d.y < d.ground + d.s / 2) { d.y = d.ground + d.s / 2; d.vy = 0; d.vx *= 0.3; d.vz *= 0.3; }
      }
      q.setFromEuler(new THREE.Euler(d.r, d.r * 0.7, 0));
      m.compose(p.set(d.x, d.y, d.z), q, sc.setScalar(d.s));
      this.debris.setMatrixAt(n, m);
      this.debris.setColorAt(n, d.col);
      n++;
    }
    this.debris.count = n;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    let k = 0;
    this.smokeList = this.smokeList.filter((s) => (s.life += dt) < s.max);
    for (const s of this.smokeList) {
      s.y += s.vy * dt;
      s.x += (s.wx || 0) * dt * Math.min(1, s.life);      // drifts in the wind as it rises
      s.z += (s.wz || 0) * dt * Math.min(1, s.life);
      const g = s.s * (1 + s.life * 0.9) * (1 - Math.pow(s.life / s.max, 3));
      q.identity();
      m.compose(p.set(s.x, s.y, s.z), q, sc.setScalar(g));
      this.smoke.setMatrixAt(k++, m);
    }
    this.smoke.count = k;
    this.smoke.instanceMatrix.needsUpdate = true;
  }

  puff(v, n) {
    for (let i = 0; i < n && this.smokeList.length < 240; i++) {
      this.smokeList.push({ x: v.pose.x + rand(-1.3, 1.3), y: v.pose.y + rand(0.3, 1.1), z: v.pose.z + rand(-1.3, 1.3),
        vy: rand(0.3, 0.8), life: 0, max: rand(0.8, 1.5), s: rand(0.5, 0.85) });
    }
  }

  /** A speeding driver loses control in a curve and spins into the parapet (single-vehicle crash). */
  spinOut(v) {
    const h = v.pose.heading, sp = v.v;
    const ahead = v.lane.sample(Math.min(v.lane.length, v.s + 3), {});
    const turn = Math.atan2(Math.sin(ahead.heading - h), Math.cos(ahead.heading - h));
    const side = turn >= 0 ? 1 : -1;                       // slides to the outside of the curve
    const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
    v.wreck = { vx: (fx * 0.85 + rx * side * 0.35) * sp, vz: (fz * 0.85 + rz * side * 0.35) * sp, omega: side * rand(2.2, 3.2),
      roll: rand(-0.06, 0.06), t: 0, clear: WRECK_TIME + rand(-8, 8), lane: v.lane };
    v.fault = null;
    v.v = 0;
    v.a = 0;
    v.lc = null;
    this.stats.collisions++;
    this.log('collision', [v.id], v.pose.x, v.pose.z, { kind: 'loss_of_control', cause: 'speeding', at_fault: v.id, rel_speed: +sp.toFixed(2), elevated: v.pose.y > 2 });
    this.burst(v, v.pose.x, v.pose.z, sp * 0.6);
    this.placeTriangle(v.lane, v);
  }

  /** A driver at fault on course to hit the AV within 2 s (logged once as a near miss). */
  threatensEgo(v) {
    const e = this.traffic.ego;
    if (!e || Math.abs(e.pose.y - v.pose.y) > 2) return false;
    if (Math.abs(e.pose.x - v.pose.x) > 45 || Math.abs(e.pose.z - v.pose.z) > 45) return false;
    const at = (u, t, grow) => {
      const b = obb(u);
      b.x += b.fx * u.v * t;
      b.z += b.fz * u.v * t;
      b.hl += grow;
      b.hw += grow;
      return b;
    };
    for (let t = 0; t <= 2.0001; t += 0.25) {
      if (!overlap(at(v, t, 0.7), at(e, t, 0.2))) continue;
      if (!v.nearMissLogged) {
        v.nearMissLogged = true;
        this.log('near_miss', [v.id], v.pose.x, v.pose.z, { with_av: true, cause: v.fault.type, ttc: +t.toFixed(2) });
      }
      return true;
    }
    return false;
  }

  /** Wrecks blocking `lane` beyond arc length sFrom: [{ s, veh }] (nearest first). */
  blocking(lane, sFrom, width) {
    if (!this.wrecks.length) return null;
    let best = null;
    for (const v of this.wrecks) {
      const pr = lane.project(v.pose.x, v.pose.z);
      if (pr.s < sFrom - 1 || pr.s > lane.length + 2) continue;
      if (Math.abs(v.pose.y - (lane.yProfile ? lane.yProfile(pr.s / lane.length) : lane.y)) > 3) continue;  // other level
      const reach = Math.max(v.width, v.length * 0.75) / 2 + width / 2 + 0.4;
      // true distance to the lane, not just the sideways offset: past either end of the lane the
      // projection sticks to the end point, and a wreck far behind (or far beyond) a lane but in line
      // with it would otherwise look as if it sat right on it
      if (pr.dist > reach) continue;
      const s = pr.s - v.length / 2;
      if (!best || s < best.s) best = { s, veh: v };
    }
    return best;
  }
}
