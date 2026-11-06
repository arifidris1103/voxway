// Inputs for a learned pedestrian predictor: what an AV could observe about one pedestrian.
//   - its last second of motion (10 Hz, like the Waymo Open Motion Dataset) and which way it faced
//   - the nearest avenue and street edge (how far, which way the road is), whether it is on the road
//   - the crosswalk it is at (if any) and that crossing's walk light
//   - the nearest ground vehicles (where they are and how fast they are coming)
// Everything is in the pedestrian's own frame: origin at its latest position, +a = the way it
// faces, +b = to its right. Predictions come back in the same frame.
//
// The dataset exporter (tools/headless/export-dataset.mjs) and the in-sim learned predictor
// (LearnedPredictor.js) both call pedFeatures(), so training and driving see identical inputs.
// Change anything here and bump FEATURE_VERSION, then re-export the data and retrain.

import { LAYOUT, roadHalfWidth } from '../world/RoadNetwork.js';

export const FEATURE_VERSION = 1;
export const HIST = 11;                   // samples of history (1.1 s at 10 Hz, newest last)
export const FUT_DT = 0.2;                // predicted points are 0.2 s apart...
export const FUT_N = 20;                  // ...20 of them = 4 s
export const N_CARS = 4;                  // nearest ground vehicles described
const CAR_RANGE = 40, CW_RANGE = 6, TELEPORT = 1.5;

export const FEATURE_NAMES = [
  ...Array.from({ length: HIST - 1 }, (_, k) => [`hist${k}_a`, `hist${k}_b`]).flat(),          // past positions, oldest first
  ...Array.from({ length: HIST - 1 }, (_, k) => [`hist${k}_cos`, `hist${k}_sin`]).flat(),      // past heading vs now
  'avenue_dist', 'avenue_na', 'avenue_nb', 'avenue_width',
  'street_dist', 'street_na', 'street_nb', 'street_width',
  'on_road',
  'cw_here', 'cw_a', 'cw_b', 'cw_dir_a', 'cw_dir_b', 'cw_length', 'cw_dont_walk', 'cw_flashing', 'cw_walk',
  ...Array.from({ length: N_CARS }, (_, k) => [`car${k}_here`, `car${k}_a`, `car${k}_b`, `car${k}_va`, `car${k}_vb`]).flat(),
];
export const N_FEATURES = FEATURE_NAMES.length;

const AVENUES = LAYOUT.avenues.map((a) => ({ x: a.x, hw: roadHalfWidth(a) }));
const STREETS = LAYOUT.streets.map((s) => ({ z: s.z, hw: roadHalfWidth(s) }));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Pedestrian frame: origin (x, z), forward f along `heading`, right r. */
export function frameOf(x, z, heading) {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  return { x, z, fx, fz, rx: -fz, rz: fx };
}
/** World point -> [a, b] in frame F. */
export const toLocal = (F, x, z) => {
  const dx = x - F.x, dz = z - F.z;
  return [dx * F.fx + dz * F.fz, dx * F.rx + dz * F.rz];
};
/** [a, b] in frame F -> world [x, z]. */
export const toWorld = (F, a, b) => [F.x + F.fx * a + F.rx * b, F.z + F.fz * a + F.rz * b];
const dirLocal = (F, x, z) => [x * F.fx + z * F.fz, x * F.rx + z * F.rz];

/** Did the pedestrian jump (respawned / pulled in by the scenario director) between samples? */
export const jumped = (p, q) => Math.hypot(q.x - p.x, q.z - p.z) > TELEPORT;

/**
 * @param {object} ped    pedestrian (only its `y` level is read; the position comes from `hist`)
 * @param {Array} hist    [{ x, z, h }] oldest -> newest at 10 Hz (EgoPlanner.history.get(ped))
 * @param {object} ctx    { crosswalks, vehicles: [Vehicle], onRoad(x, z) }
 * @returns {{ frame, x: Float32Array } | null}  null when there isn't a clean second of history
 */
