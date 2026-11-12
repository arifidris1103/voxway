// City layout + lane graph, signals, crosswalks and the sidewalk graph.
//
// World axes (three.js): x = east, y = up, z = south. Vehicles drive on the right.
// Headings: 0 faces +z (south); heading = atan2(dx, dz).
//
// The data model deliberately mirrors the Waymo Open Motion Dataset map features:
// lanes are polylines with entry/exit lanes and speed limits, crosswalks are
// polygons, and signals expose per-lane states with a stop point.

export const LANE_W = 3.5;
const KMH = 1 / 3.6;

export const LAYOUT = {
  bounds: 260,
  avenues: [ // N-S roads (run along z)
    { id: 'west_ave', x: -160, lanes: 2, median: 0, sidewalk: 4.5, speed: 40 * KMH },
    { id: 'boulevard', x: 0, lanes: 3, median: 10, sidewalk: 5, speed: 50 * KMH },
    { id: 'east_ave', x: 160, lanes: 2, median: 0, sidewalk: 4.5, speed: 40 * KMH },
  ],
  streets: [ // E-W roads (run along x)
    { id: 'north_st', z: -150, lanes: 2, median: 0, sidewalk: 4.5, speed: 40 * KMH },
    { id: 'center_st', z: 0, lanes: 2, median: 0, sidewalk: 4.5, speed: 40 * KMH },
    { id: 'south_st', z: 150, lanes: 2, median: 0, sidewalk: 4.5, speed: 40 * KMH },
  ],
  // Both expressways (and north_st under the flyover) carry on out of town and are drawn out to
  // `horizon`, where the fog swallows them; `from` / `to` is the stretch that has traffic on it.
  horizon: 2000,
  // Elevated expressway above the boulevard median (Shanghai style).
  viaduct: { x: 0, lanes: 2, median: 1, height: 12, speed: 70 * KMH, halfWidth: 8.6, from: -420, to: 420 },
  // Second-level flyover above north_st, crossing over the viaduct, joined to it by
  // two curved ramps (flyover EB -> viaduct SB, viaduct NB -> flyover EB).
  flyover: { z: -150, lanes: 2, median: 1, height: 22, speed: 70 * KMH, halfWidth: 8.6, from: -900, to: 900,
    rampRadius: 200, rampSpeed: 55 * KMH, rampHalfWidth: 4.4,
    // loop ramps just outside the city link the flyover to north_st on the ground: an exit lane
    // peels off, curves out by `loopNeck` degrees, loops back through the gap between the two
    // levels and joins the other road with a taper (like a cloverleaf loop)
    loopCentre: 480, loopRadius: 60, loopTurn: 120, loopNeck: 30, loopSpeed: 45 * KMH },
  // north_st beyond the city edge: ground lanes out to `to` (with a 0.5 m shoulder)
  outskirts: { to: 700, shoulder: 0.5 },
  // Road works: the right lane of south_st westbound is closed, so traffic must merge.
  closure: { road: 'south_st', dir: 'WB', lane: 1, x0: 112, x1: 62, taper: 14 },
  crosswalk: { gap: 1.0, width: 4.0 },
  stopGap: 1.5,
};

const DIRS = { SB: { x: 0, z: 1 }, NB: { x: 0, z: -1 }, EB: { x: 1, z: 0 }, WB: { x: -1, z: 0 } };
const rightOf = (f) => ({ x: -f.z, z: f.x });
const leftOf = (f) => ({ x: f.z, z: -f.x });
const dirName = (f) => (f.z > 0.5 ? 'SB' : f.z < -0.5 ? 'NB' : f.x > 0.5 ? 'EB' : 'WB');
export const roadHalfWidth = (r) => r.lanes * LANE_W + r.median / 2;

let LANE_ID = 1;

