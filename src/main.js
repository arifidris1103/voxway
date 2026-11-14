// Voxel AV Sim - entry point.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LAYOUT } from './world/RoadNetwork.js';
import { updateSignalVisuals } from './world/WorldBuilder.js';
import { Materials } from './vox/VoxAssets.js';
import { Vehicle, CAR_KEYS } from './sim/Traffic.js';
import { createSimulation, STEP } from './sim/Simulation.js';
import { createLearnedPredictor } from './sim/LearnedPredictor.js';
import { Hud } from './ui/Hud.js';
import { PauseMenu } from './ui/PauseMenu.js';

const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.3, 3500);
camera.position.set(-60, 60, 80);

// sky dome with a hazy horizon (the reference photo is a clear, hazy day)
const SKY = {
  day: { top: new THREE.Color('#3d7fd6'), mid: new THREE.Color('#8fbbe6'), bottom: new THREE.Color('#d6e3ec'), fog: new THREE.Color('#cddbe6') },
  night: { top: new THREE.Color('#05070d'), mid: new THREE.Color('#0d1a2e'), bottom: new THREE.Color('#1d2a3d'), fog: new THREE.Color('#121c2b') },
};
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: SKY.day.top.clone() }, mid: { value: SKY.day.mid.clone() }, bottom: { value: SKY.day.bottom.clone() } },
  vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform vec3 top, mid, bottom; varying vec3 vP;
    void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, pow(clamp(h,0.0,1.0), 0.6)) : bottom;
    c = mix(bottom, c, smoothstep(-0.02, 0.18, h)); gl_FragColor = vec4(c, 1.0); }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMat);
scene.add(sky);
scene.fog = new THREE.Fog(SKY.day.fog.clone(), 280, 1500);

const hemi = new THREE.HemisphereLight(0xd7e8ff, 0x8d8a78, 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SH = 75;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 10, far: 420 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.55, 1, 0.42).normalize();

// ------------------------------------------------------------------- state
let S, net, world, traffic, peds, ego, planner, recorder, hud, menu, kit, assets, headlight, incidents, learned = null;
let paused = false, night = false, camIdx = 0, lodClock = 0, stepAcc = 0;
const CAMS = ['chase', 'iso', 'overview', 'interchange', 'incident', 'hood', 'free'];
const controls = new OrbitControls(camera, canvas);
controls.enabled = false;
controls.enableDamping = true;
const camLook = new THREE.Vector3();
let camHeading = 0;