export function pedFeatures(ped, hist, ctx) {
  if (!hist || hist.length < HIST) return null;
  const H = hist.slice(-HIST);
  for (let k = 1; k < HIST; k++) if (jumped(H[k - 1], H[k])) return null;
  const now = H[HIST - 1];
  const F = frameOf(now.x, now.z, now.h);
  const x = new Float32Array(N_FEATURES);
  let i = 0;
  // motion history
  for (let k = 0; k < HIST - 1; k++) {
    const [a, b] = toLocal(F, H[k].x, H[k].z);
    x[i++] = a;
    x[i++] = b;
  }
  for (let k = 0; k < HIST - 1; k++) {
    x[i++] = Math.cos(H[k].h - now.h);
    x[i++] = Math.sin(H[k].h - now.h);
  }
  // nearest avenue (runs along z) and street (runs along x): signed distance to the kerb
  // (negative = on the carriageway), direction into the road, road width
  let av = AVENUES[0], st = STREETS[0];
  for (const a of AVENUES) if (Math.abs(now.x - a.x) < Math.abs(now.x - av.x)) av = a;
  for (const s of STREETS) if (Math.abs(now.z - s.z) < Math.abs(now.z - st.z)) st = s;
  const road = (d, wx, wz, w) => {
    const [na, nb] = dirLocal(F, wx, wz);
    x[i++] = clamp(d / 10, -3, 3);
    x[i++] = na;
    x[i++] = nb;
    x[i++] = w / 30;
  };
  road(Math.abs(now.x - av.x) - av.hw, Math.sign(av.x - now.x) || 1, 0, av.hw * 2);
  road(Math.abs(now.z - st.z) - st.hw, 0, Math.sign(st.z - now.z) || 1, st.hw * 2);
  x[i++] = ctx.onRoad(now.x, now.z) ? 1 : 0;
  // the crosswalk it is at or on: where, which way across, how long, and the walk light
  let cw = null, cd = CW_RANGE;
  for (const c of ctx.crosswalks) {
    const d = Math.hypot(Math.max(0, Math.abs(now.x - c.cx) - c.hx), Math.max(0, Math.abs(now.z - c.cz) - c.hz));
    if (d < cd) { cd = d; cw = c; }
  }
  if (cw) {
    const [ca, cb] = toLocal(F, cw.cx, cw.cz);
    const along = cw.axis === 'x';                                   // crossing runs along x (or z)
    const s = Math.sign(along ? cw.cx - now.x : cw.cz - now.z) || 1;  // towards the far side
    const [ua, ub] = dirLocal(F, along ? s : 0, along ? 0 : s);
    const w = cw.walk();
    x.set([1, ca / 10, cb / 10, ua, ub, (along ? cw.hx : cw.hz) / 15, w === 0 ? 1 : 0, w === 1 ? 1 : 0, w === 2 ? 1 : 0], i);
  }
  i += 9;
  // nearest ground vehicles (the AV included)
  const cars = [];
  for (const v of ctx.vehicles) {
    if (Math.abs(v.pose.y - (ped.y || 0)) > 3) continue;              // the expressway is out of reach
    const d = Math.hypot(v.pose.x - now.x, v.pose.z - now.z);
    if (d < CAR_RANGE) cars.push({ v, d });
  }
  cars.sort((p, q) => p.d - q.d);
  for (let k = 0; k < N_CARS; k++, i += 5) {
    const c = cars[k];
    if (!c) continue;
    const [a, b] = toLocal(F, c.v.pose.x, c.v.pose.z);
    const [va, vb] = dirLocal(F, c.v.pose.vx || 0, c.v.pose.vz || 0);
    x.set([1, a / CAR_RANGE, b / CAR_RANGE, clamp(va / 15, -3, 3), clamp(vb / 15, -3, 3)], i);
  }
  return { frame: F, x };
}
