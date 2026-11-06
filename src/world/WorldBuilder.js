// Builds the static city: ground, roads, markings, sidewalks, the elevated
// expressway and every voxel prop / building (instanced).

import * as THREE from 'three';
import { LAYOUT, LANE_W, roadHalfWidth, lateral } from './RoadNetwork.js';
import { loadAssets, defaultMaterialArray, Materials } from '../vox/VoxAssets.js';
import { MAT } from '../vox/VoxMesher.js';

const C = (hex) => new THREE.Color(hex);   // sRGB hex -> linear working colour

// ------------------------------------------------------------------ batching

/** Accumulates coloured boxes / quads into one non-indexed geometry. */
class Batch {
  constructor() { this.p = []; this.n = []; this.c = []; }

  quad(a, b, c, d, nrm, col) {
    for (const v of [a, b, c, a, c, d]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nrm[0], nrm[1], nrm[2]);
      this.c.push(col.r, col.g, col.b);
    }
  }

  /** Axis-aligned box; `top` and `side` colours; bottom face skipped. */
  box(x0, y0, z0, x1, y1, z1, top, side = top, bottom = false) {
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], top);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], side);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], side);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], side);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], side);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], side);
  }

  /** Flat quad on top of the ground at height y (thin road markings). */
  flat(x0, z0, x1, z1, y, col) {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], col);
  }

  /** Oriented flat rectangle: centre, half sizes along (ux, uz) and its normal. */
  flatOriented(cx, cz, ux, uz, hl, hw, y, col) {
    const vx = -uz, vz = ux;
    const p = (a, b) => [cx + ux * a + vx * b, y, cz + uz * a + vz * b];
    this.quad(p(-hl, hw), p(hl, hw), p(hl, -hw), p(-hl, -hw), [0, 1, 0], col);
  }

  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    return m;
  }
}

// deterministic noise for colour jitter
const hash = (x, z) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const jitter = (col, x, z, amt = 0.05) => col.clone().multiplyScalar(1 - amt + hash(x, z) * amt * 2);

const COL = {
  asphalt: C('#4a4d52'),
  asphaltDark: C('#3f4246'),
  white: C('#ecebe6'),
  yellow: C('#e4bd3b'),
  sidewalk: C('#cdc8be'),
  curb: C('#dedbd3'),
  tactile: C('#e2c23a'),
  grass: C('#9aa565'),
  lawn: C('#b9b077'),
  green: C('#a2ac6f'),
  plaza: C('#c9c3b6'),
  compound: C('#bdb7aa'),
  path: C('#ddd8cc'),
  dirt: C('#8f7a5e'),
  ground: C('#a2ac6f'),      // same green as the city blocks, so the edge of town doesn't show as a hard line
  concrete: C('#c8c5bd'),
  concreteDark: C('#a9a69e'),
  deckTop: C('#55585d'),
  teal: C('#2f8f80'),
  orange: C('#d9682b'),
  median: C('#8d9b5c'),
};

// ------------------------------------------------------------------- builder

export const ASSET_KEYS = [
  'props/street_lamp', 'props/viaduct_lamp', 'props/signal_mast_short', 'props/signal_mast_long',
  'props/ped_signal', 'props/cone', 'props/barrier', 'props/sign_roadwork', 'props/bench', 'props/bin',
  'props/bollard', 'props/bus_shelter', 'props/gantry', 'props/tree_plane_a', 'props/tree_plane_b',
  'props/tree_plane_c', 'props/tree_cypress', 'props/shrub', 'props/flowerbed', 'props/pier',
  'props/pier_portal', 'props/pier_ramp',
  'buildings/resi_redroof_a', 'buildings/resi_redroof_b', 'buildings/resi_redroof_c', 'buildings/resi_redroof_d',
  'buildings/tower_resi_a', 'buildings/tower_resi_b', 'buildings/tower_resi_c',
  'buildings/office_glass_a', 'buildings/office_glass_b', 'buildings/office_glass_c',
  'buildings/shops_a', 'buildings/shops_b',
];

/**
 * Instanced placement split into spatial chunks so the camera and the shadow
 * camera can cull per chunk, with a coarse LOD mesh swapped in for far chunks.
 */
const CHUNK = 120;
const LOD_DIST = 230;

class Instancer {
  constructor(assets) { this.assets = assets; this.items = new Map(); this.chunks = []; }

  add(key, x, y, z, rotY = 0, scale = 1) {
    const ck = key + '|' + Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
    if (!this.items.has(ck)) this.items.set(ck, { key, list: [] });
    this.items.get(ck).list.push([x, y, z, rotY, scale]);
  }

  build(parent, { shadowFor = () => true } = {}) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const { key, list } of this.items.values()) {
      const asset = this.assets[key];
      const make = (geo) => {
        const mesh = new THREE.InstancedMesh(geo, defaultMaterialArray(), list.length);
        list.forEach(([x, y, z, r, sc], i) => {
          q.setFromAxisAngle(up, r);
          if (Array.isArray(sc)) s.set(sc[0], sc[1], sc[2]); else s.setScalar(sc);
          p.set(x, y, z);
          m4.compose(p, q, s);
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = shadowFor(key);
        mesh.receiveShadow = true;
        mesh.name = key;
        parent.add(mesh);
        return mesh;
      };
      const hi = make(asset.mergedGeometry(1));
      const big = (asset.voxelSize >= 0.15 && !key.endsWith('flowerbed')) || key.startsWith('buildings/');
      const lo = big ? make(asset.mergedGeometry(2)) : null;
      if (lo) { lo.visible = false; lo.castShadow = false; }
      this.chunks.push({ hi, lo, centre: hi.boundingSphere.center.clone(), radius: hi.boundingSphere.radius });
    }
  }

  /** Swap far chunks to their coarse mesh (call every few frames). */
  updateLod(camPos) {
    for (const c of this.chunks) {
      if (!c.lo) continue;
      const far = c.centre.distanceTo(camPos) - c.radius > LOD_DIST;
      c.hi.visible = !far;
      c.lo.visible = far;
    }
  }
}

