// Training data for a pedestrian trajectory predictor, made by running the simulation headless
// (plain Node, no browser, about 15x faster than real time), one process per seed:
//
//   npm run dataset -- --seeds 1-8 --minutes 5            # -> data/peds/seed_0001 ... seed_0008
//
// Once a second (after a warm-up) every pedestrian on the streets becomes a sample:
//   X.npy    (N, F)        what the AV can observe: the inputs from src/sim/PedFeatures.js
//   Y.npy    (N, 20, 2)    where it actually went over the next 4 s (every 0.2 s), in its own
//                          frame: metres ahead (a) and to its right (b) of where it stood
//   M.npy    (N, 20)       1 where Y is valid (0 after it left the map or was teleported)
//   BL.npy   (N, 2, 20, 2) the baseline predictor's guesses in the same frame...
//   BLP.npy  (N, 2)        ...and their probabilities (0 = no second guess)
//   meta.npy (N, 9)        seed, sim time, pedestrian id, hopper, state (see info.json),
//                          on the road now, steps into the road within 4 s, metres from the AV,
//                          AV speed
//   info.json              feature names, codes and settings
// Options: --seeds 1-8  --minutes 5  --every 1 (s between samples)  --warmup 20 (s)  --out data/peds
//          --crashes 0.8  --cars 76  --hwy 72  --peds 90  --jobs N (parallel seeds)
//          --womd 30  also save a full Waymo-Open-Motion-style scene every 30 s (womd/*.json)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseSeeds, writeNpy, runPool, childTask } from './cli.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');
const DEFAULTS = { seeds: '1-8', minutes: 5, every: 1, warmup: 20, out: 'data/peds', crashes: 0.8, cars: 76, hwy: 72, peds: 90, jobs: 0, womd: 0 };
export const STATES = ['walk', 'idle', 'watch', 'wait', 'cross', 'jaywait', 'jaycross', 'park', 'work'];
const META = ['seed', 'time', 'ped_id', 'hopper', 'state', 'on_road', 'enters_road', 'dist_to_av', 'av_speed'];

const task = childTask();
if (task) await exportSeed(task);
else await main();