export class Lane {
  constructor(pts, o) {
    this.id = LANE_ID++;
    this.pts = pts;
    this.y = o.y || 0;
    this.yProfile = o.yProfile || null;   // ramps: height as a function of t in [0, 1]
    this.elevated = !!o.elevated;
    this.speed = o.speed;
    this.kind = o.kind;               // 'road' | 'connector' | 'viaduct'
    this.dir = o.dir;                 // SB / NB / EB / WB (entry direction)
    this.index = o.index ?? 0;        // 0 = leftmost lane
    this.road = o.road || null;
    this.movement = o.movement || 'straight';
    this.next = [];
    this.prev = [];
    this.left = null;
    this.right = null;
    this.signal = null;               // connectors: { inter, group }
    this.endInter = null;             // approach lanes: intersection at the end
    this.conflicts = [];              // [{ cw, s0, s1 }]
    this.closed = null;               // { s0, s1, taper } lane closure (road works)
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    }
    this.length = this.cum[this.cum.length - 1];
    // direction at each point: the average of the two pieces meeting there. sample() blends between
    // them, so a car's heading turns smoothly along a curve instead of jumping at every point.
    const dir = (i) => { const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.z - a.z) || 1; return [(b.x - a.x) / L, (b.z - a.z) / L]; };
    this.tan = pts.map((_, i) => {
      const u = i > 0 ? dir(i) : null, w = i < pts.length - 1 ? dir(i + 1) : null;
      const [x, z] = u && w ? [u[0] + w[0], u[1] + w[1]] : u || w;
      return Math.atan2(x, z);
    });
  }

  /** Position and unit tangent at arc length s (clamped). */
  sample(s, out = {}) {
    const n = this.pts.length;
    s = Math.max(0, Math.min(this.length, s));
    let i = 1;
    let lo = 1, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cum[m] < s) lo = m + 1; else hi = m; }
    i = lo;
    const a = this.pts[i - 1], b = this.pts[i];
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const t = (s - this.cum[i - 1]) / seg;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.hx = (b.x - a.x) / seg;
    out.hz = (b.z - a.z) / seg;
    const h0 = this.tan[i - 1], dh = Math.atan2(Math.sin(this.tan[i] - h0), Math.cos(this.tan[i] - h0));
    const h = h0 + dh * t;
    out.heading = Math.atan2(Math.sin(h), Math.cos(h));
    out.y = this.yProfile ? this.yProfile(s / this.length) : this.y;
    return out;
  }

  /** Closest arc length to (x, z) and signed lateral offset (+ = right of travel). */
  project(x, z) {
    let best = Infinity, bs = 0, bd = 0;
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best) {
        best = d2;
        bs = this.cum[i - 1] + Math.sqrt(L2) * t;
        const L = Math.sqrt(L2);
        // right of travel = (-hz, hx)
        bd = ((x - px) * (-dz / L) + (z - pz) * (dx / L));
      }
    }
    return { s: bs, d: bd, dist: Math.sqrt(best) };
  }
}

function bezier(p0, f0, p3, f3, n = 18, kOverride = null) {
  const D = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const k = kOverride ?? D * 0.55;
  const p1 = { x: p0.x + f0.x * k, z: p0.z + f0.z * k };
  const p2 = { x: p3.x - f3.x * k, z: p3.z - f3.z * k };
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      z: u * u * u * p0.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * p3.z,
    });
  }
  return pts;
}

/** Points along a circular arc around c (x = cos, z = sin) from angle a0 to a1, about `step` m apart. */
function arcPts(c, r, a0, a1, step = 2) {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / step));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: c.x + r * Math.cos(a), z: c.z + r * Math.sin(a) };
  });
}

/** Polyline builder from straights and circular arcs (heading h = atan2(z, x); ang > 0 turns right). */
class Turtle {
  constructor(x, z, h) { this.x = x; this.z = z; this.h = h; this.pts = [{ x, z }]; }

  straight(L, step = 2) {
    if (L < 1e-6) return this;
    const n = Math.ceil(L / step), hx = Math.cos(this.h), hz = Math.sin(this.h);
    for (let i = 1; i <= n; i++) this.pts.push({ x: this.x + (hx * L * i) / n, z: this.z + (hz * L * i) / n });
    this.x += hx * L;
    this.z += hz * L;
    return this;
  }

  arc(r, ang, step = 2) {
    const sd = Math.sign(ang), hx = Math.cos(this.h), hz = Math.sin(this.h);
    const c = { x: this.x - hz * r * sd, z: this.z + hx * r * sd };     // right of the heading for a right turn
    const a0 = Math.atan2(this.z - c.z, this.x - c.x);
    const p = arcPts(c, r, a0, a0 + ang, step);
    this.pts.push(...p.slice(1));
    this.x = p[p.length - 1].x;
    this.z = p[p.length - 1].z;
    this.h += ang;
    return this;
  }
}

