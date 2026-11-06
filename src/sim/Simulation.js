// Builds the whole simulation (city, traffic, pedestrians, the AV and its planner, incidents and
// the scenario recorder) and steps it. Shared by the browser app (main.js) and the headless tools
// in tools/headless (dataset export, closed-loop evaluation), so training data comes from exactly
// the simulation you watch. Nothing in here depends on the camera or on rendering.

import * as THREE from 'three';
import { RoadNetwork } from '../world/RoadNetwork.js';
import { buildWorld } from '../world/WorldBuilder.js';
import { loadAssets } from '../vox/VoxAssets.js';
import { Traffic, Vehicle, CAR_KEYS } from './Traffic.js';
import { Pedestrians, NPC_KEYS } from './Pedestrians.js';
import { EgoPlanner } from './EgoPlanner.js';
import { ScenarioRecorder } from './Recorder.js';
import { Incidents } from './Incidents.js';
import { seedRandom } from './Random.js';

/** Fixed simulation step (s): the browser takes one per frame at 60 Hz. */
export const STEP = 1 / 60;

/**
 * @param {object} o
 * @param {THREE.Scene} [o.scene]  scene to build into (a bare Scene when headless)
 * @param {number} [o.seed]        random seed; 0 / missing = a random one (see sim.seed)
 * @param {number} [o.cars]        ground traffic
 * @param {number} [o.hwy]         expressway traffic
 * @param {number} [o.peds]        pedestrians
 * @param {number} [o.crashes]     traffic accidents per minute (0 = off)
 * @param {number} [o.car]         the AV's car, 1-7
 */
export async function createSimulation({
  scene = new THREE.Scene(), seed = 0, cars = 76, hwy = 72, peds: pedCount = 90, crashes = 0.8, car = 7,
} = {}) {
  const usedSeed = seedRandom(seed);
  const net = new RoadNetwork(7);
  const world = await buildWorld(scene, net);
  const assets = await loadAssets([...CAR_KEYS, ...NPC_KEYS, 'props/av_kit', 'props/warning_triangle']);
  const traffic = new Traffic(scene, net, assets, { ground: cars, viaduct: hwy });
  const peds = new Pedestrians(scene, net, assets, { count: pedCount });
  traffic.peds = peds;
  peds.spawnAll(world.blocks);

  // the AV starts on center_st heading east
  const seg = net.segments.find((s) => s.road.id === 'center_st' && s.a === -160 && s.b === 0);
  const startLane = seg.lanes.EB[1];
  const planner = new EgoPlanner(net, traffic, peds, scene);
  const ego = new Vehicle(assets[CAR_KEYS[(car - 1) % CAR_KEYS.length]], startLane, 30, { ego: true, desire: 1.0, T: 1.5, amax: 1.9, v: 6 });
  ego.planner = planner;
  traffic.add(ego);
  traffic.ego = ego;
  traffic.populate();
  const recorder = new ScenarioRecorder(net);
  const incidents = new Incidents(scene, net, traffic, peds, assets, { rate: crashes / 60 });
  traffic.incidents = incidents;
  recorder.incidents = incidents;

  const sim = {
    seed: usedSeed, time: 0, net, world, assets, traffic, peds, ego, planner, recorder, incidents, startLane,
    onRespawn: null,          // called after the AV has been put back at the start of its loop
    onStep: [],               // extra hooks run after every step, e.g. the dataset sampler

    step(dt = STEP) {
      this.time += dt;
      for (const I of net.intersections) I.signal.update(dt);
      traffic.update(dt);
      incidents.update(dt, this.time, ego);
      peds.anchor.set(ego.pose.x, 0, ego.pose.z);
      peds.update(dt, traffic.vehicles, this.time);
      planner.update(dt, ego, this.time);
      recorder.update(dt, ego, traffic, peds);
      for (const f of this.onStep) f(dt, this);
    },

    /** Run the simulation for `seconds` without rendering. */
    advance(seconds, dt = STEP) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) this.step(dt);
    },
  };

  // safety net: if the AV ever runs off the map, put it back at the start of its loop
  traffic.onEgoDeadEnd = (v) => {
    v.path = [startLane];
    v.s = 30;
    v.v = 6;
    v.lc = null;
    v.wantsLane = null;
    traffic.planPath(v);
    v.updatePose(0);
    incidents.log('ego_respawn', [], v.pose.x, v.pose.z);
    if (sim.onRespawn) sim.onRespawn(v);
  };
  return sim;
}