export async function buildWorld(scene, net) {
  const assets = await loadAssets(ASSET_KEYS);
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);
  const B = LAYOUT.bounds;
  const L = LAYOUT;
  const lit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const ground = new Batch();
  const roads = new Batch();
  const marks = new Batch();
  const curbs = new Batch();
  const inst = new Instancer(assets);
  const rnd = net.rand;

  const xs = L.avenues.map((a) => a.x), zs = L.streets.map((s) => s.z);
  const av = (x) => L.avenues.find((a) => a.x === x);
  const st = (z) => L.streets.find((s) => s.z === z);

  // --- big ground plane (beyond the city it fades into fog)
  const far = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: COL.ground, roughness: 1 }));
  far.rotation.x = -Math.PI / 2;
  far.position.y = -0.03;
  far.receiveShadow = true;
  root.add(far);

  // --- road asphalt (4 m tiles with colour jitter for a voxel-tile feel)
  const tile = (x0, z0, x1, z1) => {
    const T = 4;
    for (let x = x0; x < x1 - 1e-6; x += T) {
      for (let z = z0; z < z1 - 1e-6; z += T) {
        roads.flat(x, z, Math.min(x + T, x1), Math.min(z + T, z1), 0.01, jitter(COL.asphalt, x, z, 0.06));
      }
    }
  };
  for (const seg of net.segments) {
    const hw = seg.hw;
    if (seg.axis === 'z') {
      const a = seg.ia ? seg.a + seg.ia.hwZ : -B - 40, b = seg.ib ? seg.b - seg.ib.hwZ : B + 40;
      tile(seg.road.x - hw, a, seg.road.x + hw, b);
    } else {
      const a = seg.ia ? seg.a + seg.ia.hwX : -B - 40, b = seg.ib ? seg.b - seg.ib.hwX : B + 40;
      tile(a, seg.road.z - hw, b, seg.road.z + hw);
    }
  }
  for (const I of net.intersections) tile(I.x - I.hwX, I.z - I.hwZ, I.x + I.hwX, I.z + I.hwZ);

  // --- blocks: raised sidewalk slab with curb + interior surface
  const xEdges = [-B - 40, ...xs, B + 40], zEdges = [-B - 40, ...zs, B + 40];
  const blocks = [];
  for (let i = 0; i < xEdges.length - 1; i++) {
    for (let j = 0; j < zEdges.length - 1; j++) {
      const aw = av(xEdges[i]), ae = av(xEdges[i + 1]);
      const sn = st(zEdges[j]), ss = st(zEdges[j + 1]);
      const x0 = aw ? aw.x + roadHalfWidth(aw) : xEdges[i];
      const x1 = ae ? ae.x - roadHalfWidth(ae) : xEdges[i + 1];
      const z0 = sn ? sn.z + roadHalfWidth(sn) : zEdges[j];
      const z1 = ss ? ss.z - roadHalfWidth(ss) : zEdges[j + 1];
      const swW = aw ? aw.sidewalk : 0, swE = ae ? ae.sidewalk : 0, swN = sn ? sn.sidewalk : 0, swS = ss ? ss.sidewalk : 0;
      const blk = { i, j, x0, x1, z0, z1, in: { x0: x0 + swW, x1: x1 - swE, z0: z0 + swN, z1: z1 - swS } };
      blocks.push(blk);
      curbs.box(x0, 0, z0, x1, 0.15, z1, COL.sidewalk, COL.curb);
    }
  }
  // sidewalk paving tiles + interiors
  const blockType = (b) => {
    if (b.i === 1 && (b.j === 1 || b.j === 2)) return 'compound';
    if (b.i === 2 && b.j === 1) return 'plaza';
    if (b.i === 2 && b.j === 2) return 'park';
    if (b.j === 3) return 'compound';            // low-rise in the foreground of the overview
    if (b.i === 0 || b.i === 3) return b.j % 2 ? 'compound' : 'towers';
    return 'towers';
  };
  for (const b of blocks) {
    b.type = blockType(b);
    const { x0, x1, z0, z1 } = b.in;
    const col = b.type === 'park' ? COL.lawn : b.type === 'plaza' ? COL.plaza : COL.green;
    for (let x = x0; x < x1 - 1e-6; x += 8) {
      for (let z = z0; z < z1 - 1e-6; z += 8) {
        ground.flat(x, z, Math.min(x + 8, x1), Math.min(z + 8, z1), 0.175, jitter(col, x, z, 0.05));
      }
    }
  }

  // --- boulevard median (raised planter under the viaduct), cut at intersections
  const blvd = L.avenues.find((a) => a.id === 'boulevard');
  for (const seg of net.segments) {
    if (seg.road !== blvd) continue;
    const a = seg.ia ? seg.a + seg.ia.dNS - LAYOUT.stopGap + 0.5 : -B - 40;
    const b = seg.ib ? seg.b - seg.ib.dNS + LAYOUT.stopGap - 0.5 : B + 40;
    curbs.box(blvd.x - blvd.median / 2, 0, a, blvd.x + blvd.median / 2, 0.2, b, COL.median, COL.curb);
    for (let z = a + 2; z < b - 2; z += 3.2) {
      inst.add('props/shrub', blvd.x - 3.2 + rnd() * 0.6, 0.2, z, rnd() * 6.28, 0.8 + rnd() * 0.35);
      inst.add('props/shrub', blvd.x + 3.2 - rnd() * 0.6, 0.2, z + 1.6, rnd() * 6.28, 0.8 + rnd() * 0.35);
    }
  }

  // --- markings
  const Y = 0.025;
  const dashLine = (lane, off, dash = 3, gap = 5, solidTail = 22) => {
    const p = {};
    for (let s = 2; s < lane.length - 1; s += dash + gap) {
      const solid = s > lane.length - solidTail;
      const e = Math.min(solid ? lane.length - 1 : s + dash, lane.length - 1);
      const m = (s + e) / 2;
      lane.sample(m, p);
      const rx = -p.hz, rz = p.hx;
      marks.flatOriented(p.x + rx * off, p.z + rz * off, p.hx, p.hz, (e - s) / 2, 0.075, Y, COL.white);
      if (solid) break;
    }
  };
  const solidLine = (lane, off, col, w = 0.075, from = 0, to = 0) => {
    const p = {};
    lane.sample(lane.length / 2, p);
    const rx = -p.hz, rz = p.hx;
    marks.flatOriented(p.x + rx * off, p.z + rz * off, p.hx, p.hz, lane.length / 2 - from, w, Y, col);
  };
  for (const seg of net.segments) {
    for (const lanes of Object.values(seg.lanes)) {
      for (let i = 0; i < lanes.length - 1; i++) dashLine(lanes[i], LANE_W / 2);
      const outer = lanes[lanes.length - 1];
      solidLine(outer, LANE_W / 2 - 0.35, COL.white);
      const inner = lanes[0];
      if (seg.road.median === 0) solidLine(inner, -LANE_W / 2 + 0.12, COL.yellow, 0.07);
      else solidLine(inner, -LANE_W / 2 + 0.3, COL.white);
      // stop line
      if (inner.endInter) {
        const p = {};
        for (const ln of lanes) {
          ln.sample(ln.length - 0.2, p);
          marks.flatOriented(p.x, p.z, p.hx, p.hz, 0.2, LANE_W / 2, Y, COL.white);
        }
        // lane arrows 10 m before the stop line
        for (const ln of lanes) {
          ln.sample(ln.length - 10, p);
          marks.flatOriented(p.x, p.z, p.hx, p.hz, 1.6, 0.09, Y, COL.white);
          const moves = ln.next.map((c) => c.movement);
          for (const mv of moves) {
            const sx = mv === 'left' ? 1 : mv === 'right' ? -1 : 0;
            const hx = p.x + p.hx * 1.6, hz = p.z + p.hz * 1.6;
            if (sx === 0) {
              marks.flatOriented(hx, hz, p.hx, p.hz, 0.35, 0.32, Y + 0.001, COL.white);
              marks.flatOriented(hx + p.hx * 0.45, hz + p.hz * 0.45, p.hx, p.hz, 0.12, 0.16, Y + 0.001, COL.white);
            } else {
              const lx = p.hz * sx, lz = -p.hx * sx;   // lateral towards the turn
              marks.flatOriented(hx + lx * 0.45, hz + lz * 0.45, lx, lz, 0.5, 0.09, Y + 0.001, COL.white);
              marks.flatOriented(hx + lx * 1.0, hz + lz * 1.0, lx, lz, 0.18, 0.28, Y + 0.001, COL.white);
            }
          }
        }
      }
    }
  }
  // zebra crossings (stripes run parallel to traffic)
  for (const c of net.crosswalks) {
    const along = c.axis === 'x' ? c.hx : c.hz;
    for (let t = -along + 0.4; t <= along - 0.3; t += 1.0) {
      if (c.axis === 'x') marks.flat(c.cx + t - 0.25, c.cz - c.hz, c.cx + t + 0.25, c.cz + c.hz, Y, COL.white);
      else marks.flat(c.cx - c.hx, c.cz + t - 0.25, c.cx + c.hx, c.cz + t + 0.25, Y, COL.white);
    }
    // tactile strips on the kerbs at both ends
    if (c.axis === 'x') {
      ground.flat(c.cx - c.hx - 1.2, c.cz - c.hz, c.cx - c.hx - 0.4, c.cz + c.hz, 0.175, COL.tactile);
      ground.flat(c.cx + c.hx + 0.4, c.cz - c.hz, c.cx + c.hx + 1.2, c.cz + c.hz, 0.175, COL.tactile);
    } else {
      ground.flat(c.cx - c.hx, c.cz - c.hz - 1.2, c.cx + c.hx, c.cz - c.hz - 0.4, 0.175, COL.tactile);
      ground.flat(c.cx - c.hx, c.cz + c.hz + 0.4, c.cx + c.hx, c.cz + c.hz + 1.2, 0.175, COL.tactile);
    }
  }

  // --- road works (lane closure -> merge)
  if (net.closure) {
    const { lane, s0, s1, taper } = net.closure;
    const p = {};
    for (let s = s0 - taper; s <= s1; s += 2.6) {
      const k = Math.min(1, (s - (s0 - taper)) / taper);
      lane.sample(s, p);
      const off = (-LANE_W / 2 + 0.25) * k + 0.6 * (1 - k);
      inst.add('props/cone', p.x - p.hz * off, 0.01, p.z + p.hx * off, rnd() * 6.28);
    }
    for (let s = s0 + 3; s < s1 - 3; s += 4) {
      lane.sample(s, p);
      roads.flatOriented(p.x, p.z, p.hx, p.hz, 2, 1.6, 0.015, jitter(COL.dirt, s, 1, 0.12));
    }
    // barriers across the closed lane, facing oncoming traffic
    for (const s of [s0, s1]) {
      lane.sample(s, p);
      inst.add('props/barrier', p.x, 0.01, p.z, Math.atan2(-p.hx, -p.hz));
    }
    // advance warning sign on the kerb (right of travel = (-hz, hx))
    lane.sample(Math.max(4, s0 - taper - 30), p);
    const kerb = LANE_W / 2 + 1.6;
    inst.add('props/sign_roadwork', p.x - p.hz * kerb, 0.15, p.z + p.hx * kerb, Math.atan2(-p.hx, -p.hz));
  }

  // --- sidewalk furniture: lamps + trees along every sidewalk edge
  const ends = net.intersections;
  const nearInter = (x, z, r) => ends.some((I) => Math.abs(x - I.x) < I.hwX + r && Math.abs(z - I.z) < I.hwZ + r);
  for (const e of net.walk.edges) {
    if (e.kind !== 'sidewalk') continue;
    const dx = (e.b.x - e.a.x) / e.len, dz = (e.b.z - e.a.z) / e.len;
    const sw = e.seg.road.sidewalk;
    const rot = Math.atan2(e.toRoad.x, e.toRoad.z);
    for (let t = 8; t < e.len - 8; t += 2) {
      const x = e.a.x + dx * t, z = e.a.z + dz * t;
      if (nearInter(x, z, 6)) continue;
      const k = Math.round(t / 2);
      if (k % 15 === 0) {
        inst.add('props/street_lamp', x + e.toRoad.x * (sw / 2 - 0.6), 0.15, z + e.toRoad.z * (sw / 2 - 0.6), rot);
      } else if (k % 6 === 3 && !nearInter(x, z, 12)) {
        const v = ['props/tree_plane_a', 'props/tree_plane_b', 'props/tree_plane_c'][Math.floor(rnd() * 3)];
        inst.add(v, x + e.toRoad.x * (sw / 2 - 1.0), 0.15, z + e.toRoad.z * (sw / 2 - 1.0), rnd() * 6.28, 0.85 + rnd() * 0.3);
      } else if (k % 37 === 20) {
        inst.add('props/bin', x + e.toRoad.x * (sw / 2 - 0.7), 0.15, z + e.toRoad.z * (sw / 2 - 0.7), rot);
      }
    }
  }
  // bollards at crosswalk kerbs, bus shelters
  for (const c of net.crosswalks) {
    const pts = c.axis === 'x'
      ? [[c.cx - c.hx - 0.6, c.cz - c.hz - 0.4], [c.cx - c.hx - 0.6, c.cz + c.hz + 0.4], [c.cx + c.hx + 0.6, c.cz - c.hz - 0.4], [c.cx + c.hx + 0.6, c.cz + c.hz + 0.4]]
      : [[c.cx - c.hx - 0.4, c.cz - c.hz - 0.6], [c.cx + c.hx + 0.4, c.cz - c.hz - 0.6], [c.cx - c.hx - 0.4, c.cz + c.hz + 0.6], [c.cx + c.hx + 0.4, c.cz + c.hz + 0.6]];
    for (const [x, z] of pts) inst.add('props/bollard', x, 0.15, z, 0);
  }
  // bus shelters on the back half of the sidewalk, facing the road
  for (const [x, z, r] of [[blvd.x - 15.5 - 4.1, -70, Math.PI / 2], [blvd.x + 15.5 + 4.1, 75, -Math.PI / 2], [60, 7 + 3.7, Math.PI]]) {
    inst.add('props/bus_shelter', x, 0.15, z, r);
  }

  // --- signals (individual meshes so each can show its own state)
  const signals = [];
  const sigGroup = new THREE.Group();
  root.add(sigGroup);
  const F = { SB: [0, 1], NB: [0, -1], EB: [1, 0], WB: [-1, 0] };
  for (const I of net.intersections) {
    for (const [dn, lanes] of Object.entries(I.approaches)) {
      const [fx, fz] = F[dn];
      const p = {};
      lanes[0].sample(lanes[0].length, p);
      const rx = -fz, rz = fx;
      const roadC = dn === 'SB' || dn === 'NB' ? { x: I.av.x, z: p.z } : { x: p.x, z: I.st.z };
      const hw = dn === 'SB' || dn === 'NB' ? I.hwX : I.hwZ;
      const px = roadC.x + rx * (hw + 1.0), pz = roadC.z + rz * (hw + 1.0);
      const key = lanes.length >= 3 ? 'props/signal_mast_long' : 'props/signal_mast_short';
      const obj = assets[key].instantiate();
      obj.position.set(px, 0.15, pz);
      obj.rotation.y = Math.atan2(-fx, -fz);
      obj.scale.x = -1;                 // arm reaches over the lanes (driver's left)
      sigGroup.add(obj);
      signals.push({ obj, inter: I, group: dn === 'SB' || dn === 'NB' ? 'NS' : 'EW', mats: obj.userData.materials });
    }
    for (const c of Object.values(I.crosswalks)) {
      const e = c.edge;
      for (const [a, b] of [[e.a, e.b], [e.b, e.a]]) {
        const dx = b.x - a.x, dz = b.z - a.z, L2 = Math.hypot(dx, dz);
        const ox = c.axis === 'x' ? 0 : (c.hx + 0.5) * 1, oz = c.axis === 'x' ? (c.hz + 0.5) : 0;
        const obj = assets['props/ped_signal'].instantiate();
        obj.position.set(a.x - (dx / L2) * 0.3 + ox, 0.15, a.z - (dz / L2) * 0.3 + oz);
        obj.rotation.y = Math.atan2(dx, dz);
        sigGroup.add(obj);
        signals.push({ obj, cw: c, mats: obj.userData.materials, ped: true });
      }
    }
  }

  // --- elevated expressways: viaduct (level 1), flyover (level 2), the curved ramps between them
  // and the loop ramps down to north_st. A ramp widens the road it leaves / joins (see rampDeck),
  // so that road's parapet opens and its edge line turns into dashes there. Both decks, and
  // north_st under the flyover, carry on out of town to the horizon.
  const V = L.viaduct, FO = L.flyover, HZ = L.horizon;
  const north = L.streets.find((s) => s.id === 'north_st');
  const zones = rampZones(net.ramps);
  outskirtsRoad(tile, marks, north, B, HZ, zones.ground, Y);
  const via = new Batch();
  const top = V.height, hwV = V.halfWidth;
  straightDeck(via, 'z', V.x, -HZ, HZ, hwV, top, zones.viaduct, V.median);
  straightDeck(via, 'x', FO.z, -HZ, HZ, FO.halfWidth, FO.height, zones.flyover, FO.median);
  const rampBatch = new Batch();
  for (const r of net.ramps) rampDeck(rampBatch, r);
  const viaMesh = via.mesh(lit.clone());
  viaMesh.castShadow = true;
  viaMesh.material.transparent = true;
  viaMesh.material.opacity = 1;
  root.add(viaMesh);
  const rampMesh = rampBatch.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, transparent: true, opacity: 1 }));
  rampMesh.castShadow = true;
  root.add(rampMesh);
  // ramp centre lines every 2 m, to keep piers, lamps and barriers out of the ramps' way
  const rampPts = net.ramps.flatMap((r) => Array.from({ length: Math.floor(r.length / 2) + 1 }, (_, i) => r.sample(i * 2, {})));
  const rampNear = (x, z, dx, dz, yLo, yHi) => rampPts.some((p) => Math.abs(p.x - x) < dx && Math.abs(p.z - z) < dz && p.y > yLo && p.y - 1.5 < yHi);
  // translucent teal sound barriers on part of the viaduct (as in the photo)
  const sb = new Batch();
  for (const sgn of [-1, 1]) {
    for (let z = -230; z < 230; z += 6) {
      if (Math.abs(z - FO.z) < 14) continue;
      const xo = V.x + sgn * (hwV - 0.25);
      if (rampNear(xo, z + 3, FO.rampHalfWidth + 4, 7, top - 3, top + 3.5)) continue;
      sb.box(xo - 0.06, top + 1.18, z, xo + 0.06, top + 3.4, z + 5.8, C('#4fb3a2'));
      sb.box(xo - 0.1, top + 1.18, z + 5.8, xo + 0.1, top + 3.5, z + 6, C('#2d6f66'));
    }
  }
  const sbMesh = sb.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.45, roughness: 0.2, metalness: 0.1, depthWrite: false }));
  root.add(sbMesh);
  const inCity = (t) => Math.abs(t) < B + 40;
  const base = (x, z) => (inCity(x) && inCity(z) ? 0.15 : 0);     // block ground in town, open country outside
  // viaduct piers in the boulevard median, clear of intersections
  for (let z = -HZ + 8; z < HZ; z += 32) {
    if (net.intersections.some((I) => I.av === blvd && Math.abs(z - I.z) < I.dNS + 3)) continue;
    inst.add('props/pier', V.x, 0, z, 0);
  }
  // flyover portal frames straddling north_st, clear of intersections and of ramps passing through
  for (let x = -HZ + 10; x < HZ; x += 30) {
    if (net.intersections.some((I) => Math.abs(I.z - FO.z) < 1 && Math.abs(x - I.x) < I.hwX + 16)) continue;
    if (rampPts.some((p) => Math.abs(p.x - x) < 0.75 + FO.rampHalfWidth + 0.5 && Math.abs(p.z - FO.z) < 13.25 + FO.rampHalfWidth
      && p.y - 1.5 < 20.7 && p.y < FO.height - 0.05)) continue;
    inst.add('props/pier_portal', x, base(x, FO.z), FO.z, Math.PI / 2);
  }
  // ramp columns, scaled to the deck height, never on a carriageway or sidewalk
  const overStreet = (x, z) => L.avenues.some((a) => inCity(z) && Math.abs(x - a.x) < roadHalfWidth(a) + a.sidewalk + 1.5)
    || L.streets.some((st) => inCity(x) && Math.abs(z - st.z) < roadHalfWidth(st) + st.sidewalk + 1.5)
    || Math.abs(z - north.z) < roadHalfWidth(north) + 4;          // north_st out of town (no sidewalks)
  for (const r of net.ramps) {
    const p = {};
    for (let s = r.noses[0] + 8; s < r.noses[1] - 6; s += 21) {
      r.sample(s, p);
      if (p.y < 4 || overStreet(p.x, p.z)) continue;
      const b0 = base(p.x, p.z);
      inst.add('props/pier_ramp', p.x, b0, p.z, p.heading, [1, (p.y - 1.5 - b0) / 21, 1]);
    }
  }
  // lamps on both expressway levels (none where the flyover crosses the viaduct or a loop)
  for (let z = -HZ + 20; z < HZ; z += 40) {
    if (Math.abs(z - FO.z) < 16) continue;
    inst.add('props/viaduct_lamp', V.x, top + 0.85, z, Math.PI / 2);
  }
  for (let x = -HZ + 20; x < HZ; x += 40) {
    if (rampNear(x, FO.z, 14, 14, -1, FO.height - 1)) continue;
    inst.add('props/viaduct_lamp', x, FO.height + 0.85, FO.z, 0);
  }
  // direction-sign gantries
  inst.add('props/gantry', blvd.x - 10.25, 0, -95, Math.PI);
  inst.add('props/gantry', blvd.x + 10.25, 0, 95, 0);
  inst.add('props/gantry', V.x - 4.3, top, -230, Math.PI, 0.7);
  inst.add('props/gantry', V.x + 4.3, top, 210, 0, 0.7);
  inst.add('props/gantry', -250, FO.height, FO.z + 4.3, -Math.PI / 2, 0.7);

  // --- buildings and parks
  const corridors = net.ramps.map((r) => ({ pts: r.pts, hw: FO.rampHalfWidth }));
  placeBuildings(blocks, inst, assets, rnd, ground, corridors);

  // --- finish
  root.add(ground.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  root.add(roads.mesh(lit));
  root.add(marks.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  const curbMesh = curbs.mesh(lit);
  curbMesh.castShadow = false;
  root.add(curbMesh);
  inst.build(root, { shadowFor: (k) => !k.endsWith('shrub') && !k.endsWith('bollard') && !k.endsWith('flowerbed') });

  return { root, signals, viaduct: [viaMesh, sbMesh, rampMesh], blocks, assets, instancer: inst };
}

// ----------------------------------------------------------------- buildings

function placeBuildings(blocks, inst, assets, rnd, ground, corridors = []) {
  const fp = (k) => assets[k].meta.footprint || [10, 10];
  // keep buildings out from under the curved ramps (the decks fly at 12-22 m)
  const clear = (key, x, z) => {
    if (!key.startsWith('buildings/')) return true;
    const [w, d] = fp(key);
    const r = Math.max(w, d) / 2;
    for (const c of corridors) {
      for (let i = 1; i < c.pts.length; i++) {
        const a = c.pts[i - 1], b = c.pts[i];
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
        if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) < r + c.hw + 4) return false;
      }
    }
    return true;
  };
  const rawAdd = inst.add.bind(inst);
  inst = { add: (key, x, y, z, ...rest) => { if (clear(key, x, z)) rawAdd(key, x, y, z, ...rest); } };
  const resi = ['buildings/resi_redroof_a', 'buildings/resi_redroof_b', 'buildings/resi_redroof_c', 'buildings/resi_redroof_d'];
  const towers = ['buildings/tower_resi_a', 'buildings/tower_resi_b', 'buildings/tower_resi_c'];
  const offices = ['buildings/office_glass_a', 'buildings/office_glass_b', 'buildings/office_glass_c'];
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  for (const b of blocks) {
    // buildable area, clipped to the visible city
    const x0 = Math.max(b.in.x0 + 4, -330), x1 = Math.min(b.in.x1 - 4, 330);
    const z0 = Math.max(b.in.z0 + 4, -330), z1 = Math.min(b.in.z1 - 4, 330);
    if (x1 - x0 < 12 || z1 - z0 < 12) continue;

    if (b.type === 'compound') {
      // rows of red-roofed slabs facing south, like the left side of the photo
      for (let z = z0 + 7; z < z1 - 6; z += 27) {
        let x = x0;
        while (x < x1) {
          const k = pick(resi);
          const [w] = fp(k);
          if (x + w > x1) break;
          inst.add(k, x + w / 2, 0.15, z, 0);
          x += w + 5 + rnd() * 4;
        }
        // trees between rows
        for (let x = x0 + 4; x < x1 - 4; x += 9) {
          if (z + 14 < z1) inst.add(rnd() < 0.5 ? 'props/tree_plane_b' : 'props/tree_plane_c', x + rnd() * 3, 0.15, z + 14 + rnd() * 2, rnd() * 6.28, 0.9 + rnd() * 0.3);
        }
      }
    } else if (b.type === 'plaza') {
      // glass offices on a paved plaza, shop rows along the street edges
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      inst.add('buildings/office_glass_c', x0 + 20, 0.15, z0 + 20, 0);
      inst.add('buildings/office_glass_a', x1 - 22, 0.15, z0 + 22, Math.PI / 2);
      inst.add('buildings/tower_resi_a', cx + 10, 0.15, z1 - 26, 0);
      inst.add('buildings/shops_b', x0 + 18, 0.15, z1 - 8, 0);
      for (let k = 0; k < 10; k++) inst.add('props/tree_cypress', cx - 30 + k * 6, 0.15, cz + 6, 0, 0.9 + rnd() * 0.2);
      for (let k = 0; k < 6; k++) inst.add('props/bench', cx - 26 + k * 10, 0.15, cz + 9, Math.PI);
    } else if (b.type === 'park') {
      buildPark(b, x0, x1, z0, z1, inst, rnd, ground);
    } else {
      // towers / offices on a loose grid (skyline)
      const outer = b.i === 0 || b.i === 3 || b.j === 0 || b.j === 3;
      for (let x = x0 + 14; x < x1 - 14; x += 36 + rnd() * 10) {
        for (let z = z0 + 14; z < z1 - 14; z += 36 + rnd() * 10) {
          const r = rnd();
          const k = r < 0.45 ? pick(towers) : r < 0.75 ? pick(offices) : outer ? pick(resi) : 'buildings/shops_a';
          const [w, d] = fp(k);
          if (x + w / 2 > x1 || z + d / 2 > z1) continue;
          inst.add(k, x, 0.15, z, Math.floor(rnd() * 4) * Math.PI / 2);
        }
      }
    }
  }

  // distant skyline ring beyond the road grid (fog blends it into the haze)
  for (let k = 0; k < 140; k++) {
    const a = rnd() * Math.PI * 2;
    const r = 360 + rnd() * 380;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 40) continue;              // keep the expressway corridors clear
    if (Math.abs(z - LAYOUT.flyover.z) < 40) continue;
    if (Math.abs(z - LAYOUT.flyover.z) < 85 && Math.abs(x) < 640) continue;   // ... and the loop ramps
    const t = rnd();
    const key = t < 0.4 ? pick(towers) : t < 0.7 ? pick(offices) : pick(resi);
    inst.add(key, x, 0, z, Math.floor(rnd() * 4) * Math.PI / 2, 1 + rnd() * 0.25);
  }
}