async function main() {
  // the whole simulation (shared with the headless tools in tools/headless). ?seed=N replays a run:
  // same seed, same traffic, pedestrians and incidents (as long as you don't press J / X / 1-7).
  // The expressways and north_st run on out of town, so a few more cars keep the city as busy.
  S = await createSimulation({
    scene,
    seed: +(params.get('seed') || 0),
    cars: +(params.get('cars') || 76),
    hwy: +(params.get('hwy') || 28),
    fly: +(params.get('fly') || 90),
    peds: +(params.get('peds') || 90),
    crashes: params.has('crashes') ? +params.get('crashes') : 0.8,   // traffic accidents per minute, 0 = off
    car: +(params.get('car') || 7),
  });
  ({ net, world, traffic, peds, ego, planner, recorder, incidents, assets } = S);
  attachKit();
  hud = new Hud(document.body);
  menu = new PauseMenu(document.body, { onResume: () => setPaused(false) });
  document.getElementById('pausebtn').addEventListener('click', (e) => { e.currentTarget.blur(); setPaused(true); });
  S.onRespawn = () => {
    snapCamera();
    hud.toast('AV reached the edge of the map — restarting its loop');
  };
  incidents.onEvent = (e) => {
    if (e.type !== 'collision') return;
    const d = Math.hypot(e.x - ego.pose.x, e.z - ego.pose.z);
    if (d < 260) hud.toast(`Accident: ${e.kind.replace('_', '-')} collision, ${Math.round(d)} m from the AV`);
  };

  headlight = new THREE.SpotLight(0xfff1d6, 0, 60, 0.5, 0.6, 1.2);
  scene.add(headlight, headlight.target);
  if (params.has('night')) setNight(true);

  window.sim = {
    net, traffic, peds, ego, planner, recorder, scene, camera, renderer, seed: S.seed,
    /** Swap in your own pedestrian predictor (see README). */
    setPredictor(fn) {
      planner.custom = fn;
      planner.customName = fn && fn.modelName;
      hud.toast(fn ? `Predictor: ${fn.modelName || 'custom'}` : 'Predictor: baseline');
    },
    incidents,
    /** Cause a traffic accident near the AV: 'distracted' | 'red_light' | 'unsafe_lane_change' (or random). */
    crash(kind) { return incidents.trigger(kind || null, aheadOfEgo(), incidents.egoLanes(ego)); },
    observation: () => recorder.observation(),
    exportScenario: () => recorder.exportScenario(),
    /** Advance the simulation without rendering (testing / batch data generation). */
    advance(seconds, dt = 1 / 30) { for (let t = 0; t < seconds; t += dt) step(dt); },
    /** Seconds simulated so far. */
    get time() { return S.time; },
  };

  // ?model=models/ped_mlp.json: drive with a pedestrian predictor trained with ml/train_ped_predictor.py
  if (params.has('model')) {
    try {
      const res = await fetch(params.get('model'));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      learned = createLearnedPredictor(await res.json(), S);
      window.sim.setPredictor(learned);
    } catch (err) {
      console.error(err);
      hud.toast(`Couldn't load the model ${params.get('model')}: ${err.message}`);
    }
  }

  const loading = document.getElementById('loading');
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 800);
  if (params.has('cam')) camIdx = Math.max(0, CAMS.indexOf(params.get('cam')));
  // optional warm-up so screenshots / demos start mid-action
  const warm = +(params.get('warm') || 0);
  for (let i = 0; i < warm * 30; i++) step(1 / 30);
  // ?jay=<seconds>: send a jaywalker into the AV's path, then run that long (demo shots)
  // ?until=loop | flyover | loopE (or the old names spiral / spiralE): fast-forward until the AV
  // reaches that part of its loop
  if (params.has('until')) {
    const H = net.highway, u = params.get('until');
    const want = () => (u === 'loop' || u === 'spiral' ? ego.lane === H.loopW
      : u === 'loopE' || u === 'spiralE' ? ego.lane === H.loopE
        : ego.pose.y > 20 && ego.lane.kind === 'viaduct');
    for (let i = 0; i < 15 * 1200 && !want(); i++) step(1 / 15);
    for (let i = 0; i < (+params.get('then') || 0) * 30; i++) step(1 / 30);
  }
  if (params.has('crash')) {
    // demo: keep trying until a faulty driver turns into a collision in view
    for (let k = 0; k < 40 && incidents.stats.collisions === 0; k++) {
      incidents.trigger(params.get('crash') === '1' ? 'distracted' : params.get('crash'), aheadOfEgo(), incidents.egoLanes(ego));
      for (let i = 0; i < 90; i++) step(1 / 30);
    }
    for (let i = 0; i < (+params.get('after') || 2) * 30; i++) step(1 / 30);
  }
  if (params.has('jay')) {
    const q = planner.path && planner.path[Math.min(planner.path.length - 1, 32)];
    if (q) peds.forceJaywalk(q);
    for (let i = 0; i < +params.get('jay') * 30; i++) step(1 / 30);
  }
  snapCamera();
  requestAnimationFrame(loop);
}

function aheadOfEgo() {
  const p = planner.path;
  return p && p.length > 30 ? p[Math.min(p.length - 1, 45)] : { x: ego.pose.x, z: ego.pose.z };
}

/** Put the voxel sensor kit on the roof of the current ego car. */
function attachKit() {
  if (kit) kit.parent?.remove(kit);
  kit = assets['props/av_kit'].instantiate({ castShadow: true });
  const body = ego.asset.parts.find((p) => p.name === 'body');
  const pos = body.geometry.attributes.position.array;
  let maxZ = -Infinity;
  for (let i = 2; i < pos.length; i += 3) maxZ = Math.max(maxZ, pos[i]);
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 2] > maxZ - 0.01) { sx += pos[i]; sy += pos[i + 1]; n++; }
  const vs = ego.asset.voxelSize;
  kit.position.set((body.centre[0] + sx / n) * vs, (body.centre[2] + maxZ) * vs, -(body.centre[1] + sy / n) * vs);
  ego.obj.add(kit);
}

let formulaIdx = -1;

function setEgoCar(i) {
  const key = CAR_KEYS[i % CAR_KEYS.length];
  const fresh = new Vehicle(assets[key], ego.lane, ego.s);
  const parent = ego.obj.parent;
  parent.remove(ego.obj);
  for (const k of ['asset', 'obj', 'parts', 'mats', 'length', 'width', 'height', 'wheelR', 'wheelbase']) ego[k] = fresh[k];
  parent.add(ego.obj);
  attachKit();
  ego.updatePose(0);
  hud.toast('AV car: ' + (assets[key].meta.label || key));
}

