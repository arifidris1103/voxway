// Voxel pedestrians: sidewalk wandering, signalised crossings and mid-block
// jaywalking. "Hoppers" cross in Crossy-Road-style hops and sometimes hesitate
// mid-road - the behaviour the AV has to predict.

import * as THREE from 'three';
import { WALK, LAYOUT, roadHalfWidth } from '../world/RoadNetwork.js';
import { Npc } from './NpcRig.js';
import { random } from './Random.js';

export const NPC_KEYS = [
  'npcs/npc_bob', 'npcs/npc_glasses', 'npcs/npc_griller', 'npcs/npc_hoodie', 'npcs/npc_pony', 'npcs/npc_student',
  'npcs/npc_courier', 'npcs/npc_worker', 'npcs/npc_elder', 'npcs/npc_jogger', 'npcs/npc_kid',
];

const HOP_DUR = 0.42, HOP_LEN = 1.05, HOP_H = 0.38;
let PID = 1;
const rand = (a, b) => a + random() * (b - a);

class Ped {
  constructor(asset, opts = {}) {
    this.id = PID++;
    this.key = asset.key;
    this.rig = new Npc(asset);
    this.obj = this.rig.root;
    this.state = 'walk';
    this.style = opts.style || (random() < 0.32 ? 'hopper' : 'walker');
    const k = asset.key;
    this.speed = k.endsWith('elder') ? rand(0.75, 0.95) : k.endsWith('jogger') ? rand(2.4, 2.9) : k.endsWith('kid') ? rand(1.2, 1.6) : rand(1.15, 1.5);
    this.reckless = this.style === 'hopper' ? random() < 0.7 : random() < 0.15;
    this.jayRate = this.style === 'hopper' ? 0.010 : 0.0025;
    this.pos = { x: 0, z: 0 };
    this.y = 0.15;
    this.heading = 0;
    this.vel = { x: 0, z: 0 };
    this.lat = rand(-0.6, 1.4);
    this.latCur = this.lat;
    this.timer = 0;
    this.hop = null;
    this.anim = 'walk';
    this.radius = 0.35;
    this.length = 0.5;
    this.width = 0.6;
    this.height = this.rig.height;
  }
}

export class Pedestrians {
  constructor(scene, net, assets, { count = 90 } = {}) {
    this.scene = scene;
    this.net = net;
    this.assets = assets;
    this.count = count;
    this.peds = [];
    this.roadPeds = [];
    this.group = new THREE.Group();
    this.group.name = 'pedestrians';
    scene.add(this.group);
    this.focus = new THREE.Vector3();      // camera: pedestrians far from it are simulated but not drawn
    this.anchor = new THREE.Vector3();     // the AV: only used for simulation decisions, so a seeded
                                           // run doesn't depend on where the camera is
    this.sidewalks = net.walk.edges.filter((e) => e.kind === 'sidewalk');
    this.stats = { jaywalks: 0, crossings: 0 };
    this.avenues = LAYOUT.avenues.map((a) => ({ x: a.x, hw: roadHalfWidth(a), median: a.median }));
    this.streets = LAYOUT.streets.map((s) => ({ z: s.z, hw: roadHalfWidth(s) }));
  }

  /** Is (x, z) on carriageway (not sidewalk / median)? */
  onRoad(x, z) {
    const B = LAYOUT.bounds + 40;
    if (Math.abs(x) > B || Math.abs(z) > B) return false;
    for (const s of this.streets) if (Math.abs(z - s.z) < s.hw) return true;
    for (const a of this.avenues) {
      const d = Math.abs(x - a.x);
      if (d < a.hw && d >= a.median / 2) return true;
      if (d < a.median / 2) return this.streets.some((s) => Math.abs(z - s.z) < s.hw + 13);
    }
    return false;
  }