function buildPark(b, x0, x1, z0, z1, inst, rnd, ground) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rx = (x1 - x0) / 2 - 8, rz = (z1 - z0) / 2 - 8;
  // looping footpath (ellipse) + two diagonals, drawn as short flat segments
  const pathSeg = (ax, az, bx, bz, w = 1.6) => {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    ground.flatOriented((ax + bx) / 2, (az + bz) / 2, dx / L, dz / L, L / 2 + 0.3, w, 0.2, COL.path);
  };
  const N = 72;
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const p = [cx + Math.cos(t) * rx * 0.82, cz + Math.sin(t) * rz * 0.78];
    if (prev) pathSeg(prev[0], prev[1], p[0], p[1]);
    prev = p;
  }
  for (const [ax, az, bx, bz] of [[x0, z0, cx - 6, cz - 4], [x1, z1, cx + 6, cz + 4], [x1, z0, cx + 4, cz - 6]]) {
    const steps = 14;
    let q = [ax, az];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const bend = Math.sin(t * Math.PI) * 6;
      const p = [ax + (bx - ax) * t + bend, az + (bz - az) * t - bend * 0.5];
      pathSeg(q[0], q[1], p[0], p[1], 1.3);
      q = p;
    }
  }
  // oval flower bed in the middle, shrubs and trees around
  inst.add('props/flowerbed', cx, 0.16, cz, 0, 2.4);
  for (let k = 0; k < 18; k++) {
    const t = (k / 18) * Math.PI * 2;
    inst.add('props/shrub', cx + Math.cos(t) * 11, 0.16, cz + Math.sin(t) * 7, rnd() * 6.28, 1 + rnd() * 0.3);
  }
  for (let k = 0; k < 90; k++) {
    const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
    const e = ((x - cx) / (rx * 0.82)) ** 2 + ((z - cz) / (rz * 0.78)) ** 2;
    if (Math.abs(e - 1) < 0.12 || e < 0.25) continue;     // keep paths and the centre clear
    const key = rnd() < 0.35 ? 'props/tree_cypress' : ['props/tree_plane_a', 'props/tree_plane_b', 'props/tree_plane_c'][Math.floor(rnd() * 3)];
    inst.add(key, x, 0.16, z, rnd() * 6.28, 0.8 + rnd() * 0.5);
  }
  for (let k = 0; k < 8; k++) {
    const t = (k / 8) * Math.PI * 2 + 0.2;
    const x = cx + Math.cos(t) * (rx * 0.82 + 2.6), z = cz + Math.sin(t) * (rz * 0.78 + 2.6);
    inst.add('props/bench', x, 0.16, z, Math.atan2(cx - x, cz - z));
  }
  b.parkLoop = { cx, cz, rx: rx * 0.82, rz: rz * 0.78 };
}