/**
 * Loop ramp from a lane at z0 (heading east for d = +1, west for d = -1) back to a lane at z1
 * heading the other way: it turns out (right) by `loopNeck` degrees, runs straight, loops left
 * round a circle of `loopRadius` centred at (xc, zc), runs straight and turns in again. The
 * straights are sized so the loop ends exactly on the z1 lane. Returns the points and the x where
 * the ramp leaves (x0) and joins (x1).
 */
function loopPath(d, xc, zc, z0, z1, F) {
  const a = (F.loopNeck * Math.PI) / 180, R = F.loopRadius, r = F.loopTurn;
  const L = (d * (zc - z0) + R * Math.cos(a) - r * (1 - Math.cos(a))) / Math.sin(a);
  const x0 = xc - d * ((R + r) * Math.sin(a) + L * Math.cos(a));
  const h0 = d > 0 ? 0 : Math.PI;
  const run = (L2) => new Turtle(x0, z0, h0).arc(r, a).straight(L).arc(R, -(Math.PI + 2 * a)).straight(L2).arc(r, a);
  const free = run(0);
  const t = run((z1 - free.z) / Math.sin(h0 - Math.PI - a));
  return { pts: t.pts, x0, x1: t.x };
}

/**
 * Height along a ramp of length L: y0 up to arc length a, y1 from b on, and a constant grade in
 * between with eased ends (vertical curves). Returned as a function of t = s / L (Lane.yProfile).
 */
function gradeProfile(y0, y1, a, b, L) {
  const span = Math.max(1, b - a), tau = Math.min(0.3, 50 / span), vmax = 1 / (1 - tau);
  const f = (u) => (u <= 0 ? 0 : u >= 1 ? 1
    : u < tau ? (vmax * u * u) / (2 * tau)
      : u > 1 - tau ? 1 - (vmax * (1 - u) ** 2) / (2 * tau)
        : vmax * (u - tau / 2));
  return (t) => y0 + (y1 - y0) * f((t * L - a) / span);
}

/** Offset of (x, z) to the right of the road in an `attach` record (see RoadNetwork.addRamp). */
export const lateral = (a, x, z) => (x - a.q.x) * -a.u.z + (z - a.q.z) * a.u.x;

// ---------------------------------------------------------------- signals

export const SIG = { RED: 0, YELLOW: 1, GREEN: 2 };
export const WALK = { DONT: 0, FLASH: 1, WALK: 2 };

export class SignalController {
  constructor(inter, rand) {
    this.inter = inter;
    const big = inter.big;
    const tNS = big ? 16 : 13, tEW = big ? 21 : 13;
    const Y = 2.5, AR = 1.0, LT = 5;
    this.phases = [
      { g: { NS: SIG.GREEN }, walk: ['E', 'W'], dur: tNS },
      { g: { NS: SIG.YELLOW }, dur: Y },
      { g: {}, dur: AR },
      { g: { NSL: SIG.GREEN }, dur: LT },
      { g: { NSL: SIG.YELLOW }, dur: Y },
      { g: {}, dur: AR },
      { g: { EW: SIG.GREEN }, walk: ['N', 'S'], dur: tEW },
      { g: { EW: SIG.YELLOW }, dur: Y },
      { g: {}, dur: AR },
      { g: { EWL: SIG.GREEN }, dur: LT },
      { g: { EWL: SIG.YELLOW }, dur: Y },
      { g: {}, dur: AR },
    ];
    this.cycle = this.phases.reduce((a, p) => a + p.dur, 0);
    this.t = rand() * this.cycle;
    this.idx = 0;
    this.tIn = 0;
    this._sync();
  }

  _sync() {
    let t = this.t % this.cycle;
    for (let i = 0; i < this.phases.length; i++) {
      if (t < this.phases[i].dur) { this.idx = i; this.tIn = t; return; }
      t -= this.phases[i].dur;
    }
  }

  update(dt) { this.t += dt; this._sync(); }

  state(group) { return this.phases[this.idx].g[group] ?? SIG.RED; }

  /** Seconds until this group's green ends (Infinity if not green). */
  remaining() { return this.phases[this.idx].dur - this.tIn; }

  /** Seconds until the cross road gets a green (`base` is our road's group, 'NS' or 'EW'). */
  timeToCrossGreen(base) {
    let t = 0;
    for (let k = 0; k < this.phases.length; k++) {
      const p = this.phases[(this.idx + k) % this.phases.length];
      if (Object.entries(p.g).some(([g, st]) => st === SIG.GREEN && !g.startsWith(base))) break;
      t += k === 0 ? p.dur - this.tIn : p.dur;
    }
    return t;
  }