  spawnAll(blocks) {
    const keys = NPC_KEYS.filter((k) => this.assets[k] && !k.endsWith('worker'));
    const edges = this.sidewalks.filter((e) => Math.abs(e.a.x) < 230 && Math.abs(e.a.z) < 230);
    for (let i = 0; i < this.count; i++) {
      const p = new Ped(this.assets[keys[i % keys.length]]);
      const e = edges[Math.floor(random() * edges.length)];
      p.edge = e;
      p.t = rand(5, e.len - 5);
      p.fwd = random() < 0.5 ? 1 : -1;
      this.add(p);
    }
    // park strollers on the loop path
    const park = blocks.find((b) => b.parkLoop);
    if (park) {
      for (let i = 0; i < 10; i++) {
        const p = new Ped(this.assets[keys[(i * 3) % keys.length]], { style: 'walker' });
        p.state = 'park';
        p.loop = park.parkLoop;
        p.ang = random() * Math.PI * 2;
        p.dirA = random() < 0.5 ? 1 : -1;
        p.lat = rand(-0.6, 0.6);
        this.add(p);
      }
    }
    // road workers inside the lane closure
    const C = this.net.closure;
    if (C && this.assets['npcs/npc_worker']) {
      for (let i = 0; i < 3; i++) {
        const p = new Ped(this.assets['npcs/npc_worker'], { style: 'walker' });
        p.state = 'work';
        p.zone = 'work';
        const s = C.s0 + 8 + i * 14;
        const q = C.lane.sample(s, {});
        p.pos.x = q.x; p.pos.z = q.z;
        p.home = { x: q.x, z: q.z, hx: q.hx, hz: q.hz };
        p.heading = random() * Math.PI * 2;
        p.y = 0.0;
        this.add(p);
      }
    }
  }

  add(p) {
    this.peds.push(p);
    this.group.add(p.obj);
    if (p.edge) this.placeOnEdge(p);
  }

  // -------------------------------------------------------------- geometry
  edgeFrame(e, fwd) {
    const ux = (e.b.x - e.a.x) / e.len, uz = (e.b.z - e.a.z) / e.len;
    let nx = -uz, nz = ux;                             // left normal of a->b
    if (e.kind === 'sidewalk') { nx = -e.toRoad.x; nz = -e.toRoad.z; } // away from the road
    return { ux, uz, nx, nz };
  }

  placeOnEdge(p) {
    const e = p.edge;
    const f = this.edgeFrame(e);
    const lat = e.kind === 'corner' ? 0 : p.latCur;
    p.pos.x = e.a.x + f.ux * p.t + f.nx * lat;
    p.pos.z = e.a.z + f.uz * p.t + f.nz * lat;
    p.heading = Math.atan2(f.ux * p.fwd, f.uz * p.fwd);
  }