// --------------------------------------------------------------- signal look

/** Update traffic light / walk light materials from controller state. */
export function updateSignalVisuals(signals, time) {
  for (const s of signals) {
    const m = s.mats;
    if (s.ped) {
      const w = s.cw.walk();
      const flashOn = Math.floor(time * 2) % 2 === 0;
      m[MAT.PED_WALK] = w === 2 || (w === 1 && flashOn) ? Materials.lampOn : Materials.lampOff;
      m[MAT.PED_STOP] = w === 0 ? Materials.lampOn : Materials.lampOff;
    } else {
      const sig = s.inter.signal;
      const st = Math.max(sig.state(s.group), sig.state(s.group + 'L'));
      m[MAT.SIG_RED] = st === 0 ? Materials.lampOn : Materials.lampOff;
      m[MAT.SIG_YELLOW] = st === 1 ? Materials.lampOn : Materials.lampOff;
      m[MAT.SIG_GREEN] = st === 2 ? Materials.lampOn : Materials.lampOff;
    }
  }
}

// ------------------------------------------------------------- deck helpers

/** Quad with its winding chosen so the face points along `out` (works for degenerate quads too). */
function face(B, a, b, c, d, out, col) {
  // normal from the diagonals, so a quad that has collapsed into a triangle still lights correctly
  const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
  const vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz);
  if (L < 1e-9) return;
  nx /= L; ny /= L; nz /= L;
  if (nx * out[0] + ny * out[1] + nz * out[2] < 0) B.quad(a, d, c, b, [-nx, -ny, -nz], col);
  else B.quad(a, b, c, d, [nx, ny, nz], col);
}

