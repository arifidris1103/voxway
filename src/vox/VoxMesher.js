// Greedy voxel mesher with baked per-vertex ambient occlusion.
//
// Faces are merged only when colour, material class and all four AO corner values
// match, so the merged quads shade exactly like per-voxel quads. Output geometry is
// in MagicaVoxel space (Z up), in voxel units, centred on the model's volume centre.

import * as THREE from 'three';

export const MAT = {
  OPAQUE: 0,
  GLASS: 1,
  EMIT: 2,
  BRAKE: 3,
  SIG_RED: 4,
  SIG_YELLOW: 5,
  SIG_GREEN: 6,
  PED_STOP: 7,
  PED_WALK: 8,
  HEAD: 9,
};
export const MAT_COUNT = 10;

// Brightness for AO levels 0 (fully occluded corner) .. 3 (open).
const AO_CURVE = [0.52, 0.7, 0.86, 1.0];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function paletteToLinear(palette) {
  const out = new Float32Array(256 * 3);
  for (let i = 1; i < 256; i++) {
    const o = (i - 1) * 4;
    out[i * 3] = srgbToLinear(palette[o] / 255);
    out[i * 3 + 1] = srgbToLinear(palette[o + 1] / 255);
    out[i * 3 + 2] = srgbToLinear(palette[o + 2] / 255);
  }
  return out;
}

/**
 * @param {{sx:number, sy:number, sz:number, xyzi:Uint8Array}} model
 * @param {Float32Array} linPalette  256*3 linear RGB, index = colour index
 * @param {Uint8Array} classOf       256 entries: MAT class per colour index
 * @returns {THREE.BufferGeometry|null}
 */
