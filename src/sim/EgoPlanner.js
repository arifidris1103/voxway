// The ego AV: route following, lane choice, and a prediction-aware yielding layer
// on top of the normal traffic rules. Also draws what the AV "thinks".

import * as THREE from 'three';
import { idm } from './Traffic.js';
import { BaselinePredictor, History } from './Predictor.js';
import { random } from './Random.js';

// The AV's loop mixes city streets and the expressway. On the ground: protected left turns,
// right turns across busy crosswalks, the road-works merge and three passes under the viaduct.
// Then out of town on north_st, off at the west loop ramp and up onto the flyover (a merge at
// speed), past the curved ramps (a diverge and a merge), off at the east loop ramp and back into
// the city on north_st.
export const LOOP = [
  { x: 160, z: -150, dir: 'WB', move: 'left' },
  { x: 160, z: 0, dir: 'SB', move: 'straight' },
  { x: 160, z: 150, dir: 'SB', move: 'right' },
  { x: 0, z: 150, dir: 'WB', move: 'straight' },
  { x: -160, z: 150, dir: 'WB', move: 'right' },
  { x: -160, z: 0, dir: 'NB', move: 'right' },
  { x: 0, z: 0, dir: 'EB', move: 'straight' },
  { x: 160, z: 0, dir: 'EB', move: 'left' },
  { x: 160, z: -150, dir: 'NB', move: 'left' },
  { x: 0, z: -150, dir: 'WB', move: 'straight' },
  { x: -160, z: -150, dir: 'WB', move: 'straight' },   // then the west loop ramp up to the flyover
];

const PATH_LEN = 60;

export class EgoPlanner {
  constructor(net, traffic, peds, scene) {
    this.net = net;
    this.traffic = traffic;
    this.peds = peds;
    this.route = new Map();
    for (const r of LOOP) {
      const I = net.interAt.get(r.x + ',' + r.z);
      this.route.set(I.id + ':' + r.dir, r.move);
    }
    // expressway forks: lanes the loop takes, and the roads that would leave it
    const H = net.highway;
    this.prefer = new Set([H.loopW, H.loopE]);
    this.avoid = new Set([H.rampA, H.rampB, ...H.pastExitW, ...H.flyoverEnd]);
    this._dead = new Map();
    this.history = new History(11);
    this.predictor = new BaselinePredictor();
    this.predictor.setContext({ crosswalks: net.crosswalks });
    this.custom = null;               // user model hook
    this.state = 'CRUISE';
    this.target = null;               // pedestrian we are yielding to
    this.predictions = [];
    this.stats = { pedYields: 0, redStops: 0, merges: 0, distance: 0, minPedGap: Infinity, collisions: 0, crashScenes: 0, reroutes: 0 };
    this._rejoin = new Map();
    this.contacts = [];            // any AV-pedestrian contact, with context (should stay empty)
    this._prevState = '';
    this.viz = new EgoViz(scene);
    this.showPredictions = true;
    this.directorClock = 6;
  }

  movementAt(lane) {
    const I = lane.endInter;
    if (!I) return 'straight';
    const m = this.route.get(I.id + ':' + lane.dir);
    if (m) return m;
    const c = this.rejoin(lane);
    return c ? c.movement : 'straight';
  }

  chooseNext(veh, lane) {
    if (lane.next.length === 1) return lane.next[0];
    if (!lane.endInter && lane.next.length) {          // a fork on the expressway / spiral links
      return lane.next.find((n) => this.prefer.has(n)) || lane.next.find((n) => !this.avoid.has(n)) || lane.next[0];
    }
    const m = lane.endInter && this.route.get(lane.endInter.id + ':' + lane.dir);
    const planned = m && lane.next.find((c) => c.movement === m);
    // off the loop (a missed turn, or a detour around a crash): shortest way back to it
    return planned || this.rejoin(lane) || lane.next.find((c) => c.movement === 'straight') || lane.next[0];
  }