/** Flat painted strip from (ax, az) to (bx, bz), `w` wide, at height y. */
function stripe(B, ax, az, bx, bz, w, y, col) {
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
  const px = (-dz / L) * (w / 2), pz = (dx / L) * (w / 2);
  face(B, [ax - px, y, az - pz], [ax + px, y, az + pz], [bx + px, y, bz + pz], [bx - px, y, bz - pz], [0, 1, 0], col);
}

const smooth01 = (u) => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };

/** [from, to] minus the `gaps` intervals. */
function solidSpans(from, to, gaps = []) {
  const out = [];
  let t = from;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (b <= t || a >= to) continue;
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < to) out.push([t, to]);
  return out;
}

/**
 * Where each ramp is joined on to the road it leaves / joins, per road ('viaduct', 'flyover' or
 * 'ground' = north_st) and side (+1 = the +x side of the viaduct, the +z side of the others):
 * `gaps` is where that road's parapet is open (from the taper to the nose) and `dashes` where its
 * edge line is dashed (from the taper to where the ramp's own edge line peels away).
 */
function rampZones(ramps) {
  const zones = { viaduct: {}, flyover: {}, ground: {} };
  for (const r of ramps) {
    r.attach.forEach((a, end) => {
      const alongZ = a.u.x === 0;
      const side = String(alongZ ? Math.sign(-a.u.z) : Math.sign(a.u.x));
      const lon = (s, inset) => {          // position along the road of the ramp's inner edge (minus inset) at s
        const p = r.sample(s, {}), e = r.hw - inset;
        return alongZ ? p.z - p.hx * e : p.x + p.hz * e;
      };
      const t0 = alongZ ? a.q.z : a.q.x, nose = lon(r.noses[end], 0), gore = lon(r.gores[end], 0.85);
      const z = (zones[a.deck][side] ||= { gaps: [], dashes: [] });
      z.gaps.push([Math.min(t0, nose), Math.max(t0, nose)]);
      z.dashes.push([Math.min(t0, gore), Math.max(t0, gore)]);
    });
  }
  return zones;
}