  walk(leg) {
    const p = this.phases[this.idx];
    if (!p.walk || !p.walk.includes(leg)) return WALK.DONT;
    return p.dur - this.tIn > 7 ? WALK.WALK : WALK.FLASH;
  }
}

// ---------------------------------------------------------------- network

export class RoadNetwork {
  constructor(seed = 1) {
    let s = seed >>> 0;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.lanes = [];
    this.intersections = [];
    this.crosswalks = [];
    this.segments = [];        // straight road pieces between intersections (for drawing)
    this.walk = { nodes: [], edges: [] };
    this.build();
  }

  addLane(pts, o) {
    const l = new Lane(pts, o);
    this.lanes.push(l);
    return l;
  }

  build() {
    const L = LAYOUT;
    const B = L.bounds;
    const cw = L.crosswalk;
    const avs = L.avenues, sts = L.streets;
    const xs = avs.map((a) => a.x), zs = sts.map((s) => s.z);

    // Intersections
    this.interAt = new Map();
    for (const av of avs) {
      for (const st of sts) {
        const inter = {
          id: this.intersections.length, x: av.x, z: st.z, av, st,
          hwX: roadHalfWidth(av), hwZ: roadHalfWidth(st),
          big: av.id === 'boulevard',
          approaches: {}, departures: {}, crosswalks: {},
        };
        inter.dNS = inter.hwZ + cw.gap + cw.width + L.stopGap;   // stop line offset for N/S approaches
        inter.dEW = inter.hwX + cw.gap + cw.width + L.stopGap;   // for E/W approaches
        inter.signal = new SignalController(inter, this.rand);
        this.intersections.push(inter);
        this.interAt.set(av.x + ',' + st.z, inter);
      }
    }

    // Straight lanes on each road segment, both directions.
    const mkRoad = (road, axis) => {
      const along = axis === 'z' ? zs : xs;
      const stops = [-B, ...along, B];
      const hw = roadHalfWidth(road);
      for (let k = 0; k < stops.length - 1; k++) {
        const a = stops[k], b = stops[k + 1];
        const ia = k > 0 ? (axis === 'z' ? this.interAt.get(road.x + ',' + a) : this.interAt.get(a + ',' + road.z)) : null;
        const ib = k < stops.length - 2 ? (axis === 'z' ? this.interAt.get(road.x + ',' + b) : this.interAt.get(b + ',' + road.z)) : null;
        const da = ia ? (axis === 'z' ? ia.dNS : ia.dEW) : 0;
        const db = ib ? (axis === 'z' ? ib.dNS : ib.dEW) : 0;
        const seg = { road, axis, a, b, ia, ib, hw, lanes: {} };
        this.segments.push(seg);
        for (const dn of axis === 'z' ? ['SB', 'NB'] : ['EB', 'WB']) {
          const f = DIRS[dn];
          const r = rightOf(f);
          const forward = (f.x + f.z) > 0;
          const start = forward ? a + da : b - db;
          const end = forward ? b - db : a + da;
          const list = [];
          for (let i = 0; i < road.lanes; i++) {
            const off = road.median / 2 + (i + 0.5) * LANE_W;
            const c = axis === 'z' ? road.x : road.z;
            const pts = axis === 'z'
              ? [{ x: c + r.x * off, z: start }, { x: c + r.x * off, z: end }]
              : [{ x: start, z: c + r.z * off }, { x: end, z: c + r.z * off }];
            const lane = this.addLane(pts, { kind: 'road', dir: dn, index: i, road, speed: road.speed });
            lane.segment = seg;
            lane.startInter = forward ? ia : ib;
            lane.endInter = forward ? ib : ia;
            list.push(lane);
          }
          for (let i = 0; i < list.length; i++) {
            list[i].left = list[i - 1] || null;
            list[i].right = list[i + 1] || null;
          }
          seg.lanes[dn] = list;
          // register with the intersections
          const endI = forward ? ib : ia, startI = forward ? ia : ib;
          if (endI) endI.approaches[dn] = list;
          if (startI) startI.departures[dn] = list;
        }
      }
    };
    avs.forEach((r) => mkRoad(r, 'z'));
    sts.forEach((r) => mkRoad(r, 'x'));

    // Connectors through intersections.
    for (const I of this.intersections) {
      for (const [dn, apps] of Object.entries(I.approaches)) {
        const f = DIRS[dn];
        const group = dn === 'SB' || dn === 'NB' ? 'NS' : 'EW';
        const moves = [['straight', f], ['right', rightOf(f)], ['left', leftOf(f)]];
        apps.forEach((ap, i) => {
          for (const [mv, fo] of moves) {
            const n = apps.length;
            if (mv === 'right' && i !== n - 1) continue;
            if (mv === 'left' && i !== 0) continue;
            const outDir = dirName(fo);
            const deps = I.departures[outDir];
            if (!deps) continue;
            const j = mv === 'straight' ? Math.min(i, deps.length - 1) : mv === 'right' ? deps.length - 1 : 0;
            const dep = deps[j];
            const p0 = ap.pts[ap.pts.length - 1];
            const p3 = dep.pts[0];
            const pts = mv === 'straight' ? [p0, p3] : bezier(p0, f, p3, fo);
            const con = this.addLane(pts, { kind: 'connector', dir: dn, index: i, movement: mv, speed: mv === 'straight' ? ap.speed : 6.5 });
            // the curve's true directions at its ends, so a car's heading doesn't jump entering or leaving a turn
            con.tan[0] = Math.atan2(f.x, f.z);
            con.tan[con.tan.length - 1] = Math.atan2(fo.x, fo.z);
            con.signal = { inter: I, group: mv === 'left' ? group + 'L' : group };
            con.inter = I;
            ap.next.push(con); con.prev.push(ap);
            con.next.push(dep); dep.prev.push(con);
          }
        });
      }
    }

    this.buildExpressways();

    this.buildCrosswalks();
    this.buildClosure();
    this.buildWalkGraph();
    this.computeConflicts();
    // ramps leave and join straight decks and roads: start and end exactly along them
    for (const l of this.lanes) {
      if (l.kind !== 'ramp') continue;
      if (l.prev.length) l.tan[0] = l.prev[0].tan[l.prev[0].tan.length - 1];
      if (l.next.length) l.tan[l.tan.length - 1] = l.next[0].tan[0];
    }
    this.entries = this.lanes.filter((l) => l.kind !== 'connector' && l.prev.length === 0);
  }

