"""
Tiny MagicaVoxel (.vox) authoring toolkit.

Every asset in this project is written as a native MagicaVoxel file (version 150,
with a scene graph of named parts), so it can be opened, edited and re-saved in
MagicaVoxel. The three.js app loads the same files at runtime.

Conventions (same as MagicaVoxel and the NPCs in /npcs):
  * Z is up, models face -Y (the "front" of a car / character is at low Y).
  * A part's `t` translation is the world position of voxel floor(size/2).
"""
import json
import os
import struct

import numpy as np


# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------

def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Palette:
    """Named palette. Index 1..255 maps to RGBA chunk entry index-1.

    `kind` tags are exported to the asset manifest so the renderer knows which
    colours are glass, light emitters, brake lights, signal lamps, etc.
    """

    def __init__(self):
        self.entries = []          # [(name, (r, g, b), kind)]
        self.by_name = {}

    def add(self, name, color, kind=None):
        if name in self.by_name:
            return self.by_name[name]
        if len(self.entries) >= 255:
            raise ValueError('palette full')
        rgb = hex_rgb(color) if isinstance(color, str) else tuple(color)
        self.entries.append((name, rgb, kind))
        idx = len(self.entries)
        self.by_name[name] = idx
        return idx

    def __getitem__(self, name):
        return self.by_name[name]

    def __contains__(self, name):
        return name in self.by_name

    def kinds(self):
        out = {}
        for i, (_, _, kind) in enumerate(self.entries):
            if kind:
                for k in kind.split('+'):
                    out.setdefault(k, []).append(i + 1)
        return out

    def materials(self):
        """MATL dictionaries for MagicaVoxel's renderer."""
        mats = []
        for i, (_, _, kind) in enumerate(self.entries):
            if not kind:
                continue
            ks = kind.split('+')
            if 'glass' in ks:
                mats.append((i + 1, {'_type': '_glass', '_trans': '0.55', '_alpha': '0.55',
                                     '_rough': '0.1', '_ior': '0.3', '_d': '0.05'}))
            elif 'emit' in ks:
                mats.append((i + 1, {'_type': '_emit', '_emit': '0.6', '_flux': '1', '_ldr': '0'}))
            elif 'metal' in ks:
                mats.append((i + 1, {'_type': '_metal', '_metal': '0.6', '_rough': '0.3', '_sp': '0.5'}))
        return mats


# --------------------------------------------------------------------------
# Voxel grid helpers
# --------------------------------------------------------------------------

class Grid:
    """Dense voxel grid indexed [x, y, z]. 0 = empty."""

    def __init__(self, sx, sy, sz):
        self.v = np.zeros((sx, sy, sz), dtype=np.uint8)

    @property
    def shape(self):
        return self.v.shape

    def inside(self, x, y, z):
        sx, sy, sz = self.v.shape
        return 0 <= x < sx and 0 <= y < sy and 0 <= z < sz

    def set(self, x, y, z, c):
        if self.inside(x, y, z):
            self.v[x, y, z] = c

    def get(self, x, y, z):
        return self.v[x, y, z] if self.inside(x, y, z) else 0

    def box(self, x0, x1, y0, y1, z0, z1, c, only_filled=False, only_empty=False):
        """Fill inclusive box, clipped to the grid."""
        sx, sy, sz = self.v.shape
        x0, x1 = max(0, min(x0, x1)), min(sx - 1, max(x0, x1))
        y0, y1 = max(0, min(y0, y1)), min(sy - 1, max(y0, y1))
        z0, z1 = max(0, min(z0, z1)), min(sz - 1, max(z0, z1))
        if x0 > x1 or y0 > y1 or z0 > z1:
            return
        sl = self.v[x0:x1 + 1, y0:y1 + 1, z0:z1 + 1]
        if only_filled:
            sl[sl > 0] = c
        elif only_empty:
            sl[sl == 0] = c
        else:
            sl[...] = c

    def mirror_x(self):
        """Copy the low-x half onto the high-x half (left/right symmetry)."""
        sx = self.v.shape[0]
        half = sx // 2
        self.v[sx - half:, :, :] = self.v[:half, :, :][::-1, :, :]

    def surface_mask(self):
        """Voxels with at least one empty 6-neighbour."""
        f = self.v > 0
        p = np.pad(f, 1)
        interior = (p[2:, 1:-1, 1:-1] & p[:-2, 1:-1, 1:-1] & p[1:-1, 2:, 1:-1] &
                    p[1:-1, :-2, 1:-1] & p[1:-1, 1:-1, 2:] & p[1:-1, 1:-1, :-2])
        return f & ~interior

    def bbox(self):
        xs, ys, zs = np.nonzero(self.v)
        return (xs.min(), xs.max(), ys.min(), ys.max(), zs.min(), zs.max())

    def count(self):
        return int(np.count_nonzero(self.v))