/**
 * Straight elevated deck along `axis` ('z' or 'x') centred on `c`: slab with orange edge bands,
 * teal-railed parapets (open over `zones[side].gaps`), a median barrier, edge lines (dashed over
 * `zones[side].dashes`) and the dashed line between the two lanes of each carriageway.
 * Side +1 is the +x side for axis 'z' and the +z side for axis 'x'.
 */
function straightDeck(B, axis, c, from, to, hw, top, zones = {}, median = 1) {
  const box = (a0, a1, l0, l1, y0, y1, colTop, colSide, bottom = false) => (axis === 'z'
    ? B.box(Math.min(l0, l1), y0, a0, Math.max(l0, l1), y1, a1, colTop, colSide, bottom)
    : B.box(a0, y0, Math.min(l0, l1), a1, y1, Math.max(l0, l1), colTop, colSide, bottom));
  const zone = (sgn) => zones[String(sgn)] || { gaps: [], dashes: [] };
  for (let t = from; t < to; t += 8) {
    const t1 = Math.min(t + 8, to);
    const cc = jitter(COL.concrete, t, 3, 0.04);
    box(t, t1, c - hw, c + hw, top - 1.5, top, jitter(COL.deckTop, t, 7, 0.05), cc, true);
    for (const sgn of [-1, 1]) {
      const eo = c + sgn * hw;
      box(t, t1, eo, eo + sgn * 0.02, top - 1.0, top - 0.7, COL.orange);
    }
    box(t, t1, c - 0.35, c + 0.35, top, top + 0.85, COL.concreteDark, COL.concrete);
  }
  for (const sgn of [-1, 1]) {
    // parapets, cut exactly where a ramp is joined on
    const eo = c + sgn * hw, ei = eo - sgn * 0.5;
    for (const [a, b] of solidSpans(from, to, zone(sgn).gaps)) {
      for (let t = a; t < b - 1e-6; t += 8) {
        const t1 = Math.min(t + 8, b);
        box(t, t1, ei, eo, top, top + 1.0, jitter(COL.concrete, t, sgn, 0.03));
        box(t, t1, ei - sgn * 0.02, eo + sgn * 0.02, top + 1.0, top + 1.18, COL.teal);
      }
    }
    // edge line: solid, with wide short dashes along exit / entry tapers
    const e = c + sgn * (hw - 0.85);
    for (const [a, b] of solidSpans(from, to, zone(sgn).dashes)) box(a, b, e - 0.08, e + 0.08, top, top + 0.02, COL.white);
    for (const [a, b] of zone(sgn).dashes) {
      for (let t = a + 0.5; t < b - 0.5; t += 5) box(t, Math.min(t + 2.5, b), e - 0.12, e + 0.12, top, top + 0.02, COL.white);
    }
    // dashed line between the two lanes
    const ll = c + sgn * (median / 2 + LANE_W);
    for (let t = from + 2; t < to - 4; t += 12) box(t, t + 6, ll - 0.08, ll + 0.08, top, top + 0.02, COL.white);
  }
}