  // Elevated expressways: the N-S viaduct (level 1) and the E-W flyover (level 2), joined by two
  // curved ramps, plus a loop ramp just outside each end of the city between the flyover and
  // north_st (which carries on out of town under it). Each carriageway is cut into parallel pieces
  // (same cuts for every lane, so the lanes share arc length and cars can change lanes); ramps
  // leave from / join the outer lane at the cuts with a taper, and stay level with the road they
  // leave until they are clear of it (the "nose"), then climb or descend.
  buildExpressways() {
    const V = LAYOUT.viaduct, F = LAYOUT.flyover, O = LAYOUT.outskirts, B = LAYOUT.bounds;
    const link = (a, b) => { a.next.push(b); b.prev.push(a); };
    const carriageway = (axis, c, spec, dn, cuts = [], o = {}) => {
      const f = DIRS[dn], r = rightOf(f);
      const fwd = f.x + f.z > 0;
      const ts = [fwd ? spec.from : spec.to, ...[...cuts].sort((p, q) => (fwd ? p - q : q - p)), fwd ? spec.to : spec.from];
      const lanes = [];
      for (let i = 0; i < spec.lanes; i++) {
        const off = spec.median / 2 + (i + 0.5) * LANE_W;
        const lat = axis === 'z' ? c + r.x * off : c + r.z * off;
        const P = (t) => (axis === 'z' ? { x: lat, z: t } : { x: t, z: lat });
        const pieces = [];
        for (let k = 0; k < ts.length - 1; k++) {
          const l = this.addLane([P(ts[k]), P(ts[k + 1])], { kind: 'viaduct', dir: dn, index: i, speed: spec.speed, y: spec.height, elevated: true, ...o });
          if (k) link(pieces[k - 1], l);
          pieces.push(l);
        }
        lanes.push(pieces);
      }
      lanes.forEach((pieces, i) => pieces.forEach((l, k) => {
        l.left = lanes[i - 1]?.[k] || null;
        l.right = lanes[i + 1]?.[k] || null;
      }));
      return lanes;                                   // lanes[index][piece]
    };

    // -- geometry: outer lanes of both decks, the curved ramps and the two loops
    const north = LAYOUT.streets.find((st) => st.id === 'north_st');
    const outer = V.median / 2 + 1.5 * LANE_W;                    // outer-lane offset on both decks
    const zEB = F.z + outer, xSB = V.x - outer, xNB = V.x + outer;
    const zWB = north.z - (north.median / 2 + 1.5 * LANE_W);      // north_st westbound, outer lane
    const R = F.rampRadius;
    const xA = xSB - R, zA = zEB + R;                             // ramp A: leaves flyover EB at xA, joins viaduct SB at zA
    const xB = xNB + R, zB = zEB + R;                             // ramp B: leaves viaduct NB at zB, joins flyover EB at xB
    const W = loopPath(-1, -F.loopCentre, F.z, zWB, zEB, F);     // north_st WB (ground) -> flyover EB
    const E = loopPath(+1, F.loopCentre, F.z, zEB, zWB, F);      // flyover EB -> north_st WB (ground)

    // -- the decks
    const SB = carriageway('z', V.x, V, 'SB', [zA]);
    const NB = carriageway('z', V.x, V, 'NB', [zB]);
    const EB = carriageway('x', F.z, F, 'EB', [W.x1, xA, xB, E.x0]);
    const WB = carriageway('x', F.z, F, 'WB');

    // -- north_st carries on beyond both city edges (ground lanes, joined to the city's lanes)
    const ground = { kind: 'road', y: 0, elevated: false, road: north };
    const gW = { lanes: north.lanes, median: north.median, speed: north.speed, from: -O.to, to: -B };
    const gE = { ...gW, from: B, to: O.to };
    const wWB = carriageway('x', north.z, gW, 'WB', [W.x0], ground), wEB = carriageway('x', north.z, gW, 'EB', [], ground);
    const eWB = carriageway('x', north.z, gE, 'WB', [E.x1], ground), eEB = carriageway('x', north.z, gE, 'EB', [], ground);
    const segW = this.segments.find((sg) => sg.road === north && sg.a === -B);
    const segE = this.segments.find((sg) => sg.road === north && sg.b === B);
    for (let i = 0; i < north.lanes; i++) {
      link(segW.lanes.WB[i], wWB[i][0]);
      link(wEB[i][0], segW.lanes.EB[i]);
      link(segE.lanes.EB[i], eEB[i][0]);
      link(eWB[i][1], segE.lanes.WB[i]);
    }

    // -- ramps. `attach` describes the road a ramp leaves / joins: a point on its outer lane, the
    // direction of travel there, how far its surface reaches right of that lane, and its height.
    const shoulder = LANE_W / 2 + O.shoulder;
    const deckEdge = F.halfWidth - outer;
    const at = (x, z, dn, edge, y, deck) => ({ q: { x, z }, u: DIRS[dn], edge, y, deck });
    const rampA = this.addRamp(arcPts({ x: xA, z: zA }, R, -Math.PI / 2, 0), 'EB', F.rampSpeed,
      at(xA, zEB, 'EB', deckEdge, F.height, 'flyover'), at(xSB, zA, 'SB', deckEdge, V.height, 'viaduct'));
    const rampB = this.addRamp(arcPts({ x: xB, z: zB }, R, Math.PI, 1.5 * Math.PI), 'NB', F.rampSpeed,
      at(xNB, zB, 'NB', deckEdge, V.height, 'viaduct'), at(xB, zEB, 'EB', deckEdge, F.height, 'flyover'));
    const loopW = this.addRamp(W.pts, 'WB', F.loopSpeed,
      at(W.x0, zWB, 'WB', shoulder, 0, 'ground'), at(W.x1, zEB, 'EB', deckEdge, F.height, 'flyover'));
    const loopE = this.addRamp(E.pts, 'EB', F.loopSpeed,
      at(E.x0, zEB, 'EB', deckEdge, F.height, 'flyover'), at(E.x1, zWB, 'WB', shoulder, 0, 'ground'));
    link(EB[1][1], rampA); link(rampA, SB[1][1]);
    link(NB[1][0], rampB); link(rampB, EB[1][3]);
    link(wWB[1][0], loopW); link(loopW, EB[1][1]);
    link(EB[1][3], loopE); link(loopE, eWB[1][1]);
    for (const l of [SB[1][1], EB[1][1], EB[1][3], eWB[1][1]]) l.merge = true;

    this.viaductLanes = { SB: [SB[0][0], SB[1][0]], NB: [NB[0][0], NB[1][0]] };
    this.flyoverLanes = { EB: [EB[0][0], EB[1][0]], WB: [WB[0][0], WB[1][0]] };
    this.markLanes = [...SB[0], ...NB[0], ...EB[0], ...WB[0]];      // lane-0 pieces: dashed lines
    this.ramps = [rampA, rampB, loopW, loopE];
    this.outskirts = [...wWB.flat(), ...wEB.flat(), ...eWB.flat(), ...eEB.flat()];
    // `spiralW` / `spiralE` are the old names of the two loops (kept for ?until=spiral / spiralE)
    this.highway = {
      rampA, rampB, loopW, loopE, spiralW: loopW, spiralE: loopE,
      pastExitW: [wWB[0][1], wWB[1][1]],                         // north_st carrying on west past the loop
      flyoverEnd: [EB[0][4], EB[1][4]],                           // flyover EB carrying on east past the loop
    };
  }