  /** First connector on the shortest path (by length) from the end of `lane` back onto the loop. */
  rejoin(lane) {
    if (this._rejoin.has(lane)) return this._rejoin.get(lane);
    const onLoop = (l) => l.kind === 'road' && l.endInter && this.route.has(l.endInter.id + ':' + l.dir);
    const dist = new Map([[lane, 0]]);
    const first = new Map();
    const open = [lane];
    let found = null;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
      const l = open.splice(bi, 1)[0];
      if (l !== lane && onLoop(l)) { found = first.get(l); break; }
      for (const n of l.next) {
        if (n.elevated) continue;
        const nd = dist.get(l) + n.length;
        if (nd < (dist.get(n) ?? Infinity)) {
          if (!dist.has(n)) open.push(n);
          dist.set(n, nd);
          first.set(n, l === lane ? n : first.get(l));
        }
      }
    }
    this._rejoin.set(lane, found);
    return found;
  }

  /** Does taking connector `c` keep a way back onto the loop (i.e. not a dead end at the map edge)? */
  leadsBack(c) {
    const dep = c.next[0];
    if (!dep) return false;
    return (dep.endInter && this.route.has(dep.endInter.id + ':' + dep.dir)) || !!this.rejoin(dep);
  }

  /** Re-plan when a crash blocks the next junction movement; rejoin() leads back to the loop. */
  avoidBlockedJunction(veh, traffic) {
    const con = veh.path[1];
    if (veh.lane.kind !== 'road' || !con || con.kind !== 'connector' || !traffic.movementBlocked(con, veh)) return;
    const pref = { straight: 0, right: 1, left: 2 };
    const alt = veh.lane.next.filter((c) => c !== con && !traffic.movementBlocked(c, veh) && this.leadsBack(c))
      .sort((a, b) => pref[a.movement] - pref[b.movement]);
    if (!alt.length) return;
    veh.path = [veh.lane, alt[0]];
    traffic.planPath(veh);
    this.stats.reroutes++;
  }

  /**
   * A lane (not ending at a junction) that cannot continue along the loop: it runs into the map
   * edge or only leads on to roads off the loop (directly or a few lane pieces further on).
   */
  deadEnd(lane, depth = 0) {
    if (lane.endInter) return false;
    if (this._dead.has(lane)) return this._dead.get(lane);
    const dead = lane.next.length === 0 || (depth < 8 && lane.next.every((n) => this.avoid.has(n) || this.deadEnd(n, depth + 1)));
    if (depth === 0) this._dead.set(lane, dead);
    return dead;
  }

  /** Length of the dead-end lane pieces after `lane` up to the fork where it has to be left. */
  deadRun(lane) {
    let d = 0;
    for (let l = lane, k = 0; k < 8 && l.next.length === 1 && !this.avoid.has(l.next[0]) && this.deadEnd(l.next[0]); k++) {
      l = l.next[0];
      d += l.length;
    }
    return d;
  }

  /** Lane needed for the next turn or fork (or null when the current lane is fine). */
  desiredLane(veh) {
    const lane = veh.lane;
    if (lane.kind === 'connector' || lane.kind === 'ramp') return null;
    if (lane.closed && veh.s < lane.closed.s1) return null;   // handled as a merge
    if (!lane.endInter) {                                     // expressway / edge of the city
      if (!this.deadEnd(lane)) return null;
      return [lane.right, lane.left].find((l) => l && !this.deadEnd(l)) || null;
    }
    const m = this.movementAt(lane);
    if (lane.next.some((c) => c.movement === m)) return null;
    if (m === 'right') return lane.right;
    if (m === 'left') return lane.left;
    return null;
  }

  /** Path ahead as samples every metre: [{ x, z, d }]. */
  pathAhead(veh) {
    const out = [];
    let lane = 0, s = veh.s;
    const p = {};
    for (let d = 0; d <= PATH_LEN; d += 1) {
      while (lane < veh.path.length && s > veh.path[lane].length) { s -= veh.path[lane].length; lane++; }
      if (lane >= veh.path.length) break;
      veh.path[lane].sample(s, p);
      if (d === 0 && veh.lc) {
        const q = veh.lateral({});
        out.push({ x: q.x, z: q.z, d, hx: p.hx, hz: p.hz });
      } else out.push({ x: p.x, z: p.z, d, hx: p.hx, hz: p.hz });
      s += 1;
    }
    return out;
  }

  predictAll(veh) {
    const near = [];
    for (const p of this.peds.peds) {
      if (p.state === 'park') continue;
      const d = Math.hypot(p.pos.x - veh.pose.x, p.pos.z - veh.pose.z);
      if (d < 55 && Math.abs(p.y - veh.pose.y) < 3) near.push(p);     // same level only
    }
    if (this.custom) {
      try {
        const res = this.custom(near.map((p) => ({ id: p.id, ped: p, history: this.history.get(p) })));
        if (res) return near.map((p, i) => ({ ped: p, hyps: res[i] || [] }));
      } catch (err) {
        console.warn('custom predictor failed, using baseline', err);
        this.custom = null;
      }
    }
    return near.map((p) => ({ ped: p, hyps: this.predictor.predict(p, this.history.get(p)) }));
  }

  control(veh, traffic, v0) {
    this.avoidBlockedJunction(veh, traffic);
    let { acc, reason } = traffic.constraints(veh, v0);
    // in the wrong lane for the next turn, with no other way back to the loop: hold short of the
    // stop line until the lane change succeeds (courteous drivers will open a gap)
    const noWayOn = veh.lane.endInter ? !this.rejoin(veh.lane) : this.deadEnd(veh.lane);
    if (noWayOn && !veh.lc && this.desiredLane(veh)) {
      const toEnd = veh.lane.length - veh.s + (veh.lane.endInter ? 0 : this.deadRun(veh.lane));
      if (toEnd < 35 + veh.v * 2.5) {
        const a = idm(veh.v, v0, Math.max(0.1, toEnd - 2 - veh.length / 2), veh.v, veh);
        if (a < acc) { acc = a; reason = 'waiting to change lanes'; }
      }
    }
    const path = this.pathAhead(veh);
    this.path = path;
    this.predictions = this.predictAll(veh);

    // conflict search: where would a predicted pedestrian be inside our corridor
    // at about the time we get there?
    // Yield when a guess that is likely on its own (p >= 0.3) conflicts, or the pedestrian is in our
    // path already; also when several less likely guesses conflict that add up to 0.3 (a learned
    // model with many guesses spreads its probability over similar paths).
    const half = veh.width / 2 + 0.75;
    let hard = null, soft = null;
    const nearest = (list) => list.reduce((a, c) => (c.d < a.d ? c : a));
    for (const pr of this.predictions) {
      pr.conflict = false;
      if (pr.ped.zone === 'work') continue;
      const found = [];
      for (const h of pr.hyps) {
        const pts = [{ t: 0, x: pr.ped.pos.x, z: pr.ped.pos.z }, ...h.traj];
        for (const q of pts) {
          let best = null, bd = 1e9;
          for (const s of path) {
            const dd = (s.x - q.x) ** 2 + (s.z - q.z) ** 2;
            if (dd < bd) { bd = dd; best = s; }
          }
          if (!best || Math.sqrt(bd) > half || best.d < veh.length / 2 - 0.5) continue;
          const tArrive = best.d / Math.max(veh.v, 2.5);
          if (q.t > tArrive + 2.2 || q.t < tArrive - 1.8 - (q.t === 0 ? 10 : 0)) continue;
          found.push({ d: best.d, ped: pr.ped, prob: h.prob, t: q.t });
          break;
        }
      }
      if (!found.length) continue;
      pr.conflict = true;
      const strong = found.filter((c) => c.prob >= 0.3 || c.t === 0);
      const pSum = found.reduce((sum, c) => sum + c.prob, 0);
      if (strong.length) {
        const c = nearest(strong);
        if (!hard || c.d < hard.d) hard = c;
      } else {
        const c = { ...nearest(found), prob: Math.min(1, pSum) };
        if (pSum >= 0.3) { if (!hard || c.d < hard.d) hard = c; }
        else if (!soft || c.d < soft.d) soft = c;
      }
    }
    this.target = null;
    if (hard) {
      const gap = hard.d - veh.length / 2 - 3.0;
      const a = idm(veh.v, v0, Math.max(0.1, gap), veh.v, veh);
      if (a < acc) { acc = a; reason = 'yield: predicted pedestrian'; }
      this.target = hard;
    } else if (soft) {
      const vcap = Math.sqrt(2 * 2.2 * Math.max(0, soft.d - 6)) + 2.5;
      if (veh.v > vcap) {
        const a = (vcap * vcap - veh.v * veh.v) / (2 * Math.max(4, soft.d - 6));
        if (a < acc) { acc = a; reason = 'caution: pedestrian may cross'; }
      }
      this.target = soft;
    }
    // safety metrics: clearance between each pedestrian and the car's footprint
    const fx = Math.sin(veh.pose.heading), fz = Math.cos(veh.pose.heading);
    for (const pr of this.predictions) {
      const p = pr.ped;
      const dx = p.pos.x - veh.pose.x, dz = p.pos.z - veh.pose.z;
      const lon = Math.abs(dx * fx + dz * fz) - veh.length / 2;
      const lat = Math.abs(dx * fz - dz * fx) - veh.width / 2;
      const d = Math.hypot(Math.max(lon, 0), Math.max(lat, 0)) - p.radius;
      if (p.y < 0.1 && veh.v > 1 && d < this.stats.minPedGap) this.stats.minPedGap = d;
      const touching = d < 0 && p.y < 0.1;
      if (touching && !p._hitByEgo) {
        this.stats.collisions++;
        this.contacts.push({ t: +(this.time || 0).toFixed(1), v: +veh.v.toFixed(2), ped: p.id, state: p.state, style: p.style,
          x: +p.pos.x.toFixed(1), z: +p.pos.z.toFixed(1), reason: veh.reason });
      }
      p._hitByEgo = touching;
    }
    this.reason = reason;
    return { acc, reason };
  }

  /** Called once per frame after physics. */
  update(dt, veh, time) {
    this.time = time;
    this.history.update(dt, this.peds.peds);
    this.stats.distance += veh.v * dt;
    const r = veh.reason || '';
    let st = 'CRUISE';
    if (r === 'accident ahead' || veh.avoiding) st = 'AVOID · CRASH';
    else if (r.startsWith('yield') || r.startsWith('caution')) st = r.startsWith('yield') ? 'YIELD' : 'CAUTION';
    else if (r === 'red light' || r === 'yellow') st = 'STOP · SIGNAL';
    else if (r === 'oncoming traffic') st = 'GIVE WAY';
    else if (r === 'yield crosswalk' || r === 'pedestrian in lane') st = 'YIELD';
    else if (r.startsWith('merge') || veh.lc || veh.wantsLane) st = 'MERGE';
    else if (r === 'following' || r === 'queue' || r === 'letting merge' || r === 'junction busy') st = 'FOLLOW';
    else if (r === 'turn') st = 'TURN';
    if (st !== this._prevState) {
      if (st === 'YIELD') this.stats.pedYields++;
      if (st === 'STOP · SIGNAL') this.stats.redStops++;
      if (st === 'GIVE WAY') this.stats.giveWays = (this.stats.giveWays || 0) + 1;
      if (st === 'AVOID · CRASH') this.stats.crashScenes++;
      if (this._prevState === 'MERGE' && !veh.lc) this.stats.merges++;
      this._prevState = st;
    }
    this.state = st;

    // scenario director: keep sending jaywalkers into the AV's path
    this.directorClock -= dt;
    if (this.directorClock <= 0 && this.path && this.path.length > 50 && veh.pose.y < 2) {
      const q = this.path[Math.min(this.path.length - 1, 45 + Math.floor(random() * 12))];
      const p = this.peds.forceJaywalk(q);
      this.directorClock = p ? 14 + random() * 10 : 3;
    }
    this.viz.update(dt, time, veh, this);
  }
}

