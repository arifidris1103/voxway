// Jointed rig for the voxel pedestrians.
//
// The NPC .vox files are split into 10 named parts (head, body, arm_upper_R/L,
// arm_lower_R/L, leg_upper_R/L, leg_lower_R/L). This rig re-parents them under joint
// pivots placed at the top of each limb so they can walk, wait, run and hop.
// Rig space is MagicaVoxel space (Z up, facing -Y); the root converts to three.js.

import * as THREE from 'three';
import { defaultMaterialArray } from '../vox/VoxAssets.js';
import { random } from './Random.js';

const LIMBS = ['R', 'L'];

export class Npc {
  constructor(asset, { castShadow = true } = {}) {
    this.asset = asset;
    this.root = new THREE.Group();            // three.js space; the sim moves this
    this.root.name = asset.key;
    const vox = new THREE.Group();
    vox.rotation.x = -Math.PI / 2;
    vox.scale.setScalar(asset.voxelSize);
    this.root.add(vox);
    this.vox = vox;
    const parts = Object.fromEntries(asset.parts.map((p) => [p.name, p]));
    this.parts = parts;
    const mats = defaultMaterialArray();

    const meshOf = (p) => {
      const m = new THREE.Mesh(p.geometry, mats);
      m.castShadow = castShadow;
      m.receiveShadow = false;
      return m;
    };
    const pivotAt = (parent, pos, parentPos = [0, 0, 0]) => {
      const g = new THREE.Group();
      g.position.set(pos[0] - parentPos[0], pos[1] - parentPos[1], pos[2] - parentPos[2]);
      parent.add(g);
      return g;
    };
    const attach = (pivot, pivotPos, p) => {
      const m = meshOf(p);
      m.position.set(p.centre[0] - pivotPos[0], p.centre[1] - pivotPos[1], p.centre[2] - pivotPos[2]);
      pivot.add(m);
      return m;
    };

    // Hip height = top of the upper legs.
    const legU = parts.leg_upper_R || parts.leg_upper_L;
    const hipZ = legU ? legU.max[2] - 1 : 12;
    const torsoPos = [0, 0, hipZ];
    this.torso = pivotAt(vox, torsoPos);
    this.torsoBase = this.torso.position.clone();
    if (parts.body) attach(this.torso, torsoPos, parts.body);

    this.joints = {};
    if (parts.head) {
      const neck = [parts.head.centre[0], parts.head.centre[1], parts.head.min[2] + 1];
      const j = pivotAt(this.torso, neck, torsoPos);
      attach(j, neck, parts.head);
      this.joints.neck = j;
    }
    for (const s of LIMBS) {
      const au = parts['arm_upper_' + s], al = parts['arm_lower_' + s];
      if (au) {
        const sh = [au.centre[0], au.centre[1], au.max[2] - 1];
        const js = pivotAt(this.torso, sh, torsoPos);
        attach(js, sh, au);
        this.joints['shoulder' + s] = js;
        if (al) {
          const el = [al.centre[0], al.centre[1], al.max[2] - 1];
          const je = pivotAt(js, el, sh);
          attach(je, el, al);
          this.joints['elbow' + s] = je;
        }
      }
      const lu = parts['leg_upper_' + s], ll = parts['leg_lower_' + s];
      if (lu) {
        const hp = [lu.centre[0], lu.centre[1], lu.max[2] - 1];
        const jh = pivotAt(this.torso, hp, torsoPos);
        attach(jh, hp, lu);
        this.joints['hip' + s] = jh;
        if (ll) {
          const kn = [lu.centre[0], lu.centre[1], ll.max[2] - 1];
          const jk = pivotAt(jh, kn, hp);
          attach(jk, kn, ll);
          this.joints['knee' + s] = jk;
        }
      }
    }
    // Height in metres (top of head) for sensors / bounding boxes.
    let top = 0;
    for (const p of asset.parts) top = Math.max(top, p.max[2]);
    this.height = top * asset.voxelSize;
    this.phase = random() * Math.PI * 2;
    this.time = random() * 10;
    this.hop = 0;          // 0..1 progress of the current hop (sim-driven)
  }

  /**
   * @param {number} dt
   * @param {'idle'|'wait'|'walk'|'run'|'hop'} mode
   * @param {number} speed  ground speed in m/s (drives the stride)
   */
  update(dt, mode = 'idle', speed = 1.3) {
    this.time += dt;
    const j = this.joints;
    const set = (name, x = 0, y = 0, z = 0) => { if (j[name]) j[name].rotation.set(x, y, z); };
    let bob = 0;

    if (mode === 'walk' || mode === 'run') {
      const run = mode === 'run';
      const stride = run ? 1.5 : 1.05;                         // metres per full cycle
      this.phase += (speed * dt / stride) * Math.PI * 2;
      const s = Math.sin(this.phase);
      const legA = run ? 0.75 : 0.5, armA = run ? 0.8 : 0.45;
      // Negative X rotation swings a limb forward (towards -Y).
      set('hipR', -s * legA); set('hipL', s * legA);
      set('kneeR', Math.max(0, Math.sin(this.phase - 1.2)) * (run ? 1.2 : 0.7));
      set('kneeL', Math.max(0, Math.sin(this.phase + Math.PI - 1.2)) * (run ? 1.2 : 0.7));
      set('shoulderR', s * armA, 0, 0.06); set('shoulderL', -s * armA, 0, -0.06);
      set('elbowR', run ? -0.9 : -0.25); set('elbowL', run ? -0.9 : -0.25);
      set('neck', 0, 0, 0);
      bob = Math.abs(Math.cos(this.phase)) * (run ? 1.6 : 0.9);
      this.torso.rotation.x = run ? -0.12 : -0.03;
    } else if (mode === 'hop') {
      // Crossy-style hop: crouch -> launch (tucked) -> land. this.hop in [0, 1).
      const p = this.hop;
      const crouch = p < 0.18 ? p / 0.18 : p > 0.82 ? (1 - p) / 0.18 : 0;
      const air = p >= 0.18 && p <= 0.82 ? Math.sin(((p - 0.18) / 0.64) * Math.PI) : 0;
      set('hipR', -0.55 * air - 0.5 * crouch); set('hipL', -0.55 * air - 0.5 * crouch);
      set('kneeR', 1.0 * air + 1.0 * crouch); set('kneeL', 1.0 * air + 1.0 * crouch);
      set('shoulderR', -1.9 * air + 0.4 * crouch, 0, 0.25 * air); set('shoulderL', -1.9 * air + 0.4 * crouch, 0, -0.25 * air);
      set('elbowR', -0.4 * air); set('elbowL', -0.4 * air);
      set('neck', 0.15 * crouch, 0, 0);
      this.torso.rotation.x = -0.25 * crouch + 0.05 * air;
      bob = -3.2 * crouch;
    } else {
      // idle / wait: breathing + (when waiting at a kerb) looking along the road.
      const t = this.time;
      set('hipR'); set('hipL'); set('kneeR'); set('kneeL');
      set('shoulderR', Math.sin(t * 1.6) * 0.04, 0, 0.05); set('shoulderL', -Math.sin(t * 1.6) * 0.04, 0, -0.05);
      set('elbowR', -0.12); set('elbowL', -0.12);
      const look = mode === 'wait' ? Math.sin(t * 0.9) * 0.9 : Math.sin(t * 0.5) * 0.15;
      set('neck', 0, 0, look);
      this.torso.rotation.x = 0;
      bob = Math.sin(t * 2.2) * 0.25;
    }
    this.torso.position.z = this.torsoBase.z + bob;
  }
}