export function meshVoxModel(model, linPalette, classOf) {
  const { sx, sy, sz, xyzi } = model;
  const dims = [sx, sy, sz];
  const vol = new Uint8Array(sx * sy * sz);
  for (let i = 0; i < xyzi.length; i += 4) {
    vol[xyzi[i] + xyzi[i + 1] * sx + xyzi[i + 2] * sx * sy] = xyzi[i + 3];
  }
  if (!xyzi.length) return null;

  const get = (x, y, z) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : vol[x + y * sx + z * sx * sy];
  // Glass neither occludes light (AO) nor hides the faces behind it.
  const occ = (x, y, z) => {
    const c = get(x, y, z);
    return c !== 0 && classOf[c] !== MAT.GLASS ? 1 : 0;
  };

  // Flood-fill the outside air (glass is see-through, so it passes too). Faces that
  // look into a sealed cavity - e.g. the inside of a hollow building shell - are
  // never visible and are skipped.
  const N = sx * sy * sz;
  const ext = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const seed = (i) => {
    if (ext[i]) return;
    const c = vol[i];
    if (c === 0 || classOf[c] === MAT.GLASS) { ext[i] = 1; queue[qt++] = i; }
  };
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) { seed(y * sx + z * sx * sy); seed(sx - 1 + y * sx + z * sx * sy); }
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { seed(x + z * sx * sy); seed(x + (sy - 1) * sx + z * sx * sy); }
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) { seed(x + y * sx); seed(x + y * sx + (sz - 1) * sx * sy); }
  const sxy = sx * sy;
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / sxy) | 0;
    if (x > 0) seed(i - 1);
    if (x < sx - 1) seed(i + 1);
    if (y > 0) seed(i - sx);
    if (y < sy - 1) seed(i + sx);
    if (z > 0) seed(i - sxy);
    if (z < sz - 1) seed(i + sxy);
  }
  const outside = (x, y, z) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 1 : ext[x + y * sx + z * sxy];

  // Per-material output buffers.
  const buckets = [];
  const bucket = (m) => (buckets[m] ||= { pos: [], nrm: [], col: [], idx: [] });

  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const cx = sx / 2, cy = sy / 2, cz = sz / 2;

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u], dvv = dims[v];
    const mask = new Int32Array(du * dvv);
    const aoMask = new Uint8Array(du * dvv * 4);

    for (const s of [1, -1]) {
      for (let slice = 0; slice < dims[d]; slice++) {
        // 1. Build the face mask for this slice.
        let n = 0;
        for (let j = 0; j < dvv; j++) {
          for (let i = 0; i < du; i++, n++) {
            p[d] = slice; p[u] = i; p[v] = j;
            const c = get(p[0], p[1], p[2]);
            mask[n] = 0;
            if (!c) continue;
            q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
            q[d] += s;
            const nb = get(q[0], q[1], q[2]);
            const cls = classOf[c];
            const visible = (cls === MAT.GLASS
              ? nb === 0
              : nb === 0 || classOf[nb] === MAT.GLASS) && outside(q[0], q[1], q[2]);
            if (!visible) continue;

            // AO for corners (u-,v-), (u+,v-), (u+,v+), (u-,v+), sampled in the layer in front of the face.
            const ao = [0, 0, 0, 0];
            const su = [-1, 1, 1, -1];
            const sv = [-1, -1, 1, 1];
            for (let k = 0; k < 4; k++) {
              const a = [q[0], q[1], q[2]];
              const b = [q[0], q[1], q[2]];
              const e = [q[0], q[1], q[2]];
              a[u] += su[k];
              b[v] += sv[k];
              e[u] += su[k]; e[v] += sv[k];
              const s1 = occ(a[0], a[1], a[2]);
              const s2 = occ(b[0], b[1], b[2]);
              const cr = occ(e[0], e[1], e[2]);
              ao[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + cr);
            }
            aoMask[n * 4] = ao[0]; aoMask[n * 4 + 1] = ao[1]; aoMask[n * 4 + 2] = ao[2]; aoMask[n * 4 + 3] = ao[3];
            const uniform = ao[0] === ao[1] && ao[1] === ao[2] && ao[2] === ao[3];
            // key: colour | ao | non-uniform flag (non-uniform faces never merge)
            mask[n] = c | (ao[0] << 8) | (ao[1] << 10) | (ao[2] << 12) | (ao[3] << 14) | (uniform ? 0 : 1 << 16);
          }
        }

        // 2. Greedy merge.
        n = 0;
        for (let j = 0; j < dvv; j++) {
          for (let i = 0; i < du;) {
            const key = mask[n];
            if (!key) { i++; n++; continue; }
            let w = 1, h = 1;
            if (!(key & (1 << 16))) {
              while (i + w < du && mask[n + w] === key) w++;
              outer: for (; j + h < dvv; h++) {
                for (let k = 0; k < w; k++) if (mask[n + k + h * du] !== key) break outer;
              }
            }
            const c = key & 255;
            const ao = [aoMask[n * 4], aoMask[n * 4 + 1], aoMask[n * 4 + 2], aoMask[n * 4 + 3]];
            emitQuad(bucket(classOf[c]), d, u, v, s, slice, i, j, w, h, c, ao);
            for (let hh = 0; hh < h; hh++) for (let ww = 0; ww < w; ww++) mask[n + ww + hh * du] = 0;
            i += w; n += w;
          }
        }
      }
    }
  }

  function emitQuad(b, d, u, v, s, slice, i, j, w, h, c, ao) {
    const base = b.pos.length / 3;
    const plane = slice + (s > 0 ? 1 : 0);
    const corners = [[i, j], [i + w, j], [i + w, j + h], [i, j + h]];
    const nrm = [0, 0, 0];
    nrm[d] = s;
    const r = linPalette[c * 3], g = linPalette[c * 3 + 1], bl = linPalette[c * 3 + 2];
    for (let k = 0; k < 4; k++) {
      const pt = [0, 0, 0];
      pt[d] = plane; pt[u] = corners[k][0]; pt[v] = corners[k][1];
      b.pos.push(pt[0] - cx, pt[1] - cy, pt[2] - cz);
      b.nrm.push(nrm[0], nrm[1], nrm[2]);
      const f = AO_CURVE[ao[k]];
      b.col.push(r * f, g * f, bl * f);
    }
    // Flip the diagonal so AO interpolates symmetrically.
    const flip = ao[1] + ao[3] > ao[0] + ao[2];
    let tris = flip ? [0, 1, 3, 1, 2, 3] : [0, 1, 2, 0, 2, 3];
    if (s < 0) tris = [tris[0], tris[2], tris[1], tris[3], tris[5], tris[4]];
    for (const t of tris) b.idx.push(base + t);
  }

  // 3. Concatenate buckets into one geometry with a group per material class.
  let vCount = 0, iCount = 0;
  for (const b of buckets) if (b) { vCount += b.pos.length / 3; iCount += b.idx.length; }
  if (!vCount) return null;
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const geo = new THREE.BufferGeometry();
  let vo = 0, io = 0;
  buckets.forEach((b, m) => {
    if (!b) return;
    pos.set(b.pos, vo * 3);
    nrm.set(b.nrm, vo * 3);
    col.set(b.col, vo * 3);
    for (let k = 0; k < b.idx.length; k++) idx[io + k] = b.idx[k] + vo;
    geo.addGroup(io, b.idx.length, m);
    vo += b.pos.length / 3;
    io += b.idx.length;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