def lerp_curve(points):
    """Piecewise-linear curve through [(u, value), ...]; clamps at the ends."""
    pts = sorted(points)
    us = np.array([p[0] for p in pts], dtype=float)
    vs = np.array([p[1] for p in pts], dtype=float)

    def f(u):
        return float(np.interp(u, us, vs))
    return f


# --------------------------------------------------------------------------
# .vox writer
# --------------------------------------------------------------------------

def _chunk(cid, content=b'', children=b''):
    return cid.encode('ascii') + struct.pack('<ii', len(content), len(children)) + content + children


def _vstr(s):
    b = s.encode('utf-8')
    return struct.pack('<i', len(b)) + b


def _vdict(d):
    return struct.pack('<i', len(d)) + b''.join(_vstr(k) + _vstr(str(v)) for k, v in d.items())


def write_vox(path, parts, palette, layer_name='main'):
    """parts: [{'name': str, 'grid': Grid|ndarray, 't': (x, y, z) or None}]

    If `t` is None the part is centred on x/y with its bottom on z = 0.
    """
    body = b''
    norm = []
    for p in parts:
        g = p['grid'].v if isinstance(p['grid'], Grid) else p['grid']
        sx, sy, sz = g.shape
        if max(sx, sy, sz) > 256:
            raise ValueError('%s: model exceeds 256 voxels per axis %s' % (p['name'], g.shape))
        t = p.get('t')
        if t is None:
            t = (0, 0, sz // 2)
        norm.append((p['name'], g, tuple(int(round(c)) for c in t), p.get('hidden', False)))

    for _, g, _, _ in norm:
        sx, sy, sz = g.shape
        xs, ys, zs = np.nonzero(g)
        xyzi = np.stack([xs, ys, zs, g[xs, ys, zs]], axis=1).astype(np.uint8)
        body += _chunk('SIZE', struct.pack('<iii', sx, sy, sz))
        body += _chunk('XYZI', struct.pack('<i', len(xs)) + xyzi.tobytes())

    n = len(norm)
    child_ids = [2 + 2 * i for i in range(n)]
    body += _chunk('nTRN', struct.pack('<i', 0) + _vdict({}) + struct.pack('<iiii', 1, -1, -1, 1) + _vdict({}))
    body += _chunk('nGRP', struct.pack('<i', 1) + _vdict({}) + struct.pack('<i', n) +
                   struct.pack('<%di' % n, *child_ids))
    for i, (name, g, t, hidden) in enumerate(norm):
        tid, sid = 2 + 2 * i, 3 + 2 * i
        attrs = {'_name': name}
        if hidden:
            attrs['_hidden'] = '1'
        body += _chunk('nTRN', struct.pack('<i', tid) + _vdict(attrs) + struct.pack('<iiii', sid, -1, 0, 1) +
                       _vdict({'_t': '%d %d %d' % t}))
        body += _chunk('nSHP', struct.pack('<i', sid) + _vdict({}) + struct.pack('<i', 1) +
                       struct.pack('<i', i) + _vdict({}))
    body += _chunk('LAYR', struct.pack('<i', 0) + _vdict({'_name': layer_name}) + struct.pack('<i', -1))

    rgba = bytearray(256 * 4)
    for i, (_, rgb, _) in enumerate(palette.entries):
        rgba[i * 4:i * 4 + 4] = bytes((rgb[0], rgb[1], rgb[2], 255))
    body += _chunk('RGBA', bytes(rgba))
    for idx, mat in palette.materials():
        body += _chunk('MATL', struct.pack('<i', idx) + _vdict(mat))

    data = b'VOX ' + struct.pack('<i', 150) + _chunk('MAIN', b'', body)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    return len(data)


# --------------------------------------------------------------------------
# .vox reader (used to read the hand-made NPCs back for the manifest)
# --------------------------------------------------------------------------

def read_vox(path):
    data = open(path, 'rb').read()
    out = []

    def walk(off, end):
        while off < end:
            cid = data[off:off + 4].decode('latin1')
            cs, ch = struct.unpack_from('<ii', data, off + 4)
            out.append((cid, data[off + 12:off + 12 + cs]))
            if ch:
                walk(off + 12 + cs, off + 12 + cs + ch)
            off += 12 + cs + ch
    walk(8, len(data))
    sizes = [struct.unpack_from('<iii', c, 0) for i, c in out if i == 'SIZE']
    models = []
    for (cid, c), in zip([(i, c) for i, c in out if i == 'XYZI']):
        n, = struct.unpack_from('<i', c, 0)
        models.append(np.frombuffer(c, dtype=np.uint8, count=n * 4, offset=4).reshape(-1, 4))
    pal = [c for i, c in out if i == 'RGBA']
    return sizes, models, pal[0] if pal else None


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------

class Manifest:
    def __init__(self, path):
        self.path = path
        self.assets = {}
        if os.path.exists(path):
            with open(path) as f:
                self.assets = json.load(f).get('assets', {})

    def add(self, key, **meta):
        self.assets[key] = meta

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, 'w') as f:
            json.dump({'assets': self.assets}, f, indent=1, sort_keys=True)