  /** A single-lane ramp between two roads, level with each until it is clear of it (see buildExpressways). */
  addRamp(pts, dir, speed, a0, a1) {
    const lane = this.addLane(pts, { kind: 'ramp', dir, movement: 'ramp', speed, elevated: true, y: a0.y });
    const hw = LAYOUT.flyover.rampHalfWidth;
    lane.hw = hw;
    lane.attach = [a0, a1];
    // first / last arc length where the ramp's inner edge is clear of the road it leaves / joins
    const clear = (a, s) => {
      const p = lane.sample(s, {});
      return lateral(a, p.x + p.hz * hw, p.z - p.hx * hw) >= a.edge;   // left edge = centre - hw * right
    };
    let s0 = 0, s1 = lane.length;
    while (s0 < lane.length / 2 && !clear(a0, s0)) s0 += 0.25;
    while (s1 > lane.length / 2 && !clear(a1, s1)) s1 -= 0.25;
    lane.noses = [s0, s1];
    // ...and where its painted inner edge line leaves / meets the road's edge line (gore start / end)
    const line = (a, s) => {
      const p = lane.sample(s, {}), e = hw - 0.85;
      return lateral(a, p.x + p.hz * e, p.z - p.hx * e) >= a.edge - 0.85;
    };
    let g0 = 0, g1 = lane.length;
    while (g0 < s0 && !line(a0, g0)) g0 += 0.25;
    while (g1 > s1 && !line(a1, g1)) g1 -= 0.25;
    lane.gores = [g0, g1];
    lane.yProfile = gradeProfile(a0.y, a1.y, s0 + 4, s1 - 4, lane.length);
    lane.y = a0.y;
    return lane;
  }

