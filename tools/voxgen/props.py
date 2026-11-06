"""
World props and buildings, inspired by the reference photo in /road
(Shanghai-style elevated expressway interchange: concrete piers with hammerhead
caps, teal parapets, double-arm lamps, red-roofed residential blocks, white
residential towers and blue glass office towers).

Every generator returns a list of (name, parts, palette, meta). Voxel sizes:
  street furniture 0.1 m, trees 0.15 m, piers 0.25 m, buildings 0.5 m.
Assets face -Y; road-side props put the road on the -Y side.
"""
import math
import random

import numpy as np

from voxlib import Palette


class M:
    """Minimal voxel modelling helper (x, y, z grid; z up)."""

    def __init__(self, sx, sy, sz):
        self.v = np.zeros((sx, sy, sz), np.uint8)

    def box(self, x0, x1, y0, y1, z0, z1, c):
        sx, sy, sz = self.v.shape
        xa, xb = max(0, min(x0, x1)), min(sx - 1, max(x0, x1))
        ya, yb = max(0, min(y0, y1)), min(sy - 1, max(y0, y1))
        za, zb = max(0, min(z0, z1)), min(sz - 1, max(z0, z1))
        if xa <= xb and ya <= yb and za <= zb:
            self.v[xa:xb + 1, ya:yb + 1, za:zb + 1] = c

    def set(self, x, y, z, c):
        sx, sy, sz = self.v.shape
        if 0 <= x < sx and 0 <= y < sy and 0 <= z < sz:
            self.v[x, y, z] = c

    def cyl_z(self, cx, cy, r, z0, z1, c):
        sx, sy, _ = self.v.shape
        X, Y = np.meshgrid(np.arange(sx), np.arange(sy), indexing='ij')
        m = (X + 0.5 - cx) ** 2 + (Y + 0.5 - cy) ** 2 <= r * r
        for z in range(max(0, z0), min(self.v.shape[2] - 1, z1) + 1):
            self.v[:, :, z][m] = c

    def blob(self, cx, cy, cz, rx, ry, rz, colors, rng, rough=0.18, only_empty=True, cell=3):
        """Lumpy ellipsoid. Shape and colour noise are sampled on a coarse `cell`
        grid so neighbouring voxels share colours (keeps greedy meshing effective)."""
        sx, sy, sz = self.v.shape
        X, Y, Z = np.meshgrid(np.arange(sx), np.arange(sy), np.arange(sz), indexing='ij')
        d = ((X + 0.5 - cx) / rx) ** 2 + ((Y + 0.5 - cy) / ry) ** 2 + ((Z + 0.5 - cz) / rz) ** 2
        coarse = rng.random((sx // cell + 2, sy // cell + 2, sz // cell + 2))
        noise = coarse[X // cell, Y // cell, Z // cell]
        m = d <= 1.0 - noise * rough
        if only_empty:
            m &= self.v == 0
        # shade: lighter on top, darker below, with blocky variation
        t = np.clip((Z + 0.5 - (cz - rz)) / (2 * rz), 0, 1)
        idx = np.clip((t * len(colors)).astype(int) + (noise > 0.72), 0, len(colors) - 1)
        cols = np.array(colors, np.uint8)
        self.v[m] = cols[idx[m]]


def part(m, name='main', t=None):
    sx, sy, sz = m.v.shape
    return {'name': name, 'grid': m.v, 't': t if t is not None else (0, 0, sz // 2)}


def shell(m):
    """Keep only voxels with an empty 6-neighbour (big buildings are stored hollow;
    the mesher flood-fills from outside so the hidden inner faces are skipped)."""
    f = m.v > 0
    p = np.pad(f, 1)
    inner = (p[2:, 1:-1, 1:-1] & p[:-2, 1:-1, 1:-1] & p[1:-1, 2:, 1:-1] &
             p[1:-1, :-2, 1:-1] & p[1:-1, 1:-1, 2:] & p[1:-1, 1:-1, :-2])
    m.v[f & inner] = 0
    return m


# ---------------------------------------------------------------------------
# Street furniture (0.1 m voxels)
# ---------------------------------------------------------------------------

def street_lights():
    out = []
    # Ground street lamp: pole at origin, single arm reaching over the road (-Y).
    P = Palette()
    pole, dark, head, glow = P.add('pole', '#5d646c'), P.add('dark', '#3a3f45'), P.add('head', '#d9dde2'), P.add('lamp', '#fff1c4', 'emit')
    m = M(8, 26, 92)
    m.box(3, 4, 21, 22, 0, 85, pole)
    m.box(2, 5, 20, 23, 0, 3, dark)
    m.box(3, 4, 4, 22, 84, 85, pole)          # arm
    m.box(2, 5, 1, 8, 82, 84, head)
    m.box(2, 5, 1, 8, 82, 82, glow)
    out.append(('street_lamp', [part(m, t=(0, 9, 46))], P, {'voxelSize': 0.1, 'label': 'Street lamp', 'group': 'props'}))

    # Expressway double-arm lamp (sits on the median barrier).
    P = Palette()
    pole, head, glow = P.add('pole', '#c7ccd1'), P.add('head', '#e8ebee'), P.add('lamp', '#fff1c4', 'emit')
    m = M(8, 60, 100)
    m.box(3, 4, 29, 30, 0, 92, pole)
    for y0, y1, hy in ((6, 29, 3), (30, 53, 50)):
        m.box(3, 4, y0, y1, 91, 92, pole)
        m.box(2, 5, hy, hy + 7, 89, 91, head)
        m.box(2, 5, hy, hy + 7, 89, 89, glow)
    out.append(('viaduct_lamp', [part(m, t=(0, 0, 50))], P, {'voxelSize': 0.1, 'label': 'Expressway lamp', 'group': 'props'}))
    return out


def _signal_head(m, x, y, z, P):
    """Vertical 3-lamp head, lamps facing -Y. (x, y, z) = lower-left-front corner."""
    m.box(x, x + 3, y, y + 2, z, z + 11, P['housing'])
    m.box(x - 1, x + 4, y + 1, y + 2, z - 1, z + 12, P['housing'])
    for k, name in ((8, 'red'), (4, 'yellow'), (0, 'green')):
        m.box(x + 1, x + 2, y, y, z + 1 + k, z + 2 + k, P[name])
        m.box(x + 1, x + 2, y - 1, y - 1, z + 3 + k, z + 3 + k, P['housing'])   # visor


def signals():
    out = []
    for name, arm in (('signal_mast_short', 70), ('signal_mast_long', 115)):
        P = Palette()
        P.add('pole', '#4f565d')
        P.add('housing', '#1b1d20')
        P.add('red', '#ff3b30', 'sig_red')
        P.add('yellow', '#ffc21a', 'sig_yellow')
        P.add('green', '#2ee86a', 'sig_green')
        P.add('base', '#3a3f45')
        P.add('sign', '#f4f4f4')
        P.add('signb', '#1f5fbf')
        m = M(arm + 8, 8, 66)
        m.box(2, 4, 3, 5, 0, 64, P['pole'])
        m.box(1, 5, 2, 6, 0, 2, P['base'])
        m.box(4, arm + 5, 3, 4, 60, 61, P['pole'])                     # mast arm along +X
        for k in range(8):                                              # brace
            m.box(4 + k * 2, 5 + k * 2, 3, 4, 58 - k, 58 - k, P['pole'])
        for hx in (arm - 6, arm - 32) if arm > 80 else (arm - 6, arm - 26):
            _signal_head(m, hx, 1, 46, P)
            m.box(hx + 1, hx + 2, 3, 4, 58, 59, P['pole'])
        _signal_head(m, 6, 1, 34, P)                                   # near-side head on the pole
        m.box(arm - 50, arm - 38, 4, 4, 52, 57, P['signb'])            # street-name sign
        m.box(arm - 49, arm - 39, 3, 3, 53, 56, P['sign'])
        out.append((name, [part(m, t=(arm // 2 + 1, 0, 33))], P,
                    {'voxelSize': 0.1, 'label': name.replace('_', ' ').title(), 'group': 'props',
                     'armLength': round(arm * 0.1, 2)}))

    P = Palette()
    P.add('pole', '#4f565d')
    P.add('housing', '#1b1d20')
    stop = P.add('stop', '#ff4a2a', 'ped_stop')
    walk = P.add('walk', '#2ee8a0', 'ped_walk')
    P.add('base', '#3a3f45')
    m = M(8, 8, 34)
    m.box(3, 4, 3, 4, 0, 26, P['pole'])
    m.box(1, 6, 1, 5, 20, 33, P['housing'])
    # red hand (top) and green walker (bottom) on the -Y face
    m.box(2, 5, 0, 0, 28, 31, stop)
    m.box(3, 4, 0, 0, 22, 25, walk)
    m.box(2, 2, 0, 0, 23, 24, walk)
    m.box(5, 5, 0, 0, 22, 23, walk)
    out.append(('ped_signal', [part(m, t=(0, 0, 17))], P, {'voxelSize': 0.1, 'label': 'Pedestrian signal', 'group': 'props'}))
    return out


def roadwork():
    out = []
    P = Palette()
    o, w, b = P.add('orange', '#ff6a13'), P.add('white', '#f4f4f4'), P.add('base', '#1d1f22')
    m = M(8, 8, 15)                        # 0.05 m voxels -> 0.75 m cone
    for z in range(0, 14):
        r = 3.6 - z * 0.2
        m.cyl_z(4, 4, r, z, z, w if z in (6, 7, 10) else o)
    m.box(0, 7, 0, 7, 0, 0, b)
    out.append(('cone', [part(m, t=(0, 0, 7))], P, {'voxelSize': 0.05, 'label': 'Traffic cone', 'group': 'props'}))

    P = Palette()
    o, w, leg, lamp = P.add('orange', '#ff6a13'), P.add('white', '#f4f4f4'), P.add('leg', '#2a2d31'), P.add('lamp', '#ffb21a', 'emit')
    m = M(30, 6, 14)                        # 0.1 m voxels -> 3 m barrier
    for x in range(30):
        m.box(x, x, 2, 3, 7, 10, o if (x // 3) % 2 == 0 else w)
    for x0 in (2, 26):
        m.box(x0, x0 + 1, 2, 3, 0, 7, leg)
        m.box(x0 - 1, x0 + 2, 0, 5, 0, 0, leg)
    m.box(14, 15, 2, 3, 11, 12, lamp)
    out.append(('barrier', [part(m, t=(0, 0, 7))], P, {'voxelSize': 0.1, 'label': 'Roadwork barrier', 'group': 'props'}))

    P = Palette()
    y, k, leg = P.add('yellow', '#ffcc1a'), P.add('black', '#1b1b1b'), P.add('leg', '#3a3f45')
    m = M(14, 4, 22)
    for z in range(8, 21):
        half = (20 - z) * 0.5
        m.box(int(7 - half), int(6 + half), 1, 1, z, z, y)
    m.box(6, 7, 1, 1, 11, 16, k)
    m.box(6, 7, 0, 0, 0, 9, leg)
    m.box(4, 9, 0, 3, 0, 0, leg)
    out.append(('sign_roadwork', [part(m, t=(0, 0, 11))], P, {'voxelSize': 0.1, 'label': 'Roadwork sign', 'group': 'props'}))

    # Red warning triangle placed behind a crash (0.04 m voxels -> ~0.5 m wide)
    P = Palette()
    red, refl, leg = P.add('red', '#e8231d'), P.add('reflective', '#ff6a5a', 'emit'), P.add('leg', '#2a2c30')
    m = M(13, 4, 12)
    for z in range(1, 12):
        half = (11 - z) * 0.55
        x0, x1 = int(round(6 - half)), int(round(6 + half))
        if z in (1, 2) or z >= 10:
            m.box(x0, x1, 1, 1, z, z, red)
        else:
            m.set(x0, 1, z, red)
            m.set(x1, 1, z, red)
            if x1 - x0 > 2:
                m.set(x0 + 1, 1, z, refl)
                m.set(x1 - 1, 1, z, refl)
    m.box(2, 10, 0, 3, 0, 0, leg)
    out.append(('warning_triangle', [part(m, t=(0, 0, 6))], P, {'voxelSize': 0.04, 'label': 'Warning triangle', 'group': 'props'}))
    return out


def furniture():
    out = []
    P = Palette()
    wood, metal = P.add('wood', '#9b6a3e'), P.add('metal', '#3c4248')
    m = M(18, 6, 9)
    m.box(0, 17, 1, 4, 4, 4, wood)
    m.box(0, 17, 4, 4, 5, 8, wood)
    for x0 in (1, 15):
        m.box(x0, x0 + 1, 1, 4, 0, 3, metal)
    out.append(('bench', [part(m, t=(0, 0, 4))], P, {'voxelSize': 0.1, 'label': 'Bench', 'group': 'props'}))

    P = Palette()
    g, d = P.add('green', '#2f7d5b'), P.add('dark', '#20543d')
    m = M(6, 6, 10)
    m.box(0, 5, 0, 5, 0, 8, g)
    m.box(0, 5, 0, 5, 9, 9, d)
    m.box(1, 4, 0, 0, 5, 6, d)
    out.append(('bin', [part(m, t=(0, 0, 5))], P, {'voxelSize': 0.1, 'label': 'Bin', 'group': 'props'}))

    P = Palette()
    b, y = P.add('bollard', '#4a4f55'), P.add('band', '#ffd23a')
    m = M(3, 3, 9)
    m.box(0, 2, 0, 2, 0, 8, b)
    m.box(0, 2, 0, 2, 6, 6, y)
    out.append(('bollard', [part(m, t=(0, 0, 4))], P, {'voxelSize': 0.1, 'label': 'Bollard', 'group': 'props'}))

    # bus shelter
    P = Palette()
    frame, roof, glass, ad, seat = (P.add('frame', '#4c545c'), P.add('roof', '#dfe3e6'),
                                    P.add('glass', '#9fc6d6', 'glass'), P.add('ad', '#f0a020', 'emit'), P.add('seat', '#7a8088'))
    m = M(40, 16, 28)
    m.box(0, 39, 0, 15, 26, 27, roof)
    for x0 in (0, 38):
        m.box(x0, x0 + 1, 12, 13, 0, 25, frame)
        m.box(x0, x0 + 1, 2, 3, 0, 25, frame)
    m.box(2, 37, 13, 13, 4, 24, glass)
    m.box(0, 1, 4, 11, 4, 24, glass)
    m.box(28, 37, 12, 12, 6, 22, ad)
    m.box(4, 24, 9, 11, 5, 5, seat)
    out.append(('bus_shelter', [part(m, t=(0, 0, 14))], P, {'voxelSize': 0.1, 'label': 'Bus shelter', 'group': 'props'}))
    return out


def gantry():
    """Green overhead direction sign spanning a carriageway (~12 m)."""
    P = Palette()
    post, green, white, edge = P.add('post', '#9aa1a8'), P.add('green', '#1f7a4a'), P.add('white', '#f2f2f2'), P.add('edge', '#e9ecef')
    W = 124
    m = M(W, 8, 72)
    for x0 in (0, W - 3):
        m.box(x0, x0 + 2, 3, 5, 0, 70, post)
    m.box(0, W - 1, 3, 4, 66, 68, post)
    m.box(0, W - 1, 3, 4, 52, 53, post)
    m.box(14, W - 15, 1, 2, 44, 66, green)
    m.box(14, W - 15, 1, 1, 44, 44, edge)
    m.box(14, W - 15, 1, 1, 66, 66, edge)
    rng = random.Random(7)
    # "text" lines + arrows
    for row, z in enumerate((60, 55, 49)):
        x = 20
        while x < W - 30:
            n = rng.randint(3, 7)
            m.box(x, x + n, 0, 0, z, z + 2, white)
            x += n + rng.randint(2, 4)
    for ax in (40, 84):
        m.box(ax, ax + 1, 0, 0, 45, 47, white)
        m.box(ax - 1, ax + 2, 0, 0, 47, 47, white)
    return [('gantry', [part(m, t=(0, 0, 36))], P, {'voxelSize': 0.1, 'label': 'Sign gantry', 'group': 'props'})]


# ---------------------------------------------------------------------------
# Vegetation (0.15 m voxels)
# ---------------------------------------------------------------------------

def trees():
    out = []
    for i, (name, greens) in enumerate((
        ('tree_plane_a', ['#3e6b2b', '#4f8434', '#62993f', '#7aae4c']),
        ('tree_plane_b', ['#47702c', '#5a8a35', '#6e9f40', '#8bb653']),
        ('tree_plane_c', ['#355f2a', '#467a33', '#58913d', '#6aa547']),
    )):
        rng = np.random.default_rng(11 + i)
        P = Palette()
        bark, bark2 = P.add('bark', '#7d6f62'), P.add('bark2', '#a3968a')
        cols = [P.add('leaf%d' % k, c) for k, c in enumerate(greens)]
        m = M(34, 34, 44)
        m.box(15, 18, 15, 18, 0, 22, bark)
        m.box(15, 15, 16, 17, 4, 16, bark2)
        m.box(17, 20, 16, 17, 16, 19, bark)
        m.box(13, 16, 17, 18, 17, 21, bark)
        m.blob(17, 17, 30, 15, 15, 11, cols, rng)
        m.blob(11, 20, 26, 7, 7, 6, cols, rng)
        m.blob(23, 13, 27, 7, 7, 6, cols, rng)
        out.append((name, [part(m)], P, {'voxelSize': 0.15, 'label': 'Plane tree', 'group': 'props'}))

    rng = np.random.default_rng(5)
    P = Palette()
    bark = P.add('bark', '#5d4b3c')
    cols = [P.add('c%d' % k, c) for k, c in enumerate(['#1f4a2a', '#285833', '#33683c', '#3f7a46'])]
    m = M(16, 16, 54)
    m.box(7, 8, 7, 8, 0, 6, bark)
    for z in range(4, 53):
        r = 7.2 * (1 - (z - 4) / 52.0) ** 0.8 + 0.6
        sub = M(16, 16, 1)
        X, Y = np.meshgrid(np.arange(16), np.arange(16), indexing='ij')
        d = np.sqrt((X + 0.5 - 8) ** 2 + (Y + 0.5 - 8) ** 2)
        mask = d <= r - rng.random((16, 16)) * 1.2
        t = min(len(cols) - 1, int((z / 54) * len(cols) + rng.random() * 0.8))
        m.v[:, :, z][mask & (m.v[:, :, z] == 0)] = cols[t]
    out.append(('tree_cypress', [part(m)], P, {'voxelSize': 0.15, 'label': 'Cypress', 'group': 'props'}))

    rng = np.random.default_rng(9)
    P = Palette()
    cols = [P.add('s%d' % k, c) for k, c in enumerate(['#3d6a2f', '#4c7f37', '#5f9442'])]
    m = M(14, 14, 8)
    m.blob(7, 7, 2.5, 7, 7, 5, cols, rng, rough=0.25)
    out.append(('shrub', [part(m)], P, {'voxelSize': 0.15, 'label': 'Shrub', 'group': 'props'}))

    P = Palette()
    cols = [P.add('f%d' % k, c) for k, c in enumerate(['#3d7a2f', '#ffd21f', '#ffb31a', '#ffe36b'])]
    m = M(20, 12, 3)
    rng = np.random.default_rng(3)
    X, Y = np.meshgrid(np.arange(20), np.arange(12), indexing='ij')
    d = ((X + 0.5 - 10) / 10) ** 2 + ((Y + 0.5 - 6) / 6) ** 2
    m.v[:, :, 0][d <= 1] = cols[0]
    top = (d <= 0.85) & (rng.random((20, 12)) < 0.9)
    m.v[:, :, 1][top] = np.array(cols[1:])[rng.integers(0, 3, (20, 12))][top]
    out.append(('flowerbed', [part(m)], P, {'voxelSize': 0.3, 'label': 'Flower bed', 'group': 'props'}))
    return out


# ---------------------------------------------------------------------------
# Expressway pier (0.25 m voxels)
# ---------------------------------------------------------------------------

def piers():
    P = Palette()
    c1, c2, c3 = P.add('concrete', '#c9c6be'), P.add('concrete2', '#bdb9b0'), P.add('concrete3', '#d6d3cb')
    pad = P.add('pad', '#9c9a94')
    # column 2 m x 3 m, deck soffit at 10.4 m, hammerhead 16 m wide
    m = M(64, 14, 44)
    m.box(28, 35, 1, 12, 0, 33, c1)
    m.box(28, 28, 1, 12, 0, 33, c2)
    m.box(27, 36, 0, 13, 0, 1, pad)
    for k in range(8):                    # flared hammerhead
        half = 4 + k * 3.6
        m.box(int(32 - half), int(31 + half), 1, 12, 34 + k, 34 + k, c3 if k > 5 else c1)
    m.box(0, 63, 1, 12, 41, 41, c3)
    for x0 in (6, 22, 38, 54):           # bearings
        m.box(x0, x0 + 3, 4, 9, 42, 42, pad)
    out = [('pier', [part(m)], P, {'voxelSize': 0.25, 'label': 'Expressway pier', 'group': 'props'})]

    # Portal frame for the second-level flyover: two columns on either side of the
    # street and a cross beam whose top (20.5 m) carries the deck. Beam along X.
    P = Palette()
    c1, c2, c3 = P.add('concrete', '#c9c6be'), P.add('concrete2', '#b7b3aa'), P.add('concrete3', '#d6d3cb')
    pad = P.add('pad', '#9c9a94')
    m = M(106, 6, 82)
    for x0 in (0, 101):
        m.box(x0, x0 + 4, 0, 5, 0, 75, c1)
        m.box(x0, x0, 0, 5, 0, 75, c2)
        m.box(x0 - 1, x0 + 5, -1, 6, 0, 1, pad)
    m.box(0, 105, 0, 5, 76, 81, c3)
    m.box(0, 105, 0, 5, 76, 76, c2)
    for k in range(4):                    # haunches where columns meet the beam
        m.box(5, 5 + 3 - k, 0, 5, 72 + k, 72 + k, c1)
        m.box(100 - 3 + k, 100, 0, 5, 72 + k, 72 + k, c1)
    out.append(('pier_portal', [part(m)], P, {'voxelSize': 0.25, 'label': 'Flyover portal pier', 'group': 'props'}))

    # Single column for the curved ramps (scaled vertically per instance).
    P = Palette()
    c1, c2, c3 = P.add('concrete', '#c9c6be'), P.add('concrete2', '#b7b3aa'), P.add('concrete3', '#d6d3cb')
    m = M(24, 8, 84)
    m.box(8, 15, 0, 7, 0, 79, c1)
    m.box(8, 8, 0, 7, 0, 79, c2)
    for k in range(4):
        half = 4 + k * 2.6
        m.box(int(12 - half), int(11 + half), 0, 7, 80 + k, 80 + k, c3 if k == 3 else c1)
    out.append(('pier_ramp', [part(m)], P, {'voxelSize': 0.25, 'label': 'Ramp pier', 'group': 'props'}))
    return out


# ---------------------------------------------------------------------------
# Buildings (0.5 m voxels)
# ---------------------------------------------------------------------------

def _windows(m, face, x0, x1, z0, z1, floor_h, win_w, win_h, gap, glass, frame=None, y=None, x=None):
    """Punch a regular window grid on a facade. face: '-y', '+y', '-x', '+x'."""
    for zf in range(z0, z1 - win_h + 1, floor_h):
        for xa in range(x0, x1 - win_w + 1, win_w + gap):
            if face in ('-y', '+y'):
                m.box(xa, xa + win_w - 1, y, y, zf, zf + win_h - 1, glass)
                if frame:
                    m.box(xa, xa + win_w - 1, y, y, zf - 1, zf - 1, frame)
            else:
                m.box(x, x, xa, xa + win_w - 1, zf, zf + win_h - 1, glass)
                if frame:
                    m.box(x, x, xa, xa + win_w - 1, zf - 1, zf - 1, frame)


def resi_redroof(name, length, floors, wall, seed):
    """5-7 storey slab with balconies and a terracotta gable roof."""
    rng = random.Random(seed)
    P = Palette()
    w, w2 = P.add('wall', wall), P.add('wall2', _shade(wall, 0.9))
    roof, roof2, ridge = P.add('roof', '#b54a32'), P.add('roof2', '#9c3d29'), P.add('ridge', '#7f3020')
    glass, frame, rail, base = P.add('glass', '#4f6f8c'), P.add('frame', '#f4f1ea'), P.add('rail', '#e9e6df'), P.add('base', '#8f8a82')
    lit = P.add('lit', '#ffd98a', 'emit')
    D = 24
    H = floors * 6 + 2
    m = M(length, D + 2, H + 10)
    m.box(0, length - 1, 1, D, 0, H, w)
    m.box(0, length - 1, 1, D, 0, 1, base)
    # stairwell bays
    for xs in range(length // 4, length - 4, length // 2):
        m.box(xs, xs + 5, 0, 0, 2, H, w2)
    _windows(m, '-y', 2, length - 2, 4, H - 1, 6, 3, 3, 2, glass, frame, y=1)
    _windows(m, '+y', 2, length - 2, 4, H - 1, 6, 3, 3, 2, glass, frame, y=D)
    _windows(m, '-x', 3, D - 2, 4, H - 1, 6, 2, 3, 3, glass, y=None, x=0)
    _windows(m, '+x', 3, D - 2, 4, H - 1, 6, 2, 3, 3, glass, y=None, x=length - 1)
    # balconies on the front facade
    for zf in range(6, H - 2, 6):
        for xa in range(3, length - 6, 10):
            m.box(xa, xa + 6, 0, 0, zf - 1, zf, rail)
    # a few lit windows
    for _ in range(length // 6):
        xa = rng.randrange(2, length - 4)
        zf = rng.randrange(4, H - 4)
        if m.v[xa, 1, zf] == glass:
            m.v[xa, 1, zf] = lit
    # gable roof along X
    for k in range(9):
        y0, y1 = 0 + k * 1, D + 1 - k * 1
        if y0 > y1:
            break
        m.box(-1 + 0, length - 1, y0, y1, H + 1 + k, H + 1 + k, roof if k % 2 == 0 else roof2)
    zt = H + 1 + min(8, D // 2)
    m.box(0, length - 1, D // 2, D // 2 + 1, zt, zt, ridge)
    return (name, [part(shell(m))], P, {'voxelSize': 0.5, 'label': 'Red-roof residential', 'group': 'buildings',
                                 'footprint': [length * 0.5, (D + 2) * 0.5]})


def _shade(hexc, k):
    h = hexc.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return '#%02x%02x%02x' % (int(r * k), int(g * k), int(b * k))


def tower_resi(name, floors, wall, accent, seed):
    rng = random.Random(seed)
    P = Palette()
    w, w2 = P.add('wall', wall), P.add('wall2', _shade(wall, 0.88))
    glass, acc, base, lit = P.add('glass', '#56738f'), P.add('accent', accent), P.add('base', '#8b8780'), P.add('lit', '#ffd98a', 'emit')
    W, D = 40, 30
    H = floors * 6
    m = M(W, D, H + 12)
    m.box(0, W - 1, 0, D - 1, 0, H, w)
    # recessed corner bays
    m.box(0, 3, 0, 3, 4, H, 0)
    m.box(W - 4, W - 1, 0, 3, 4, H, 0)
    m.box(0, W - 1, 0, D - 1, 0, 3, base)
    for face, y, x in (('-y', 0, None), ('+y', D - 1, None)):
        _windows(m, face, 5, W - 5, 6, H - 2, 6, 3, 3, 2, glass, y=y)
    for face, x in (('-x', 0), ('+x', W - 1)):
        _windows(m, face, 5, D - 5, 6, H - 2, 6, 3, 3, 2, glass, x=x)
    for zf in range(6, H, 12):
        m.box(0, W - 1, 0, 0, zf - 1, zf - 1, w2)
    # crown
    m.box(4, W - 5, 4, D - 5, H + 1, H + 6, acc)
    m.box(10, W - 11, 10, D - 11, H + 7, H + 11, w2)
    for _ in range(floors):
        x, z = rng.randrange(5, W - 5), rng.randrange(6, H - 2)
        if m.v[x, 0, z] == glass:
            m.v[x, 0, z] = lit
    return (name, [part(shell(m))], P, {'voxelSize': 0.5, 'label': 'Residential tower', 'group': 'buildings',
                                 'footprint': [W * 0.5, D * 0.5]})


def office_glass(name, height, glass_hex, seed):
    rng = random.Random(seed)
    P = Palette()
    g1, g2, fin, top, lit = (P.add('glass', glass_hex), P.add('glass2', _shade(glass_hex, 0.8)),
                             P.add('fin', '#cfd6dd'), P.add('top', '#2c3a48'), P.add('lit', '#cfe7ff', 'emit'))
    W = 44
    m = M(W, W, height)
    m.box(0, W - 1, 0, W - 1, 0, height - 1, g1)
    for k in range(0, W, 4):                 # vertical fins
        m.box(k, k, 0, 0, 0, height - 1, fin)
        m.box(k, k, W - 1, W - 1, 0, height - 1, fin)
        m.box(0, 0, k, k, 0, height - 1, fin)
        m.box(W - 1, W - 1, k, k, 0, height - 1, fin)
    for z in range(0, height, 8):            # floor bands
        m.box(0, W - 1, 0, W - 1, z, z, g2)
    # stepped crown
    m.box(0, W - 1, 0, W - 1, height - 14, height - 1, 0)
    m.box(4, W - 5, 4, W - 5, height - 14, height - 6, g1)
    m.box(10, W - 11, 10, W - 11, height - 6, height - 1, top)
    for _ in range(height):
        x, z = rng.randrange(1, W - 1), rng.randrange(2, height - 16)
        if m.v[x, 0, z] == g1:
            m.v[x, 0, z] = lit
    return (name, [part(shell(m))], P, {'voxelSize': 0.5, 'label': 'Glass office tower', 'group': 'buildings',
                                 'footprint': [W * 0.5, W * 0.5]})


def shops(name, wall, awning, seed):
    rng = random.Random(seed)
    P = Palette()
    w, glass, aw, aw2, sign, base, lit = (P.add('wall', wall), P.add('glass', '#7fb2cc', 'glass'), P.add('awning', awning),
                                          P.add('awning2', '#f4f1ea'), P.add('sign', '#e8403a', 'emit'), P.add('base', '#6c6862'),
                                          P.add('lit', '#ffe2a0', 'emit'))
    L, D, H = 60, 24, 26
    m = M(L, D + 4, H + 2)
    m.box(0, L - 1, 4, D + 3, 0, H, w)
    m.box(0, L - 1, 4, 4, 0, 6, glass)
    for x in range(0, L, 12):
        m.box(x, x, 4, 4, 0, 7, base)
    for x in range(0, L):
        m.box(x, x, 1, 3, 7, 7, aw if (x // 2) % 2 == 0 else aw2)
    for x0 in range(2, L - 10, 12):
        m.box(x0, x0 + 8, 3, 3, 8, 9, sign if rng.random() < 0.6 else lit)
    _windows(m, '-y', 2, L - 2, 12, H - 2, 6, 3, 3, 2, P['glass'], y=4)
    m.box(0, L - 1, 4, D + 3, H + 1, H + 1, base)
    return (name, [part(shell(m), t=(0, 0, (H + 2) // 2))], P, {'voxelSize': 0.5, 'label': 'Shop row', 'group': 'buildings',
                                                         'footprint': [L * 0.5, (D + 4) * 0.5]})


def buildings():
    return [
        resi_redroof('resi_redroof_a', 80, 6, '#efe2cf', 1),
        resi_redroof('resi_redroof_b', 64, 5, '#f2d9cf', 2),
        resi_redroof('resi_redroof_c', 96, 6, '#e9dcc2', 3),
        resi_redroof('resi_redroof_d', 72, 7, '#f4e9dc', 4),
        tower_resi('tower_resi_a', 26, '#eef0f2', '#8aa0b8', 5),
        tower_resi('tower_resi_b', 32, '#e6e3dc', '#b46a52', 6),
        tower_resi('tower_resi_c', 22, '#f2efe8', '#5f8f8a', 7),
        office_glass('office_glass_a', 220, '#3f6a93', 8),
        office_glass('office_glass_b', 180, '#5a7f9a', 9),
        office_glass('office_glass_c', 250, '#2f4f73', 10),
        shops('shops_a', '#e8d2b0', '#2f8a5a', 11),
        shops('shops_b', '#d8dde3', '#c8402f', 12),
    ]


def av_kit():
    """Roof sensor kit for the ego AV (same 0.075 m voxels as the cars).
    The 'lidar' part is separate so the simulator can spin it."""
    P = Palette()
    black, dark, white = P.add('black', '#16181b'), P.add('dark', '#2b2f35'), P.add('white', '#eef0f2')
    lens, band, led = P.add('lens', '#0b0f14'), P.add('band', '#3d5d80'), P.add('led', '#4fd1ff', 'emit')
    rack = M(18, 12, 3)
    rack.box(0, 17, 1, 1, 0, 0, black)
    rack.box(0, 17, 10, 10, 0, 0, black)
    rack.box(0, 0, 1, 10, 0, 0, black)
    rack.box(17, 17, 1, 10, 0, 0, black)
    for x0 in (0, 15):
        for y0 in (0, 9):
            rack.box(x0, x0 + 2, y0, y0 + 2, 1, 2, white)
            rack.set(x0 + (0 if x0 == 0 else 2), y0 + 1, 2, lens)
            rack.set(x0 + 1, y0 + (0 if y0 == 0 else 2), 2, lens)
    rack.box(6, 11, 0, 1, 1, 2, white)            # forward camera bar
    rack.box(7, 10, 0, 0, 1, 1, lens)
    rack.box(8, 9, 5, 6, 1, 2, dark)               # lidar pedestal
    lidar = M(8, 8, 6)
    lidar.cyl_z(4, 4, 3.7, 0, 4, dark)
    lidar.cyl_z(4, 4, 3.7, 2, 3, band)
    lidar.cyl_z(4, 4, 2.6, 5, 5, black)
    lidar.set(4, 0, 2, led)
    lidar.set(3, 0, 2, led)
    parts = [{'name': 'rack', 'grid': rack.v, 't': (0, 0, 1)},
             {'name': 'lidar', 'grid': lidar.v, 't': (0, 0, 3 + 3)}]
    return [('av_kit', parts, P, {'voxelSize': 0.075, 'label': 'AV sensor kit', 'group': 'props'})]


BUILDERS = [street_lights, signals, roadwork, furniture, gantry, trees, piers, buildings, av_kit]