async function main() {
  const o = parseArgs(process.argv.slice(2), DEFAULTS);
  const seeds = parseSeeds(o.seeds);
  const out = path.resolve(ROOT, o.out);
  fs.mkdirSync(out, { recursive: true });
  console.log(`Exporting ${seeds.length} seed(s) x ${o.minutes} min of simulation to ${path.relative(ROOT, out) || '.'}`);
  const t0 = Date.now();
  const counts = {};
  const failed = await runPool(HERE, seeds.map((seed) => ({ ...o, seed, out })), o.jobs, (m) => {
    if (m.done) counts[m.seed] = m.samples;
    console.log(m.done
      ? `  seed ${m.seed}: done, ${m.samples.toLocaleString()} samples`
      : `  seed ${m.seed}: ${m.t.toFixed(0)} s simulated, ${m.samples.toLocaleString()} samples`);
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${total.toLocaleString()} samples from ${Object.keys(counts).length} seed(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s${failed ? ` (${failed} failed)` : ''}`);
  console.log('Next: python ml/train_ped_predictor.py --data ' + path.relative(ROOT, out));
}

/** Run one seed and write its arrays (runs in a child process). */
async function exportSeed(o) {
  const { createSimulation } = await import('./node-sim.mjs');
  const { pedFeatures, jumped, toLocal, HIST, FUT_DT, FUT_N, N_FEATURES, FEATURE_NAMES, FEATURE_VERSION } = await import('../../src/sim/PedFeatures.js');
  const sim = await createSimulation({ seed: o.seed, crashes: o.crashes, cars: o.cars, hwy: o.hwy, peds: o.peds });
  const H = sim.planner.history;
  const ctx = { crosswalks: sim.net.crosswalks, vehicles: sim.traffic.vehicles, onRoad: (x, z) => sim.peds.onRoad(x, z) };
  const every = Math.max(1, Math.round(o.every * 10));      // in 10 Hz ticks
  const gap = Math.round(FUT_DT * 10), horizon = gap * FUT_N;
  const dir = path.join(o.out, `seed_${String(o.seed).padStart(4, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  if (o.womd) fs.mkdirSync(path.join(dir, 'womd'), { recursive: true });

  const log = new Map();            // tick -> Map(ped -> { x, z }) for the last `horizon` ticks
  const pending = [];               // samples waiting for their future
  const rows = { X: [], Y: [], M: [], BL: [], BLP: [], meta: [] };
  let lastTick = H.ticks, nextWomd = o.warmup + (o.womd || Infinity);

  // baseline hypotheses resampled at the training time steps, in the pedestrian's frame
  const baseline = (p, F) => {
    const hyps = sim.planner.predictor.predict(p, H.get(p)).slice(0, 2);
    const bl = new Float32Array(2 * FUT_N * 2), blp = new Float32Array(2);
    hyps.forEach((h, m) => {
      blp[m] = h.prob;
      const pts = [{ t: 0, x: p.pos.x, z: p.pos.z }, ...h.traj];
      let j = 1;
      for (let k = 1; k <= FUT_N; k++) {
        const t = k * FUT_DT;
        while (j < pts.length - 1 && pts[j].t < t) j++;
        const a = pts[j - 1], b = pts[j], u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
        const [la, lb] = toLocal(F, a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u);
        bl[(m * FUT_N + k - 1) * 2] = la;
        bl[(m * FUT_N + k - 1) * 2 + 1] = lb;
      }
    });
    return { bl, blp };
  };

  const finish = (s) => {
    const y = new Float32Array(FUT_N * 2), m = new Float32Array(FUT_N);
    let prev = log.get(s.tick).get(s.p), ok = true, enters = 0;
    for (let t = s.tick + 1; t <= s.tick + horizon; t++) {
      const q = log.get(t)?.get(s.p);
      if (!q || jumped(prev, q)) ok = false;
      if (!ok) break;
      prev = q;
      if ((t - s.tick) % gap) continue;
      const k = (t - s.tick) / gap - 1;
      [y[k * 2], y[k * 2 + 1]] = toLocal(s.F, q.x, q.z);
      m[k] = 1;
      if (!s.onRoad && ctx.onRoad(q.x, q.z)) enters = 1;
    }
    if (!m[0]) return;                         // no future at all
    s.meta[6] = enters;
    rows.X.push(s.x); rows.Y.push(y); rows.M.push(m); rows.BL.push(s.bl); rows.BLP.push(s.blp); rows.meta.push(s.meta);
  };

  sim.onStep.push(() => {
    if (sim.time >= nextWomd) {
      fs.writeFileSync(path.join(dir, 'womd', `scene_${sim.time.toFixed(1).padStart(7, '0')}.json`), JSON.stringify(sim.recorder.exportScenario()));
      nextWomd += o.womd;
    }
    if (H.ticks === lastTick) return;                 // pedestrians are sampled at 10 Hz
    const tick = lastTick = H.ticks;
    const now = new Map();
    for (const p of sim.peds.peds) now.set(p, { x: p.pos.x, z: p.pos.z });
    log.set(tick, now);
    log.delete(tick - horizon - 1);
    if (sim.time >= o.warmup && tick % every === 0) {
      const ego = sim.ego;
      for (const p of sim.peds.peds) {
        if (p.state === 'park' || p.state === 'work') continue;   // park strollers, road workers
        const f = pedFeatures(p, H.get(p), ctx);
        if (!f) continue;
        const onRoad = ctx.onRoad(p.pos.x, p.pos.z);
        const { bl, blp } = baseline(p, f.frame);
        pending.push({
          tick, p, F: f.frame, x: f.x, bl, blp, onRoad,
          meta: Float32Array.from([o.seed, sim.time, p.id, p.style === 'hopper' ? 1 : 0, STATES.indexOf(p.state), onRoad ? 1 : 0, 0,
            Math.hypot(p.pos.x - ego.pose.x, p.pos.z - ego.pose.z), ego.v]),
        });
      }
    }
    while (pending.length && pending[0].tick + horizon <= tick) finish(pending.shift());
  });

  const end = o.warmup + o.minutes * 60;
  while (sim.time < end + FUT_N * FUT_DT + 0.2) {
    sim.advance(10, 1 / 30);
    if (process.send && Math.round(sim.time) % 60 < 10) process.send({ seed: o.seed, t: sim.time, samples: rows.X.length });
  }
  const N = rows.X.length;
  const flat = (list, n) => { const a = new Float32Array(list.length * n); list.forEach((r, i) => a.set(r, i * n)); return a; };
  writeNpy(path.join(dir, 'X.npy'), flat(rows.X, N_FEATURES), [N, N_FEATURES]);
  writeNpy(path.join(dir, 'Y.npy'), flat(rows.Y, FUT_N * 2), [N, FUT_N, 2]);
  writeNpy(path.join(dir, 'M.npy'), flat(rows.M, FUT_N), [N, FUT_N]);
  writeNpy(path.join(dir, 'BL.npy'), flat(rows.BL, 2 * FUT_N * 2), [N, 2, FUT_N, 2]);
  writeNpy(path.join(dir, 'BLP.npy'), flat(rows.BLP, 2), [N, 2]);
  writeNpy(path.join(dir, 'meta.npy'), flat(rows.meta, META.length), [N, META.length]);
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({
    seed: o.seed, samples: N, simulated_seconds: +sim.time.toFixed(1), sample_every_s: every / 10, warmup_s: o.warmup,
    feature_version: FEATURE_VERSION, features: FEATURE_NAMES, history_steps: HIST, future_dt: FUT_DT, future_steps: FUT_N,
    meta_columns: META, state_codes: STATES, frame: 'pedestrian frame: a = metres ahead (the way it faces), b = metres to its right',
    settings: { cars: o.cars, hwy: o.hwy, peds: o.peds, crashes: o.crashes },
    av_stats: sim.planner.stats, created: new Date().toISOString(),
  }, null, 1));
  if (process.send) process.send({ seed: o.seed, done: true, samples: N });
}
