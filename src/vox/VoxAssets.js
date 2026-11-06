// Loads .vox assets (listed in public/assets/manifest.json) into reusable meshes.
//
// Each asset keeps its MagicaVoxel parts (wheels, limbs, signal lamps...) as separate
// meshes so they can be animated. Space conversion: MagicaVoxel (x, y, z) Z-up ->
// three.js (x, z, -y) Y-up, scaled by the asset's voxel size in metres.

import * as THREE from 'three';
import { parseVox } from './VoxParser.js';
import { meshVoxModel, paletteToLinear, MAT, MAT_COUNT } from './VoxMesher.js';

// Vite sets BASE_URL; the headless tools (plain Node) serve public/ from '/'
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'assets/';

// ---------------------------------------------------------------- materials

const lit = (o = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, ...o });
const glow = (k, o = {}) => new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(k, k, k), ...o });

export const Materials = {
  opaque: lit(),
  glass: lit({ roughness: 0.06, metalness: 0.25, transparent: true, opacity: 0.92, depthWrite: false }),
  emit: glow(1.25, { toneMapped: false }),
  head: glow(1.6, { toneMapped: false }),
  brakeOff: glow(0.75),
  brakeOn: glow(2.6, { toneMapped: false }),
  lampOff: lit({ color: 0x3a3a3a }),
  lampOn: glow(2.2, { toneMapped: false }),
};

/** Default material array, indexed by MAT class. */
export function defaultMaterialArray() {
  const a = new Array(MAT_COUNT);
  a[MAT.OPAQUE] = Materials.opaque;
  a[MAT.GLASS] = Materials.glass;
  a[MAT.EMIT] = Materials.emit;
  a[MAT.HEAD] = Materials.head;
  a[MAT.BRAKE] = Materials.brakeOff;
  a[MAT.SIG_RED] = Materials.lampOff;
  a[MAT.SIG_YELLOW] = Materials.lampOff;
  a[MAT.SIG_GREEN] = Materials.lampOff;
  a[MAT.PED_STOP] = Materials.lampOff;
  a[MAT.PED_WALK] = Materials.lampOff;
  return a;
}

const TAG_CLASS = {
  glass: MAT.GLASS,
  emit: MAT.EMIT,
  head: MAT.HEAD,
  brake: MAT.BRAKE,
  sig_red: MAT.SIG_RED,
  sig_yellow: MAT.SIG_YELLOW,
  sig_green: MAT.SIG_GREEN,
  ped_stop: MAT.PED_STOP,
  ped_walk: MAT.PED_WALK,
};

// ------------------------------------------------------------------- assets

let manifestPromise = null;
export function loadManifest() {
  manifestPromise ||= fetch(BASE + 'manifest.json').then((r) => r.json()).then((m) => m.assets);
  return manifestPromise;
}

const assetCache = new Map();

export class VoxAsset {
  constructor(key, meta, parsed) {
    this.key = key;
    this.meta = meta;
    this.voxelSize = meta.voxelSize ?? 0.1;
    const lin = paletteToLinear(parsed.palette);
    const classOf = new Uint8Array(256);
    parsed.matType.forEach((t, i) => {
      if (t === 'glass') classOf[i] = MAT.GLASS;
      else if (t === 'emit') classOf[i] = MAT.EMIT;
    });
    // Generic tags first so specific ones (brake, head, signal lamps) win.
    const tags = meta.tags || {};
    for (const tag of Object.keys(TAG_CLASS)) {
      for (const i of tags[tag] || []) classOf[i] = TAG_CLASS[tag];
    }
    this.palette = parsed.palette;
    this.lin = lin;
    this.classOf = classOf;

    // One geometry per MagicaVoxel shape; geometry is centred on the model volume.
    this.parts = parsed.shapes.filter((s) => !s.hidden).map((s) => {
      const m = parsed.models[s.modelIndex];
      const geometry = meshVoxModel(m, lin, classOf);
      const size = [m.sx, m.sy, m.sz];
      // Volume centre in MagicaVoxel world space: t + R * (size/2 - floor(size/2)).
      const off = size.map((n) => n / 2 - Math.floor(n / 2));
      const r = s.xf.r;
      const centre = [0, 1, 2].map((i) => s.xf.t[i] + r[i * 3] * off[0] + r[i * 3 + 1] * off[1] + r[i * 3 + 2] * off[2]);
      // Voxel-space bounds of this part (for pivots / collision boxes).
      let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      if (geometry) {
        const bb = geometry.boundingBox;
        const corners = [];
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) corners.push([x, y, z]);
        for (const c of corners) {
          for (let i = 0; i < 3; i++) {
            const w = centre[i] + r[i * 3] * c[0] + r[i * 3 + 1] * c[1] + r[i * 3 + 2] * c[2];
            min[i] = Math.min(min[i], w);
            max[i] = Math.max(max[i], w);
          }
        }
      }
      return { name: s.name, geometry, centre, rot: r, size, min, max, model: m };
    }).filter((p) => p.geometry);