  buildCrosswalks() {
    const cw = LAYOUT.crosswalk;
    for (const I of this.intersections) {
      const { x, z, hwX, hwZ } = I;
      const legs = {
        N: { cx: x, cz: z - hwZ - cw.gap - cw.width / 2, hx: hwX, hz: cw.width / 2, axis: 'x' },
        S: { cx: x, cz: z + hwZ + cw.gap + cw.width / 2, hx: hwX, hz: cw.width / 2, axis: 'x' },
        E: { cx: x + hwX + cw.gap + cw.width / 2, cz: z, hx: cw.width / 2, hz: hwZ, axis: 'z' },
        W: { cx: x - hwX - cw.gap - cw.width / 2, cz: z, hx: cw.width / 2, hz: hwZ, axis: 'z' },
      };
      for (const [leg, g] of Object.entries(legs)) {
        const c = { id: this.crosswalks.length, inter: I, leg, ...g, peds: [] };
        c.walk = () => I.signal.walk(leg);
        I.crosswalks[leg] = c;
        this.crosswalks.push(c);
      }
    }
  }

  buildClosure() {
    const C = LAYOUT.closure;
    for (const seg of this.segments) {
      if (seg.road.id !== C.road) continue;
      const lanes = seg.lanes[C.dir];
      if (!lanes) continue;
      const lane = lanes[C.lane];
      const p = lane.project(C.x0, lane.pts[0].z);
      const q = lane.project(C.x1, lane.pts[0].z);
      if (p.dist > 1 || q.dist > 1) continue;
      lane.closed = { s0: Math.min(p.s, q.s), s1: Math.max(p.s, q.s), taper: C.taper };
      this.closure = { lane, seg, ...lane.closed };
    }
  }

