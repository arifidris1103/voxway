// MagicaVoxel .vox parser (versions 150 / 200) with scene-graph flattening.
//
// Returns models (dense voxel lists), the palette, MATL materials and a flat list
// of shapes, each with the accumulated MagicaVoxel transform. Coordinates stay in
// MagicaVoxel space (Z up, models face -Y); conversion to three.js happens in
// VoxAssets.js.

const GLASS = 'glass';
const EMIT = 'emit';

function readString(dv, o) {
  const n = dv.getInt32(o, true);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + 4 + i));
  return [s, o + 4 + n];
}

function readDict(dv, o) {
  const n = dv.getInt32(o, true);
  o += 4;
  const d = {};
  for (let i = 0; i < n; i++) {
    let k, v;
    [k, o] = readString(dv, o);
    [v, o] = readString(dv, o);
    d[k] = v;
  }
  return [d, o];
}

// _r byte -> row-major 3x3 rotation (MagicaVoxel spec).
function decodeRotation(byte) {
  const i0 = byte & 3;
  const i1 = (byte >> 2) & 3;
  const i2 = 3 - i0 - i1;
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  r[0 * 3 + i0] = (byte >> 4) & 1 ? -1 : 1;
  r[1 * 3 + i1] = (byte >> 5) & 1 ? -1 : 1;
  r[2 * 3 + i2] = (byte >> 6) & 1 ? -1 : 1;
  return r;
}

// Affine transform as {r: 3x3 row-major, t: [x, y, z]}.
const IDENTITY = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function compose(a, b) {
  // a * b
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a.r[i * 3 + k] * b.r[k * 3 + j];
      r[i * 3 + j] = s;
    }
  }
  const t = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    t[i] = a.t[i] + a.r[i * 3] * b.t[0] + a.r[i * 3 + 1] * b.t[1] + a.r[i * 3 + 2] * b.t[2];
  }
  return { r, t };
}

export function parseVox(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'VOX ') throw new Error('Not a MagicaVoxel file');

  const models = [];
  const nodes = new Map();
  const materials = new Map();
  const layers = new Map();
  let palette = null;
  let size = null;

  let off = 8;
  const end = buffer.byteLength;
  while (off + 12 <= end) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const contentSize = dv.getInt32(off + 4, true);
    const childrenSize = dv.getInt32(off + 8, true);
    const c = off + 12;

    if (id === 'MAIN') {
      off = c + contentSize; // children follow sequentially
      continue;
    }

    if (id === 'SIZE') {
      size = [dv.getInt32(c, true), dv.getInt32(c + 4, true), dv.getInt32(c + 8, true)];
    } else if (id === 'XYZI') {
      const n = dv.getInt32(c, true);
      models.push({ sx: size[0], sy: size[1], sz: size[2], xyzi: new Uint8Array(buffer.slice(c + 4, c + 4 + n * 4)) });
    } else if (id === 'RGBA') {
      palette = new Uint8Array(buffer.slice(c, c + 1024));
    } else if (id === 'nTRN') {
      let o = c;
      const nid = dv.getInt32(o, true);
      let attrs;
      [attrs, o] = readDict(dv, o + 4);
      const child = dv.getInt32(o, true);
      const layer = dv.getInt32(o + 8, true);
      const nFrames = dv.getInt32(o + 12, true);
      o += 16;
      const frames = [];
      for (let f = 0; f < nFrames; f++) {
        let fd;
        [fd, o] = readDict(dv, o);
        frames.push(fd);
      }
      nodes.set(nid, { type: 'trn', attrs, child, layer, frame: frames[0] || {} });
    } else if (id === 'nGRP') {
      let o = c;
      const nid = dv.getInt32(o, true);
      let attrs;
      [attrs, o] = readDict(dv, o + 4);
      const n = dv.getInt32(o, true);
      const children = [];
      for (let i = 0; i < n; i++) children.push(dv.getInt32(o + 4 + i * 4, true));
      nodes.set(nid, { type: 'grp', attrs, children });
    } else if (id === 'nSHP') {
      let o = c;
      const nid = dv.getInt32(o, true);
      let attrs;
      [attrs, o] = readDict(dv, o + 4);
      const n = dv.getInt32(o, true);
      o += 4;
      const ms = [];
      for (let i = 0; i < n; i++) {
        const mid = dv.getInt32(o, true);
        let mattrs;
        [mattrs, o] = readDict(dv, o + 4);
        ms.push(mid);
      }
      nodes.set(nid, { type: 'shp', attrs, models: ms });
    } else if (id === 'MATL') {
      const mid = dv.getInt32(c, true);
      const [d] = readDict(dv, c + 4);
      materials.set(mid, d);
    } else if (id === 'LAYR') {
      const lid = dv.getInt32(c, true);
      const [d] = readDict(dv, c + 4);
      layers.set(lid, d);
    }
    off = c + contentSize + childrenSize;
  }

  if (!palette) {
    // Files without a palette are rare; fall back to neutral greys.
    palette = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) palette.set([200, 200, 200, 255], i * 4);
  }

  // Flatten the scene graph into shapes with accumulated transforms.
  const shapes = [];
  const visit = (nid, xf, name, hidden) => {
    const node = nodes.get(nid);
    if (!node) return;
    if (node.type === 'trn') {
      const fr = node.frame;
      const local = {
        r: fr._r !== undefined ? decodeRotation(parseInt(fr._r, 10)) : IDENTITY.r.slice(),
        t: fr._t ? fr._t.split(/\s+/).map(Number) : [0, 0, 0],
      };
      const layerHidden = layers.get(node.layer)?._hidden === '1';
      visit(node.child, compose(xf, local), node.attrs._name || name,
        hidden || node.attrs._hidden === '1' || layerHidden);
    } else if (node.type === 'grp') {
      for (const ch of node.children) visit(ch, xf, name, hidden);
    } else if (node.type === 'shp') {
      for (const mid of node.models) shapes.push({ name: name || `model_${mid}`, modelIndex: mid, xf, hidden });
    }
  };
  if (nodes.size) visit(0, IDENTITY, '', false);
  else models.forEach((_, i) => shapes.push({ name: `model_${i}`, modelIndex: i, xf: IDENTITY, hidden: false }));

  // Material class per palette index (1..255).
  const matType = new Array(256).fill(null);
  for (const [idx, d] of materials) {
    if (d._type === '_glass') matType[idx] = GLASS;
    else if (d._type === '_emit') matType[idx] = EMIT;
  }

  return { models, palette, materials, matType, shapes };
}