    // Asset bounds in metres, three.js axes (x, y-up, z).
    const vs = this.voxelSize;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of this.parts) {
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p.min[i]); mx[i] = Math.max(mx[i], p.max[i]); }
    }
    this.bounds = new THREE.Box3(
      new THREE.Vector3(mn[0] * vs, mn[2] * vs, -mx[1] * vs),
      new THREE.Vector3(mx[0] * vs, mx[2] * vs, -mn[1] * vs),
    );
  }

  /** Build a scene object. Parts are reachable through `obj.userData.parts[name]`. */
  instantiate({ castShadow = true, receiveShadow = true, materials } = {}) {
    const root = new THREE.Group();
    root.name = this.key;
    const vox = new THREE.Group();          // MagicaVoxel space
    vox.rotation.x = -Math.PI / 2;
    vox.scale.setScalar(this.voxelSize);
    root.add(vox);
    const mats = materials || defaultMaterialArray();
    const parts = {};
    for (const p of this.parts) {
      const pivot = new THREE.Group();
      pivot.name = p.name;
      pivot.position.set(...p.centre);
      const r = p.rot;
      if (r[0] !== 1 || r[4] !== 1 || r[8] !== 1) {
        const m = new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
        pivot.quaternion.setFromRotationMatrix(m);
      }
      const mesh = new THREE.Mesh(p.geometry, mats);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      pivot.add(mesh);
      vox.add(pivot);
      parts[p.name] = pivot;
    }
    root.userData.parts = parts;
    root.userData.materials = mats;
    root.userData.asset = this;
    return root;
  }

  /**
   * All parts merged into one geometry in three.js space (metres), for static batching
   * and instancing. Material groups are preserved. `lod = 2` builds a coarser version
   * from the same voxels downsampled 2x (used for far-away instances).
   */
  mergedGeometry(lod = 1) {
    const cacheKey = '_merged' + lod;
    if (this[cacheKey]) return this[cacheKey];
    const vs = this.voxelSize;
    const toThree = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(vs, vs, vs));
    const geos = [];
    for (const p of this.parts) {
      const r = p.rot;
      const m = new THREE.Matrix4().set(
        r[0], r[1], r[2], p.centre[0],
        r[3], r[4], r[5], p.centre[1],
        r[6], r[7], r[8], p.centre[2],
        0, 0, 0, 1);
      let g;
      if (lod === 1) g = p.geometry.clone();
      else {
        g = meshVoxModel(downsample(p.model, lod), this.lin, this.classOf);
        if (!g) continue;
        g.scale(lod, lod, lod);
      }
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toThree, m));
      geos.push(g);
    }
    this[cacheKey] = geos.length ? mergeWithGroups(geos) : this.mergedGeometry(1);
    return this[cacheKey];
  }
}

/** Majority-vote downsampling of a voxel model by an integer factor. */
export function downsample(m, f) {
  const nx = Math.ceil(m.sx / f), ny = Math.ceil(m.sy / f), nz = Math.ceil(m.sz / f);
  const counts = new Map();
  const v = m.xyzi;
  for (let i = 0; i < v.length; i += 4) {
    const cell = ((v[i] / f) | 0) + ((v[i + 1] / f) | 0) * nx + ((v[i + 2] / f) | 0) * nx * ny;
    let c = counts.get(cell);
    if (!c) { c = new Map(); counts.set(cell, c); }
    c.set(v[i + 3], (c.get(v[i + 3]) || 0) + 1);
  }
  const need = Math.max(1, Math.round(f * f * f * 0.3));
  const out = [];
  for (const [cell, c] of counts) {
    let tot = 0, best = 0, bc = 0;
    for (const [col, n] of c) { tot += n; if (n > best) { best = n; bc = col; } }
    if (tot < need) continue;
    out.push(cell % nx, ((cell / nx) | 0) % ny, (cell / (nx * ny)) | 0, bc);
  }
  return { sx: nx, sy: ny, sz: nz, xyzi: new Uint8Array(out) };
}

/** Merge geometries that all carry position/normal/color + material groups. */
export function mergeWithGroups(geos) {
  // Collect triangles per material index across all inputs.
  const per = new Map();
  for (const g of geos) {
    const idx = g.index.array;
    for (const grp of g.groups) {
      const list = per.get(grp.materialIndex) || [];
      list.push({ g, start: grp.start, count: grp.count, idx });
      per.set(grp.materialIndex, list);
    }
  }
  let vTotal = 0;
  for (const g of geos) vTotal += g.attributes.position.count;
  const pos = new Float32Array(vTotal * 3), nrm = new Float32Array(vTotal * 3), col = new Float32Array(vTotal * 3);
  const vBase = new Map();
  let vo = 0;
  for (const g of geos) {
    vBase.set(g, vo);
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    vo += g.attributes.position.count;
  }
  let iTotal = 0;
  for (const list of per.values()) for (const e of list) iTotal += e.count;
  const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  const out = new THREE.BufferGeometry();
  let io = 0;
  for (const m of [...per.keys()].sort((a, b) => a - b)) {
    const start = io;
    for (const e of per.get(m)) {
      const base = vBase.get(e.g);
      for (let k = 0; k < e.count; k++) index[io++] = e.idx[e.start + k] + base;
    }
    out.addGroup(start, io - start, m);
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export async function loadAsset(key) {
  if (assetCache.has(key)) return assetCache.get(key);
  const p = (async () => {
    const manifest = await loadManifest();
    const meta = manifest[key];
    if (!meta) throw new Error(`Unknown asset ${key}`);
    const buf = await fetch(BASE + meta.file).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${meta.file}`);
      return r.arrayBuffer();
    });
    return new VoxAsset(key, meta, parseVox(buf));
  })();
  assetCache.set(key, p);
  return p;
}

export async function loadAssets(keys) {
  const list = await Promise.all(keys.map(loadAsset));
  return Object.fromEntries(keys.map((k, i) => [k, list[i]]));
}