  // Sidewalk graph: four corner hubs per intersection, crosswalk end nodes, and
  // sidewalk edges along every road segment (both sides).
  buildWalkGraph() {
    const W = this.walk;
    const node = (x, z, kind) => { const n = { id: W.nodes.length, x, z, kind, edges: [] }; W.nodes.push(n); return n; };
    const edge = (a, b, kind, extra = {}) => {
      const e = { id: W.edges.length, a, b, kind, len: Math.hypot(b.x - a.x, b.z - a.z), ...extra };
      W.edges.push(e); a.edges.push(e); b.edges.push(e);
      return e;
    };
    const hubs = new Map();
    for (const I of this.intersections) {
      const sx = I.av.sidewalk / 2, sz = I.st.sidewalk / 2;
      const h = {
        NE: node(I.x + I.hwX + sx, I.z - I.hwZ - sz, 'hub'),
        NW: node(I.x - I.hwX - sx, I.z - I.hwZ - sz, 'hub'),
        SE: node(I.x + I.hwX + sx, I.z + I.hwZ + sz, 'hub'),
        SW: node(I.x - I.hwX - sx, I.z + I.hwZ + sz, 'hub'),
      };
      hubs.set(I, h);
      const C = I.crosswalks;
      const ends = {
        N: [node(C.N.cx - C.N.hx - 0.9, C.N.cz, 'cw'), node(C.N.cx + C.N.hx + 0.9, C.N.cz, 'cw'), 'NW', 'NE'],
        S: [node(C.S.cx - C.S.hx - 0.9, C.S.cz, 'cw'), node(C.S.cx + C.S.hx + 0.9, C.S.cz, 'cw'), 'SW', 'SE'],
        E: [node(C.E.cx, C.E.cz - C.E.hz - 0.9, 'cw'), node(C.E.cx, C.E.cz + C.E.hz + 0.9, 'cw'), 'NE', 'SE'],
        W: [node(C.W.cx, C.W.cz - C.W.hz - 0.9, 'cw'), node(C.W.cx, C.W.cz + C.W.hz + 0.9, 'cw'), 'NW', 'SW'],
      };
      for (const [leg, [a, b, ha, hb]] of Object.entries(ends)) {
        edge(h[ha], a, 'corner');
        edge(h[hb], b, 'corner');
        const e = edge(a, b, 'crosswalk', { cw: C[leg] });
        C[leg].edge = e;
      }
    }
    // sidewalks along segments
    const B = LAYOUT.bounds;
    for (const seg of this.segments) {
      const r = seg.road, sw = r.sidewalk / 2;
      const sides = seg.axis === 'z' ? [['E', 1], ['W', -1]] : [['N', -1], ['S', 1]];
      const pair = [];
      for (const [side, sgn] of sides) {
        let a, b;
        if (seg.axis === 'z') {
          const x = r.x + sgn * (seg.hw + sw);
          a = seg.ia ? hubs.get(seg.ia)[(side === 'E' ? 'S' : 'S') + side] : node(x, -B, 'end');
          b = seg.ib ? hubs.get(seg.ib)['N' + side] : node(x, B, 'end');
        } else {
          const z = r.z + sgn * (seg.hw + sw);
          a = seg.ia ? hubs.get(seg.ia)[side + 'E'] : node(-B, z, 'end');
          b = seg.ib ? hubs.get(seg.ib)[side + 'W'] : node(B, z, 'end');
        }
        // unit normal pointing from the sidewalk to the road
        const toRoad = seg.axis === 'z' ? { x: -sgn, z: 0 } : { x: 0, z: -sgn };
        pair.push(edge(a, b, 'sidewalk', { seg, side, toRoad, roadWidth: seg.hw * 2 }));
      }
      pair[0].opposite = pair[1];
      pair[1].opposite = pair[0];
    }
  }

  // Which crosswalks does each lane pass over, and where (arc length)?
  computeConflicts() {
    for (const lane of this.lanes) {
      if (lane.elevated) continue;
      const p = {};
      for (const c of this.crosswalks) {
        let s0 = Infinity, s1 = -Infinity;
        for (let s = 0; s <= lane.length; s += 0.5) {
          lane.sample(s, p);
          if (Math.abs(p.x - c.cx) <= c.hx + 0.6 && Math.abs(p.z - c.cz) <= c.hz + 0.6) {
            s0 = Math.min(s0, s);
            s1 = Math.max(s1, s);
          }
        }
        if (s1 >= s0) lane.conflicts.push({ cw: c, s0, s1 });
      }
    }
  }

  /** Lanes a vehicle may take after `lane` (connectors after approaches). */
  choices(lane) { return lane.next; }

  laneById(id) { return this.lanes.find((l) => l.id === id); }
}