// ------------------------------------------------------------------ visuals

class EgoViz {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'ego-viz';
    scene.add(this.group);
    // planned path ribbon
    const n = PATH_LEN + 1;
    this.ribbonGeo = new THREE.BufferGeometry();
    this.ribbonGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    this.ribbonGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.ribbonGeo.setIndex(idx);
    this.ribbon = new THREE.Mesh(this.ribbonGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 2;
    this.group.add(this.ribbon);
    // predicted trajectories (dashed segments)
    const maxSeg = 4000;
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSeg * 2 * 3), 3));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxSeg * 2 * 3), 3));
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.group.add(this.lines);
    // dots at predicted endpoints
    this.dotGeo = new THREE.BufferGeometry();
    this.dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    this.dotGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    this.dots = new THREE.Points(this.dotGeo, new THREE.PointsMaterial({ size: 0.45, vertexColors: true, depthTest: false }));
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 3;
    this.group.add(this.dots);
    // yield target ring
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.0, 40), new THREE.MeshBasicMaterial({ color: 0xff4d2e, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 4;
    this.group.add(this.ring);
    // sensor sweep around the ego
    const sweep = new THREE.CircleGeometry(30, 48, 0, Math.PI / 5);
    this.sweep = new THREE.Mesh(sweep, new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    this.sweep.rotation.x = -Math.PI / 2;
    this.group.add(this.sweep);
    this.range = new THREE.Mesh(new THREE.RingGeometry(29.7, 30, 96), new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
    this.range.rotation.x = -Math.PI / 2;
    this.group.add(this.range);
    this.c = new THREE.Color();
  }

  update(dt, time, veh, plan) {
    const show = plan.showPredictions;
    this.group.visible = show;
    if (!show) return;
    const y0 = veh.pose.y + 0.06;
    // ribbon colour reflects the decision
    const col = plan.state === 'YIELD' || plan.state === 'STOP · SIGNAL' ? 0xff5a3c : plan.state === 'AVOID · CRASH' ? 0xc061ff : plan.state === 'CAUTION' || plan.state === 'MERGE' || plan.state === 'GIVE WAY' ? 0xffb02e : 0x34e3a0;
    this.c.setHex(col);
    const pos = this.ribbonGeo.attributes.position.array;
    const cl = this.ribbonGeo.attributes.color.array;
    const path = plan.path || [];
    const stopD = plan.target && plan.state === 'YIELD' ? plan.target.d - veh.length / 2 - 3 : Infinity;
    for (let i = 0; i <= PATH_LEN; i++) {
      const s = path[Math.min(i, path.length - 1)] || { x: veh.pose.x, z: veh.pose.z, hx: 0, hz: 1, d: 0 };
      const w = 0.9 * (1 - i / (PATH_LEN + 8));
      const rx = -s.hz, rz = s.hx;
      pos.set([s.x - rx * w, y0, s.z - rz * w, s.x + rx * w, y0, s.z + rz * w], i * 6);
      const fade = Math.max(0, 1 - i / PATH_LEN) * (s.d > stopD ? 0.15 : 1);
      for (let k = 0; k < 2; k++) cl.set([this.c.r * fade, this.c.g * fade, this.c.b * fade], i * 6 + k * 3);
    }
    this.ribbonGeo.attributes.position.needsUpdate = true;
    this.ribbonGeo.attributes.color.needsUpdate = true;

    // predicted pedestrian trajectories
    const lp = this.lineGeo.attributes.position.array, lc = this.lineGeo.attributes.color.array;
    const dp = this.dotGeo.attributes.position.array, dc = this.dotGeo.attributes.color.array;
    let n = 0, m = 0;
    for (const pr of plan.predictions) {
      const p = pr.ped;
      for (const h of pr.hyps) {
        const conflict = pr.conflict && h.prob >= 0.12;
        const base = conflict ? [1, 0.3, 0.18] : h.kind === 'cross' || h.kind === 'resume' ? [1, 0.75, 0.2] : [0.3, 0.85, 1];
        let prev = { x: p.pos.x, z: p.pos.z };
        h.traj.forEach((q, k) => {
          if (k % 2 === 0 && n < 3990) {
            const a = 0.35 + 0.65 * h.prob;
            lp.set([prev.x, 0.12 + p.y, prev.z, q.x, 0.12 + p.y, q.z], n * 6);
            lc.set([base[0] * a, base[1] * a, base[2] * a, base[0] * a, base[1] * a, base[2] * a], n * 6);
            n++;
          }
          prev = q;
        });
        const last = h.traj[h.traj.length - 1];
        if (last && m < 599) { dp.set([last.x, 0.14 + p.y, last.z], m * 3); dc.set(base, m * 3); m++; }
      }
    }
    this.lineGeo.setDrawRange(0, n * 2);
    this.lineGeo.attributes.position.needsUpdate = true;
    this.lineGeo.attributes.color.needsUpdate = true;
    this.dotGeo.setDrawRange(0, m);
    this.dotGeo.attributes.position.needsUpdate = true;
    this.dotGeo.attributes.color.needsUpdate = true;

    // target ring
    const t = plan.target;
    this.ring.visible = !!t;
    if (t) {
      const k = 1 + Math.sin(time * 8) * 0.15;
      this.ring.position.set(t.ped.pos.x, t.ped.y + 0.08, t.ped.pos.z);
      this.ring.scale.setScalar(k);
      this.ring.material.color.setHex(plan.state === 'YIELD' ? 0xff4d2e : 0xffb02e);
    }
    this.sweep.position.set(veh.pose.x, y0 + 0.02, veh.pose.z);
    this.sweep.rotation.z = time * 2.4;
    this.range.position.set(veh.pose.x, y0 + 0.02, veh.pose.z);
  }
}