// ------------------------------------------------------------------ smooth drawing
// The simulation runs in fixed 1/60 s steps, so a seeded run replays exactly. But a screen rarely
// shows exactly one step per frame: at 50 fps it would get 1, 1, 2, 1, 1, 2... steps a frame, and
// the cars would judder against the smoothly following camera, most visibly at highway speed.
// So each frame draws the vehicles (and aims the camera) between their last two steps, `alpha` of
// the way, and puts the real positions back before the next step, so the simulation never sees it.
const drawn = new WeakMap();         // vehicle object -> its transform before the latest step
const view = { x: 0, y: 0, z: 0, heading: 0 };   // where the AV is drawn this frame
let egoPrev = null, touched = [];
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const grab = (o, out = new Array(6)) => {
  out[0] = o.position.x; out[1] = o.position.y; out[2] = o.position.z;
  out[3] = o.rotation.x; out[4] = o.rotation.y; out[5] = o.rotation.z;
  return out;
};

/** Put back the real transforms (after drawing in-between ones). */
function restoreDrawn() {
  for (const [o, c] of touched) { o.position.set(c[0], c[1], c[2]); o.rotation.set(c[3], c[4], c[5]); }
  touched = [];
}

/** Before a step: remember where everything was. */
function rememberPrev() {
  for (const v of traffic.vehicles) {
    const d = drawn.get(v.obj);
    if (d) grab(v.obj, d); else drawn.set(v.obj, grab(v.obj));
  }
  egoPrev = { x: ego.pose.x, y: ego.pose.y, z: ego.pose.z, heading: ego.pose.heading, obj: ego.obj };
}

/** Draw every vehicle `alpha` of the way from its previous step to its latest one. */
function drawBetween(alpha) {
  touched = [];
  for (const v of traffic.vehicles) {
    const o = v.obj, p = drawn.get(o);
    if (!p || alpha >= 1) continue;
    const c = grab(o);
    if (Math.abs(c[0] - p[0]) + Math.abs(c[2] - p[2]) > 10) continue;          // teleported
    touched.push([o, c]);
    o.position.set(p[0] + (c[0] - p[0]) * alpha, p[1] + (c[1] - p[1]) * alpha, p[2] + (c[2] - p[2]) * alpha);
    o.rotation.set(lerpAngle(p[3], c[3], alpha), lerpAngle(p[4], c[4], alpha), lerpAngle(p[5], c[5], alpha));
  }
  const e = ego.pose;
  const q = egoPrev && egoPrev.obj === ego.obj && Math.abs(egoPrev.x - e.x) + Math.abs(egoPrev.z - e.z) < 10 ? egoPrev : e;
  view.x = q.x + (e.x - q.x) * alpha;
  view.y = q.y + (e.y - q.y) * alpha;
  view.z = q.z + (e.z - q.z) * alpha;
  view.heading = lerpAngle(q.heading, e.heading, alpha);
  // the planned path and predictions are drawn from the latest step: keep them with the car
  const g = planner.viz.group;
  g.position.set(view.x - e.x, view.y - e.y, view.z - e.z);
}

// ------------------------------------------------------------------ camera
function egoFrame() {
  const h = view.heading;
  return { x: view.x, y: view.y, z: view.z, fx: Math.sin(h), fz: Math.cos(h) };
}

function cameraGoal(mode, dt) {
  const e = egoFrame();
  let d = camHeading - view.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  camHeading -= d * (1 - Math.exp(-dt * 2.2));
  const fx = Math.sin(camHeading), fz = Math.cos(camHeading);
  switch (mode) {
    case 'chase':
      return { pos: new THREE.Vector3(e.x - fx * 13, e.y + 12.5, e.z - fz * 13), look: new THREE.Vector3(e.x + fx * 10, e.y + 0.4, e.z + fz * 10) };
    case 'iso':
      return { pos: new THREE.Vector3(e.x + 15, e.y + 24, e.z + 19), look: new THREE.Vector3(e.x + e.fx * 5, e.y, e.z + e.fz * 5) };
    case 'overview': {
      const t = S.time * 0.025;
      return { pos: new THREE.Vector3(-70 + Math.sin(t) * 30, 135, 330 + Math.cos(t) * 15), look: new THREE.Vector3(15, 0, -50) };
    }
    case 'incident': {
      // frame the most recent crash (falls back to the chase view)
      const w = incidents && incidents.wrecks[incidents.wrecks.length - 1];
      if (!w) return cameraGoal('chase', 0);
      const t = S.time * 0.15;
      return { pos: new THREE.Vector3(w.pose.x + Math.sin(t) * 17, w.pose.y + 14, w.pose.z + Math.cos(t) * 17), look: new THREE.Vector3(w.pose.x, w.pose.y + 0.5, w.pose.z) };
    }
    case 'interchange': {
      const t = S.time * 0.04;
      return { pos: new THREE.Vector3(-95 + Math.sin(t) * 25, 62, 10 + Math.cos(t) * 10), look: new THREE.Vector3(5, 12, -105) };
    }
    case 'hood':
      return { pos: new THREE.Vector3(e.x - e.fx * 0.6, e.y + 1.55, e.z - e.fz * 0.6), look: new THREE.Vector3(e.x + e.fx * 25, e.y + 1.0, e.z + e.fz * 25) };
    default:
      return null;
  }
}