  nextEdge(p, node) {
    const opts = node.edges.filter((e) => e !== p.edge);
    if (!opts.length) return p.edge;                    // dead end: turn around
    // prefer sidewalks, sometimes cross the street
    const w = opts.map((e) => (e.kind === 'crosswalk' ? 0.55 : 1));
    let r = random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return opts[i]; }
    return opts[0];
  }

  enterEdge(p, e, node) {
    p.edge = e;
    p.fwd = e.a === node ? 1 : -1;
    p.t = p.fwd > 0 ? 0 : e.len;
    if (e.kind === 'crosswalk') {
      p.state = 'wait';
      p.cw = e.cw;
      p.lat = rand(-1.4, 1.4);
      p.timer = 0;
    } else {
      p.state = 'walk';
      p.lat = e.kind === 'sidewalk' ? rand(-0.6, 1.4) : 0;
    }
  }

  // -------------------------------------------------------------- hopping
  startHop(p, tx, tz) {
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const d = Math.hypot(dx, dz);
    const len = Math.min(HOP_LEN, d);
    p.hop = { u: 0, fx: p.pos.x, fz: p.pos.z, tx: p.pos.x + (dx / d) * len, tz: p.pos.z + (dz / d) * len, pause: 0 };
    p.heading = Math.atan2(dx, dz);
  }

  /** Advance a hop; returns true when the ped reached (tx, tz). */
  stepHop(p, dt, tx, tz) {
    if (!p.hop) {
      if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < 0.05) return true;
      // never hop into a car (stopped traffic, a wreck, the AV): wait until it moves
      const dx = tx - p.pos.x, dz = tz - p.pos.z, d = Math.hypot(dx, dz), len = Math.min(HOP_LEN, d);
      if (this.stepBlocked(p, p.pos.x + (dx / d) * len, p.pos.z + (dz / d) * len)) {
        p.blockedT = (p.blockedT || 0) + dt;
        p.rig.hop = 0;
        p.hopY = 0;
        return false;
      }
      p.blockedT = 0;
      this.startHop(p, tx, tz);
    }
    const h = p.hop;
    if (h.pause > 0) {
      h.pause -= dt;
      p.rig.hop = 0;
      if (h.pause <= 0) p.hop = null;
      return false;
    }
    h.u += dt / HOP_DUR;
    const u = Math.min(1, h.u);
    const e = u * u * (3 - 2 * u);
    const ox = p.pos.x, oz = p.pos.z;
    p.pos.x = h.fx + (h.tx - h.fx) * e;
    p.pos.z = h.fz + (h.tz - h.fz) * e;
    p.vel.x = (p.pos.x - ox) / dt;
    p.vel.z = (p.pos.z - oz) / dt;
    p.hopY = 4 * HOP_H * u * (1 - u);
    p.rig.hop = u;
    if (u >= 1) {
      p.hopY = 0;
      h.pause = p.reckless ? rand(0.05, 0.16) : rand(0.12, 0.3);
      // hesitation mid-road: the classic prediction headache
      if (p.state === 'jaycross' && random() < 0.08) h.pause += rand(0.6, 1.4);
      if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < 0.05) { p.hop = null; return true; }
    }
    return false;
  }

  // -------------------------------------------------------------- queries
  /** Does any pedestrian on crosswalk `cw` conflict with a vehicle crossing it at lane(sMid)? */
  blocksCrosswalk(cw, lane, sMid, veh) {
    if (!cw.peds.length) return false;
    const P = lane.sample(sMid, {});
    const half = veh.width / 2 + 1.4;
    for (const p of cw.peds) {
      const d = cw.axis === 'x' ? p.pos.x - P.x : p.pos.z - P.z;
      const v = cw.axis === 'x' ? p.vel.x : p.vel.z;
      if (Math.abs(d) < half) return true;
      if (d * v < 0 && Math.abs(d) < half + Math.abs(v) * 3.5) return true;
      if (p.state === 'wait' && Math.abs(d) < half + 1.5) return true;
    }
    return false;
  }

  /** Nearest pedestrian standing in `lane` ahead of arc length sFrom. */
  inLane(lane, sFrom, veh) {
    let best = null;
    for (const p of this.roadPeds) {
      const pr = lane.project(p.pos.x, p.pos.z);
      if (pr.s < sFrom - 0.5 || pr.s > lane.length) continue;
      if (Math.abs(pr.d) > veh.width / 2 + 0.75) continue;
      if (!best || pr.s < best.s) best = { s: pr.s, ped: p };
    }
    return best;
  }

  /** Make a pedestrian jaywalk in front of a point on the AV's route. */
  forceJaywalk(target) {
    let best = null, bd = Infinity;
    for (const e of this.sidewalks) {
      if (e.roadWidth > 16) continue;
      const ux = (e.b.x - e.a.x) / e.len, uz = (e.b.z - e.a.z) / e.len;
      const t = Math.max(25, Math.min(e.len - 25, (target.x - e.a.x) * ux + (target.z - e.a.z) * uz));
      const d = Math.hypot(e.a.x + ux * t - target.x, e.a.z + uz * t - target.z);
      if (d < bd) { bd = d; best = { e, t }; }
    }
    if (!best || bd > 20) return null;
    // prefer someone already walking nearby on either side of that street
    let ped = null, pd = 35;
    for (const p of this.peds) {
      if (p.state !== 'walk' || (p.edge !== best.e && p.edge !== best.e.opposite)) continue;
      const d = Math.abs(p.t - best.t);
      if (d < pd && p.t > 20 && p.t < p.edge.len - 20) { pd = d; ped = p; }
    }
    if (!ped) {
      // otherwise bring in someone who is out of view (far from the AV)
      for (const p of this.peds) {
        if (p.state !== 'walk') continue;
        if (Math.hypot(p.pos.x - this.anchor.x, p.pos.z - this.anchor.z) < 170) continue;
        ped = p;
        ped.edge = random() < 0.5 ? best.e : best.e.opposite;
        ped.t = best.t;
        ped.latCur = ped.lat = 0.4;
        this.placeOnEdge(ped);
        break;
      }
    }
    if (!ped) return null;
    ped.style = random() < 0.7 ? 'hopper' : 'walker';
    ped.reckless = true;
    this.beginJaywalk(ped, rand(0.4, 1.4));
    return ped;
  }

  /** Vehicle whose footprint (plus a margin) contains (x, z), if any. */
  carAt(x, z, margin = 0.35) {
    for (const v of this.vehicles || []) {
      if (v.lane.elevated) continue;
      const dx = x - v.pose.x, dz = z - v.pose.z;
      if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;
      const fx = Math.sin(v.pose.heading), fz = Math.cos(v.pose.heading);
      if (Math.abs(dx * fx + dz * fz) < v.length / 2 + margin && Math.abs(dz * fx - dx * fz) < v.width / 2 + margin) return v;
    }
    return null;
  }

  /** Is (x, z) in the path of moving vehicle `v`, closer than it can stop? */
  inPath(v, x, z) {
    const dx = x - v.pose.x, dz = z - v.pose.z;
    const fx = Math.sin(v.pose.heading), fz = Math.cos(v.pose.heading);
    const lon = dx * fx + dz * fz, lat = Math.abs(dz * fx - dx * fz);
    return lat < v.width / 2 + 0.7 && lon > 0 && lon - v.length / 2 < (v.v * v.v) / (2 * 5.5) + 2.5;
  }

  /**
   * Should a pedestrian at p.pos not step to (x, z)? True when it would walk into a car's body
   * (one it is not already touching - it can always walk out of a car), or step into the path of
   * a car that could no longer stop. Reckless people still step out in front of cars that can.
   */
  stepBlocked(p, x, z) {
    const here = this.carAt(p.pos.x, p.pos.z, 0.2);
    const there = this.carAt(x, z);
    if (there && there !== here) return true;
    for (const v of this.vehicles || []) {
      if (v.lane.elevated || v.wreck || v.v < 1) continue;
      if (Math.abs(x - v.pose.x) > 40 || Math.abs(z - v.pose.z) > 40) continue;
      if (this.inPath(v, x, z) && !this.inPath(v, p.pos.x, p.pos.z)) return true;
    }
    return false;
  }

  /** Bystanders stop and look when something happens nearby (e.g. a crash). */
  gawk(x, z, radius) {
    for (const p of this.peds) {
      if ((p.state !== 'walk' && p.state !== 'idle') || Math.hypot(p.pos.x - x, p.pos.z - z) > radius) continue;
      if (random() < 0.25) continue;
      p.state = 'watch';
      p.timer = rand(7, 15);
      p.watchAt = { x, z };
    }
  }

  beginJaywalk(p, wait) {
    const e = p.edge;
    const o = e.opposite;
    if (!o) return;
    p.state = 'jaywait';
    p.timer = wait;
    p.heading = Math.atan2(e.toRoad.x, e.toRoad.z);
    const f = this.edgeFrame(e);
    // step to the kerb first
    p.kerb = { x: e.a.x + f.ux * p.t + e.toRoad.x * 1.9, z: e.a.z + f.uz * p.t + e.toRoad.z * 1.9 };
    const ux = (o.b.x - o.a.x) / o.len, uz = (o.b.z - o.a.z) / o.len;
    p.cross = { x: o.a.x + ux * p.t + o.toRoad.x * 1.6, z: o.a.z + uz * p.t + o.toRoad.z * 1.6, edge: o };
    p.jayBack = { x: p.kerb.x, z: p.kerb.z, edge: e };
    p.blockedT = 0;
    this.stats.jaywalks++;
  }

  /** Any vehicle close to the ped's crossing line? (careful jaywalkers wait) */
  trafficNear(p, vehicles) {
    for (const v of vehicles) {
      if (v.lane.elevated) continue;
      const d = Math.hypot(v.pose.x - p.pos.x, v.pose.z - p.pos.z);
      if (d < 32 && v.v > 2) {
        const toPed = (p.pos.x - v.pose.x) * Math.sin(v.pose.heading) + (p.pos.z - v.pose.z) * Math.cos(v.pose.heading);
        if (toPed > -3) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- update
  update(dt, vehicles, time) {
    this.vehicles = vehicles;
    for (const c of this.net.crosswalks) c.peds.length = 0;
    this.roadPeds.length = 0;

    for (const p of this.peds) {
      const ox = p.pos.x, oz = p.pos.z;
      p.hopY = p.hopY || 0;
      let anim = 'walk', animSpeed = p.speed;

      if (p.state === 'walk') {
        const e = p.edge;
        p.t += p.speed * p.fwd * dt;
        p.latCur += (p.lat - p.latCur) * Math.min(1, dt * 1.5);
        if (p.t >= e.len || p.t <= 0) {
          const node = p.t >= e.len ? e.b : e.a;
          p.t = Math.max(0, Math.min(e.len, p.t));
          this.enterEdge(p, this.nextEdge(p, node), node);
        } else if (e.kind === 'sidewalk' && e.roadWidth <= 16 && p.t > 25 && p.t < e.len - 25 &&
                   random() < p.jayRate * dt) {
          this.beginJaywalk(p, rand(0.8, 2.4));
        } else if (random() < 0.0015 * dt * 60 && e.kind === 'sidewalk') {
          p.state = 'idle';
          p.timer = rand(1.5, 5);
        }
        if (p.state === 'walk' || p.state === 'wait') this.placeOnEdge(p);
        if (p.state === 'wait') anim = 'wait';
      } else if (p.state === 'watch') {
        anim = 'wait';
        p.heading = Math.atan2(p.watchAt.x - p.pos.x, p.watchAt.z - p.pos.z);
        p.timer -= dt;
        if (p.timer <= 0) p.state = 'walk';
      } else if (p.state === 'idle') {
        p.timer -= dt;
        anim = 'idle';
        if (p.timer <= 0) p.state = 'walk';
      } else if (p.state === 'wait') {
        anim = 'wait';
        const w = p.cw.walk();
        const go = w === WALK.WALK || (p.reckless && w === WALK.FLASH && random() < 0.02);
        // face across the street while waiting
        const e = p.edge;
        p.heading = Math.atan2((e.b.x - e.a.x) * p.fwd, (e.b.z - e.a.z) * p.fwd);
        if (go) { p.state = 'cross'; this.stats.crossings++; }
      } else if (p.state === 'cross') {
        const e = p.edge;
        const f = this.edgeFrame(e);
        if (p.style === 'hopper') {
          const end = p.fwd > 0 ? e.len : 0;
          const tx = e.a.x + f.ux * end + f.nx * p.lat, tz = e.a.z + f.uz * end + f.nz * p.lat;
          anim = 'hop';
          if (this.stepHop(p, dt, tx, tz)) {
            p.t = end;
            this.enterEdge(p, this.nextEdge(p, p.fwd > 0 ? e.b : e.a), p.fwd > 0 ? e.b : e.a);
          } else if (p.blockedT > 0) {
            anim = 'wait';
            if (p.blockedT > 5) { p.fwd = -p.fwd; p.blockedT = 0; }
          }
        } else {
          const hurry = p.cw.walk() === WALK.WALK ? 1 : 1.35;
          const ahead = p.t + 0.45 * p.fwd;
          if (this.stepBlocked(p, e.a.x + f.ux * ahead + f.nx * p.latCur, e.a.z + f.uz * ahead + f.nz * p.latCur)) {
            p.blockedT = (p.blockedT || 0) + dt;
            if (p.blockedT > 5) { p.fwd = -p.fwd; p.blockedT = 0; }
            anim = 'wait';
          } else {
            p.blockedT = 0;
            p.t += p.speed * hurry * p.fwd * dt;
            p.latCur += (p.lat - p.latCur) * Math.min(1, dt * 2);
            animSpeed = p.speed * hurry;
            if (p.t >= e.len || p.t <= 0) {
              const node = p.t >= e.len ? e.b : e.a;
              p.t = Math.max(0, Math.min(e.len, p.t));
              this.enterEdge(p, this.nextEdge(p, node), node);
            }
          }
          this.placeOnEdge(p);
        }
        if (p.cw) p.cw.peds.push(p);
      } else if (p.state === 'jaywait') {
        anim = 'walk';
        animSpeed = 0.9;
        const dx = p.kerb.x - p.pos.x, dz = p.kerb.z - p.pos.z, d = Math.hypot(dx, dz);
        if (d > 0.05) {
          const st = Math.min(d, 0.9 * dt);
          p.pos.x += (dx / d) * st; p.pos.z += (dz / d) * st;
          p.heading = Math.atan2(dx, dz);
        } else {
          anim = 'wait';
          p.heading = Math.atan2(p.edge.toRoad.x, p.edge.toRoad.z);
          p.timer -= dt;
          if (p.timer <= 0 && (p.reckless || !this.trafficNear(p, vehicles))) p.state = 'jaycross';
          if (p.timer < -12) p.state = 'walk';          // gave up
        }
      } else if (p.state === 'jaycross') {
        const T = p.cross;
        if (p.style === 'hopper') {
          anim = 'hop';
          if (this.stepHop(p, dt, T.x, T.z)) this.finishJaywalk(p);
          else if (p.blockedT > 0) anim = 'wait';
        } else {
          anim = 'run';
          const dx = T.x - p.pos.x, dz = T.z - p.pos.z, d = Math.hypot(dx, dz);
          const sp = Math.max(1.7, p.speed * 1.25);
          animSpeed = sp;
          if (d < sp * dt) this.finishJaywalk(p);
          else if (this.stepBlocked(p, p.pos.x + (dx / d) * 0.6, p.pos.z + (dz / d) * 0.6)) { p.blockedT += dt; anim = 'wait'; }
          else { p.blockedT = 0; p.pos.x += (dx / d) * sp * dt; p.pos.z += (dz / d) * sp * dt; p.heading = Math.atan2(dx, dz); }
        }
        // a car is in the way for too long: go back to the kerb we came from
        if (p.state === 'jaycross' && p.blockedT > 2.5) {
          const t = p.cross;
          p.cross = p.jayBack;
          p.jayBack = t;
          p.blockedT = 0;
          p.hop = null;
        }
        if (p.state === 'jaycross') this.roadPeds.push(p);
      } else if (p.state === 'park') {
        const L = p.loop;
        p.ang += (p.dirA * p.speed * 0.8 * dt) / ((L.rx + L.rz) / 2);
        const r = 1 + p.lat / ((L.rx + L.rz) / 2);
        p.pos.x = L.cx + Math.cos(p.ang) * L.rx * r;
        p.pos.z = L.cz + Math.sin(p.ang) * L.rz * r;
        const tx = -Math.sin(p.ang) * L.rx * p.dirA, tz = Math.cos(p.ang) * L.rz * p.dirA;
        p.heading = Math.atan2(tx, tz);
        animSpeed = p.speed * 0.8;
        p.y = 0.16;
      } else if (p.state === 'work') {
        anim = 'idle';
        p.timer -= dt;
        if (p.timer <= 0) { p.timer = rand(2, 6); p.heading += rand(-1.5, 1.5); }
      }

      if (p.state !== 'park' && p.state !== 'work') {
        const onRoad = this.onRoad(p.pos.x, p.pos.z);
        p.y += ((onRoad ? 0.0 : 0.15) - p.y) * Math.min(1, dt * 12);
      }
      if (!p.hop) {
        p.vel.x = (p.pos.x - ox) / Math.max(dt, 1e-4);
        p.vel.z = (p.pos.z - oz) / Math.max(dt, 1e-4);
      }
      p.anim = anim;
      // render (far pedestrians are simulated but hidden)
      const far = Math.abs(p.pos.x - this.focus.x) > 170 || Math.abs(p.pos.z - this.focus.z) > 170;
      p.obj.visible = !far;
      if (!far) {
        p.obj.position.set(p.pos.x, p.y + (p.hopY || 0), p.pos.z);
        p.obj.rotation.y = p.heading;
        p.rig.update(dt, anim, animSpeed);
      }
    }
  }

  finishJaywalk(p) {
    const o = p.cross.edge;
    p.edge = o;
    const ux = (o.b.x - o.a.x) / o.len, uz = (o.b.z - o.a.z) / o.len;
    p.t = Math.max(1, Math.min(o.len - 1, (p.pos.x - o.a.x) * ux + (p.pos.z - o.a.z) * uz));
    p.fwd = random() < 0.5 ? 1 : -1;
    p.latCur = -1.6;
    p.lat = rand(-0.4, 1.2);
    p.hop = null;
    p.hopY = 0;
    p.state = 'walk';
  }
}