/**
 * Swept deck of a single-lane ramp. Between its noses it is a full-width deck with parapets on
 * both sides. Before / after them it only fills the strip outside the edge of the road it leaves /
 * joins, widening from nothing, so that road simply grows an exit / entry lane: no overlapping
 * surfaces and no parapet across the lanes. A painted gore fills the vee between the two edge
 * lines up to each nose. Near the ground the surface is asphalt and the parapets start once the
 * ramp has lifted off.
 */
function rampDeck(B, lane) {
  const hw = lane.hw, thick = 1.5, L = lane.length;
  const [a0, a1] = lane.attach, [n0, n1] = lane.noses, [g0, g1] = lane.gores;
  const marks = new Set([0, L, n0, n1, g0, g1]);
  for (let s = 2; s < L; s += 2) marks.add(s);
  const S = [...marks].sort((p, q) => p - q).map((s) => {
    const p = lane.sample(s, {});
    const rx = -p.hz, rz = p.hx;
    // where the edge of road `a` is, measured from the ramp centre along its right vector
    const edgeAt = (a) => {
      const den = rx * -a.u.z + rz * a.u.x;
      return den > 0.2 ? (a.edge - lateral(a, p.x, p.z)) / den : -hw;
    };
    let eL = -hw;
    if (s < n0) eL = Math.max(eL, edgeAt(a0));
    if (s > n1) eL = Math.max(eL, edgeAt(a1));
    const grow = (d, a) => hw - (hw - a.edge) * (1 - smooth01(d / 30));   // outer edge flares out of the road edge
    const eR = Math.min(hw, grow(s, a0), grow(L - s, a1));
    return { s, x: p.x, z: p.z, rx, rz, y: Math.max(p.y, 0.012), eL: Math.min(eL, eR), eR, free: s >= n0 - 1e-6 && s <= n1 + 1e-6 };
  });
  const at = (q, off, dy = 0) => [q.x + q.rx * off, q.y + dy, q.z + q.rz * off];
  for (let i = 0; i < S.length - 1; i++) {
    const p = S[i], q = S[i + 1];
    if (q.s - p.s < 1e-3) continue;
    const low = p.y < 0.3 && q.y < 0.3;
    const cTop = low ? jitter(COL.asphalt, i, 5, 0.06) : jitter(COL.deckTop, i, 11, 0.05), cc = jitter(COL.concrete, i, 13, 0.04);
    const rOut = [p.rx, 0, p.rz], lOut = [-p.rx, 0, -p.rz];
    const free = p.free && q.free;
    if (p.eR - p.eL > 1e-3 || q.eR - q.eL > 1e-3) {
      face(B, at(p, p.eL), at(p, p.eR), at(q, q.eR), at(q, q.eL), [0, 1, 0], cTop);
      face(B, at(p, p.eL, -thick), at(q, q.eL, -thick), at(q, q.eR, -thick), at(p, p.eR, -thick), [0, -1, 0], cc);
      face(B, at(p, p.eR, -thick), at(q, q.eR, -thick), at(q, q.eR), at(p, p.eR), rOut, cc);
      if (free) face(B, at(p, p.eL, -thick), at(p, p.eL), at(q, q.eL), at(q, q.eL, -thick), lOut, cc);
    }
    // orange bands on the exposed outer faces
    if (p.y > 2 && q.y > 2) {
      face(B, at(p, p.eR + 0.02, -1.0), at(q, q.eR + 0.02, -1.0), at(q, q.eR + 0.02, -0.7), at(p, p.eR + 0.02, -0.7), rOut, COL.orange);
      if (free) face(B, at(p, p.eL - 0.02, -1.0), at(p, p.eL - 0.02, -0.7), at(q, q.eL - 0.02, -0.7), at(q, q.eL - 0.02, -1.0), lOut, COL.orange);
    }
    // edge lines: outside all the way, inside from where it peels away from the road's edge line
    const line = (e0, e1) => face(B, at(p, e0 - 0.08, 0.02), at(p, e0 + 0.08, 0.02), at(q, e1 + 0.08, 0.02), at(q, e1 - 0.08, 0.02), [0, 1, 0], COL.white);
    if (p.eR - p.eL > 0.9 || q.eR - q.eL > 0.9) line(p.eR - 0.85, q.eR - 0.85);
    if (p.s >= g0 - 1e-6 && q.s <= g1 + 1e-6) line(-(hw - 0.85), -(hw - 0.85));
    // parapets (concrete wall + teal rail): outside once off the ground, inside past the noses
    if (p.y < 0.4 || q.y < 0.4) continue;
    for (const sg of free ? [-1, 1] : [1]) {
      const o0 = sg > 0 ? p.eR : p.eL, o1 = sg > 0 ? q.eR : q.eL;
      const i0 = o0 - sg * 0.45, i1 = o1 - sg * 0.45;
      const out = sg > 0 ? rOut : lOut, inn = sg > 0 ? lOut : rOut;
      const wall = jitter(COL.concrete, i, sg, 0.03);
      face(B, at(p, o0), at(q, o1), at(q, o1, 1.0), at(p, o0, 1.0), out, wall);
      face(B, at(p, i0), at(p, i0, 1.0), at(q, i1, 1.0), at(q, i1), inn, wall);
      face(B, at(p, i0, 1.0), at(p, o0, 1.0), at(q, o1, 1.0), at(q, i1, 1.0), [0, 1, 0], wall);
      face(B, at(p, i0 - sg * 0.02, 1.18), at(p, o0 + sg * 0.02, 1.18), at(q, o1 + sg * 0.02, 1.18), at(q, i1 - sg * 0.02, 1.18), [0, 1, 0], COL.teal);
      face(B, at(p, o0 + sg * 0.02, 1.0), at(q, o1 + sg * 0.02, 1.0), at(q, o1 + sg * 0.02, 1.18), at(p, o0 + sg * 0.02, 1.18), out, COL.teal);
      face(B, at(p, i0 - sg * 0.02, 1.0), at(p, i0 - sg * 0.02, 1.18), at(q, i1 - sg * 0.02, 1.18), at(q, i1 - sg * 0.02, 1.0), inn, COL.teal);
    }
  }
  // painted gores: diagonal hatching between the road's edge line and the ramp's, up to the nose
  const gore = (a, sA, sB) => {
    for (let s = sA + 1.5; s < sB; s += 2.5) {
      const p = lane.sample(s, {}), e = hw - 0.85;
      const ax = p.x + p.hz * e, az = p.z - p.hx * e;                   // on the ramp's inner edge line
      const w = lateral(a, ax, az) - (a.edge - 0.85);                   // width of the vee here
      if (w < 0.35) continue;
      const lon = (ax - a.q.x) * a.u.x + (az - a.q.z) * a.u.z - Math.min(3, w);
      const off = a.edge - 0.85;
      stripe(B, ax, az, a.q.x + a.u.x * lon - a.u.z * off, a.q.z + a.u.z * lon + a.u.x * off, 0.3, Math.max(p.y, 0.012) + 0.03, COL.white);
    }
  };
  gore(a0, g0, n0);
  gore(a1, n1, g1);
}