function snapCamera() {
  Object.assign(view, { x: ego.pose.x, y: ego.pose.y, z: ego.pose.z, heading: ego.pose.heading });
  camHeading = ego.pose.heading;
  const g = cameraGoal(CAMS[camIdx], 0);
  if (g) { camera.position.copy(g.pos); camLook.copy(g.look); camera.lookAt(camLook); }
}

function updateCamera(dt) {
  const mode = CAMS[camIdx];
  controls.enabled = mode === 'free';
  if (mode === 'free') {
    controls.target.lerp(new THREE.Vector3(view.x, view.y, view.z), 1 - Math.exp(-dt * 4));
    controls.update();
    return;
  }
  const g = cameraGoal(mode, dt);
  const k = mode === 'hood' ? 1 - Math.exp(-dt * 20) : 1 - Math.exp(-dt * 4);
  camera.position.lerp(g.pos, k);
  camLook.lerp(g.look, mode === 'hood' ? 1 - Math.exp(-dt * 20) : 1 - Math.exp(-dt * 6));
  camera.lookAt(camLook);
}

// ------------------------------------------------------------------ night
function setNight(on) {
  night = on;
  const S = on ? SKY.night : SKY.day;
  skyMat.uniforms.top.value.copy(S.top);
  skyMat.uniforms.mid.value.copy(S.mid);
  skyMat.uniforms.bottom.value.copy(S.bottom);
  scene.fog.color.copy(S.fog);
  sun.intensity = on ? 0.25 : 2.6;
  sun.color.set(on ? 0x8fa8ff : 0xfff2dc);
  hemi.intensity = on ? 0.22 : 1.05;
  scene.environmentIntensity = on ? 0.08 : 0.35;
  Materials.emit.color.setScalar(on ? 3.2 : 1.25);
  Materials.head.color.setScalar(on ? 4 : 1.6);
  headlight.intensity = on ? 900 : 0;
  hud.toast(on ? 'Night drive' : 'Day');
}

// ------------------------------------------------------------------ loop
function step(dt) {
  restoreDrawn();
  rememberPrev();
  peds.focus.set(camera.position.x, 0, camera.position.z);     // only decides who gets drawn
  S.step(dt);
}

// The shadow map covers a square around the AV that moves with it. Moving it by less than one
// shadow-map texel makes every shadow edge shimmer, so it moves in whole texels.
const SHADOW_X = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
const SHADOW_Y = new THREE.Vector3().crossVectors(SUN_DIR, SHADOW_X);
const SHADOW_TEXEL = (2 * SH) / sun.shadow.mapSize.x;
function snapToShadowTexel(f) {
  const a = f.dot(SHADOW_X), b = f.dot(SHADOW_Y);
  f.addScaledVector(SHADOW_X, Math.round(a / SHADOW_TEXEL) * SHADOW_TEXEL - a);
  f.addScaledVector(SHADOW_Y, Math.round(b / SHADOW_TEXEL) * SHADOW_TEXEL - b);
}

