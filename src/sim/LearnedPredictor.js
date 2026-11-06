// A trained pedestrian predictor running inside the simulator: the JSON written by
// ml/train_ped_predictor.py (a small MLP), evaluated in plain JavaScript - no ML library - on the
// same features the training data was made from (PedFeatures.js).
//
//   browser:  ?model=models/ped_mlp.json   (M switches between it and the baseline)
//   headless: npm run evaluate -- --model public/models/ped_mlp.json
//
// Predictions are refreshed whenever the 10 Hz history moves on and reused in between, so the
// network runs ten times a second per pedestrian, not every frame.

import { pedFeatures, toWorld, FEATURE_VERSION, N_FEATURES } from './PedFeatures.js';

const floats = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

/**
 * @param {object} model  parsed model JSON
 * @param {object} sim    the simulation (see Simulation.js) - for map context, traffic and history
 * @returns {Function}    a predictor for sim.setPredictor / planner.custom, with .modelName
 */
export function createLearnedPredictor(model, sim) {
  if (model.format !== 'voxel-av-sim/ped-mlp') throw new Error('Not a pedestrian model file (format voxel-av-sim/ped-mlp)');
  if (model.feature_version !== FEATURE_VERSION || model.n_features !== N_FEATURES) {
    throw new Error(`The model was trained on feature version ${model.feature_version} (${model.n_features} inputs) but the sim `
      + `now computes version ${FEATURE_VERSION} (${N_FEATURES}). Export the data again and retrain.`);
  }
  const layers = model.layers.map((l) => ({ nIn: l.in, nOut: l.out, relu: l.act === 'relu', W: floats(l.W), b: floats(l.b) }));
  const K = model.modes, T = model.steps, dt = model.dt;
  const mean = Float32Array.from(model.mean), std = Float32Array.from(model.std);

  const forward = (x) => {
    let a = new Float32Array(N_FEATURES);
    for (let i = 0; i < N_FEATURES; i++) a[i] = (x[i] - mean[i]) / std[i];
    for (const L of layers) {
      const out = new Float32Array(L.nOut);
      for (let o = 0; o < L.nOut; o++) {
        const row = o * L.nIn;
        let s = L.b[o];
        for (let i = 0; i < L.nIn; i++) s += L.W[row + i] * a[i];
        out[o] = L.relu && s < 0 ? 0 : s;
      }
      a = out;
    }
    return a;
  };

  const history = sim.planner.history, fallback = sim.planner.predictor;
  const ctx = { crosswalks: sim.net.crosswalks, vehicles: sim.traffic.vehicles, onRoad: (x, z) => sim.peds.onRoad(x, z) };
  const cache = new Map();                  // ped -> { tick, hyps } (times relative to the last sample)

  const run = (ped, hist) => {
    const f = pedFeatures(ped, hist, ctx);
    if (!f) return null;                    // no clean second of history yet
    const out = forward(f.x);
    let mx = -Infinity;
    for (let k = 0; k < K; k++) mx = Math.max(mx, out[K * T * 2 + k]);
    const e = Array.from({ length: K }, (_, k) => Math.exp(out[K * T * 2 + k] - mx));
    const tot = e.reduce((p, q) => p + q, 0);
    const onRoadNow = ctx.onRoad(f.frame.x, f.frame.z);
    const hyps = [];
    for (let k = 0; k < K; k++) {
      const prob = e[k] / tot;
      if (prob < 0.02) continue;            // keep the drawing readable
      const traj = [];
      for (let s = 0; s < T; s++) {
        const [x, z] = toWorld(f.frame, out[(k * T + s) * 2], out[(k * T + s) * 2 + 1]);
        traj.push({ t: (s + 1) * dt, x, z });
      }
      const end = traj[T - 1];
      // amber in the view when the path leads into the road
      hyps.push({ prob, kind: !onRoadNow && ctx.onRoad(end.x, end.z) ? 'cross' : 'learned', traj });
    }
    return hyps;
  };

  const predict = (agents) => {
    const age = history.acc;                // seconds since the newest history sample
    return agents.map(({ ped, history: hist }) => {
      let c = cache.get(ped);
      if (!c || c.tick !== history.ticks) {
        c = { tick: history.ticks, hyps: run(ped, hist) };
        cache.set(ped, c);
      }
      if (!c.hyps) return fallback.predict(ped, hist);
      return c.hyps.map((h) => ({ ...h, traj: h.traj.map((q) => ({ t: q.t - age, x: q.x, z: q.z })) }));
    });
  };
  predict.modelName = model.name || 'learned model';
  return predict;
}