/** north_st beyond the city: asphalt with a shoulder, double yellow centre line, lane and edge lines. */
function outskirtsRoad(tile, marks, st, B, HZ, zones, Y) {
  const z = st.z, hwRoad = roadHalfWidth(st), hw = hwRoad + LAYOUT.outskirts.shoulder;
  for (const sgn of [-1, 1]) {
    const [x0, x1] = sgn < 0 ? [-HZ, -B - 40] : [B + 40, HZ];             // the city's tiles stop at B + 40
    tile(x0, z - hw, x1, z + hw);
    const [m0, m1] = sgn < 0 ? [-HZ, -B] : [B, HZ];                       // ... its markings at B
    for (const e of [-0.12, 0.12]) marks.flat(m0, z + e - 0.07, m1, z + e + 0.07, Y, COL.yellow);
    for (const e of [-LANE_W, LANE_W]) {
      for (let x = m0 + 2; x < m1 - 3; x += 8) marks.flat(x, z + e - 0.075, x + 3, z + e + 0.075, Y, COL.white);
    }
    for (const side of [-1, 1]) {
      const e = z + side * (hwRoad - 0.35);
      const dz = (zones[String(side)] || {}).dashes || [];
      for (const [a, b] of solidSpans(m0, m1, dz)) marks.flat(a, e - 0.075, b, e + 0.075, Y, COL.white);
      for (const [a, b] of dz) {
        for (let x = Math.max(a, m0) + 0.5; x < Math.min(b, m1) - 0.5; x += 5) marks.flat(x, e - 0.12, Math.min(x + 2.5, b), e + 0.12, Y, COL.white);
      }
    }
  }
}