const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  // fixed time step, so a seeded run replays exactly; the frame is drawn between the last two
  // steps (see drawBetween), so motion stays even whatever the screen's frame rate
  restoreDrawn();
  if (!paused) {
    stepAcc += dt;
    let n = 0;
    while (stepAcc >= STEP && n < 4) { step(STEP); stepAcc -= STEP; n++; }
    if (n === 4) stepAcc = Math.min(stepAcc, STEP);                 // far behind: don't spiral
  }
  drawBetween(Math.min(1, stepAcc / STEP));
  updateSignalVisuals(world.signals, S.time);
  if ((lodClock -= dt) <= 0) { lodClock = 0.25; world.instancer.updateLod(camera.position); }
  if (kit) kit.userData.parts.lidar.rotation.z += dt * 14;
  updateCamera(dt);

  // follow the ego with the shadow frustum
  const f = new THREE.Vector3(view.x, 0, view.z);
  if (CAMS[camIdx] === 'overview') f.set(0, 0, 40);
  if (CAMS[camIdx] === 'interchange') f.set(-10, 0, -95);
  const lastWreck = incidents.wrecks[incidents.wrecks.length - 1];
  if (CAMS[camIdx] === 'incident' && lastWreck) f.set(lastWreck.pose.x, 0, lastWreck.pose.z);
  snapToShadowTexel(f);
  sun.target.position.copy(f);
  sun.position.copy(f).addScaledVector(SUN_DIR, 200);
  // fade the expressway when the AV drives underneath it (under the viaduct and the ramps beside
  // it, or looping under the flyover), so the chase camera can see the car
  const V = LAYOUT.viaduct, FO = LAYOUT.flyover;
  const under = (CAMS[camIdx] === 'chase' || CAMS[camIdx] === 'iso')
    && ((Math.abs(ego.pose.x - V.x) < V.halfWidth + 12 && ego.pose.y < 1)
      || (Math.abs(ego.pose.z - FO.z) < FO.halfWidth + 6 && ego.pose.y > 4 && ego.pose.y < FO.height - 3));
  for (const m of world.viaduct) {
    const tgt = under ? 0.22 : m === world.viaduct[1] ? 0.45 : 1;
    m.material.opacity += (tgt - m.material.opacity) * Math.min(1, dt * 5);
    m.material.depthWrite = m.material.opacity > 0.95;
  }
  if (night) {
    const h = view.heading;
    headlight.position.set(view.x + Math.sin(h) * 2, view.y + 1.0, view.z + Math.cos(h) * 2);
    headlight.target.position.set(view.x + Math.sin(h) * 20, view.y, view.z + Math.cos(h) * 20);
  }
  hud.update(dt, { ego, planner, traffic, peds, camMode: CAMS[camIdx], carLabel: ego.asset.meta.label, paused, seed: S.seed });
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ input
/** Pause the simulation and show the pause menu (all the controls are listed there). */
function setPaused(on) {
  paused = on;
  menu?.show(on);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

addEventListener('keydown', (e) => {
  if (!ego) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { camIdx = (camIdx + 1) % CAMS.length; if (CAMS[camIdx] === 'free') { controls.target.set(ego.pose.x, 0, ego.pose.z); } hud.toast('Camera: ' + CAMS[camIdx]); }
  else if (k === 'p') { planner.showPredictions = !planner.showPredictions; hud.toast(planner.showPredictions ? 'Showing AV predictions' : 'Predictions hidden'); }
  else if (k === 'n') setNight(!night);
  else if (k === 'x') {
    const hwy = ego.pose.y > 2;                       // on the expressway: a speeding driver near the AV
    const ok = incidents.trigger(hwy ? 'speeding' : null, aheadOfEgo(), incidents.egoLanes(ego));
    hud.toast(!ok ? 'No suitable traffic nearby — try again' : hwy ? 'A speeding driver is weaving through traffic…' : 'A driver ahead just made a mistake…');
  }
  else if (k === ' ' || k === 'escape') { setPaused(!paused); e.preventDefault(); }
  else if (k === 'j') {
    const q = planner.path && planner.path[Math.min(planner.path.length - 1, 40)];
    if (q && peds.forceJaywalk(q)) hud.toast('A pedestrian is about to cross…'); else hud.toast('No sidewalk nearby');
  } else if (k === 'r') {
    const sc = recorder.exportScenario();
    if (!sc) return;
    const blob = new Blob([JSON.stringify(sc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sc.scenario_id + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    hud.toast(`Exported ${sc.tracks.length} tracks × ${sc.timestamps_seconds.length} steps`);
  } else if (k === 'm') {
    if (!learned) hud.toast('No model loaded: add ?model=models/ped_mlp.json to the URL');
    else window.sim.setPredictor(planner.custom === learned ? null : learned);
  } else if (k >= '1' && k <= '7') setEgoCar(+k - 1);
  else if (k === 'f') {
    // cycle through the formula cars, which follow the 7 road cars in CAR_KEYS
    const n = CAR_KEYS.length - 7;
    formulaIdx = (formulaIdx + 1) % n;
    setEgoCar(7 + formulaIdx);
  }
});

main().catch((err) => {
  console.error(err);
  document.getElementById('loading').textContent = 'Failed to load: ' + err.message;
});
