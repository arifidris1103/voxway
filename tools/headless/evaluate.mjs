// Closed-loop comparison: the AV drives the same seeded scenarios once with the hand-written
// baseline pedestrian predictor and once with your trained model, and its driving is compared.
// Offline scores (the training script) say how well a model guesses; this says whether the car
// actually drives better with it. One process per run, seeds in parallel.
//
//   npm run evaluate -- --model public/models/ped_mlp.json --seeds 101-108 --minutes 5
//
// Options: --seeds 101-108 (use seeds you didn't train on)  --minutes 5  --crashes 0 (traffic
//          accidents per minute; 0 keeps the comparison about pedestrians)  --jobs N  --out file.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseSeeds, runPool, childTask } from './cli.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');
const DEFAULTS = { model: 'public/models/ped_mlp.json', seeds: '101-108', minutes: 5, crashes: 0, jobs: 0, out: '' };
const METRICS = [
  ['pedContacts', 'pedestrian collisions', (v) => v.toFixed(2), 'lower'],
  ['closeCalls', 'pedestrians passed within 1 m', (v) => v.toFixed(1), 'lower'],
  ['minGap', 'closest pedestrian while moving (m)', (v) => v.toFixed(2), 'higher'],
  ['yieldTime', 'time spent yielding (s)', (v) => v.toFixed(1), 'lower'],
  ['cautionTime', 'time creeping with caution (s)', (v) => v.toFixed(1), 'lower'],
  ['yields', 'yield decisions', (v) => v.toFixed(1), 'lower'],
  ['hardBrakes', 'hard braking events (< -3 m/s²)', (v) => v.toFixed(1), 'lower'],
  ['speed', 'average speed (km/h)', (v) => v.toFixed(1), 'higher'],
];

const task = childTask();
if (task) await runOne(task);
else await main();

async function main() {
  const o = parseArgs(process.argv.slice(2), DEFAULTS);
  const modelPath = path.resolve(ROOT, o.model);
  if (!fs.existsSync(modelPath)) {
    console.error(`No model at ${o.model}. Train one first: python ml/train_ped_predictor.py`);
    process.exit(1);
  }
  const seeds = parseSeeds(o.seeds);
  console.log(`Driving ${seeds.length} seed(s) x ${o.minutes} min, baseline vs ${path.relative(ROOT, modelPath)} (crashes ${o.crashes}/min)`);
  const tasks = seeds.flatMap((seed) => ['baseline', 'model'].map((who) => ({ ...o, seed, who, modelPath })));
  const res = { baseline: {}, model: {} };
  await runPool(HERE, tasks, o.jobs, (m) => {
    res[m.who][m.seed] = m.metrics;
    console.log(`  seed ${m.seed} ${m.who.padEnd(8)} ${METRICS.map(([k, , f]) => f(m.metrics[k])).join('  ')}`);
  });
  const done = seeds.filter((s) => res.baseline[s] && res.model[s]);
  const mean = (who, k) => done.reduce((a, s) => a + res[who][s][k], 0) / done.length;
  console.log(`\nAverage over ${done.length} seed(s), ${o.minutes} min each:`);
  console.log(`${''.padEnd(38)} ${'baseline'.padStart(9)} ${'model'.padStart(9)}`);
  for (const [k, label, f, better] of METRICS) {
    const b = mean('baseline', k), m = mean('model', k);
    const verdict = Math.abs(m - b) < 1e-9 ? '' : (better === 'lower' ? m < b : m > b) ? '  better' : '  worse';
    console.log(`${label.padEnd(38)} ${f(b).padStart(9)} ${f(m).padStart(9)}${verdict}`);
  }
  if (o.out) {
    fs.writeFileSync(path.resolve(ROOT, o.out), JSON.stringify({ settings: o, runs: res }, null, 1));
    console.log(`Saved ${o.out}`);
  }
}

/** One seed with one predictor (runs in a child process). */
async function runOne(o) {
  const { createSimulation } = await import('./node-sim.mjs');
  const { createLearnedPredictor } = await import('../../src/sim/LearnedPredictor.js');
  const sim = await createSimulation({ seed: o.seed, crashes: o.crashes });
  if (o.who === 'model') sim.planner.custom = createLearnedPredictor(JSON.parse(fs.readFileSync(o.modelPath, 'utf8')), sim);
  const ego = sim.ego, P = sim.planner;
  const m = { yieldTime: 0, cautionTime: 0, hardBrakes: 0, closeCalls: 0 };
  const close = new Set();
  let braking = false;
  sim.onStep.push((dt) => {
    if (P.state === 'YIELD') m.yieldTime += dt;
    if (P.state === 'CAUTION') m.cautionTime += dt;
    if (ego.a < -3 && !braking) m.hardBrakes++;
    braking = ego.a < -3;
    if (ego.v < 1) return;
    const fx = Math.sin(ego.pose.heading), fz = Math.cos(ego.pose.heading);
    for (const p of sim.peds.peds) {
      const dx = p.pos.x - ego.pose.x, dz = p.pos.z - ego.pose.z;
      if (Math.abs(dx) > 8 || Math.abs(dz) > 8 || p.y > 0.1) continue;
      const lon = Math.abs(dx * fx + dz * fz) - ego.length / 2, lat = Math.abs(dx * fz - dz * fx) - ego.width / 2;
      if (Math.hypot(Math.max(lon, 0), Math.max(lat, 0)) - p.radius < 1) close.add(p.id);
    }
  });
  sim.advance(o.minutes * 60, 1 / 30);
  m.closeCalls = close.size;
  m.pedContacts = P.stats.collisions;
  m.minGap = Number.isFinite(P.stats.minPedGap) ? Math.max(0, P.stats.minPedGap) : 0;
  m.yields = P.stats.pedYields;
  m.speed = (P.stats.distance / sim.time) * 3.6;
  process.send({ seed: o.seed, who: o.who, metrics: m });
}
