"""
Car sculpting kit.

A car is modelled in a dense grid indexed [x, y, z]:
  x : lateral, 0..W-1 (car's right side is low x, left side is high x)
  y : longitudinal, 0 = front bumper .. L-1 = rear bumper (cars face -Y)
  z : up, 0 = ground

Shapes are built from per-y profiles (side view) and half-widths (plan view),
then painted with boolean masks. Wheels are exported as separate MagicaVoxel parts
(wheel_FL, wheel_FR, wheel_RL, wheel_RR) so the simulator can spin them.
"""
import math

import numpy as np

from voxlib import lerp_curve

BODY, CABIN, TRIM, INTERIOR = 1, 2, 3, 4


def curve(*pts):
    return lerp_curve(list(pts))


class Car:
    def __init__(self, name, W, L, H, pal, voxel_size=0.075):
        assert W % 2 == 0, 'use an even width so the car is symmetric about x = W/2'
        self.name, self.W, self.L, self.H = name, W, L, H
        self.pal = pal
        self.vs = voxel_size
        self.v = np.zeros((W, L, H), np.uint8)
        self.part = np.zeros((W, L, H), np.uint8)
        self.cx = (W - 1) / 2.0
        X, Y, Z = np.meshgrid(np.arange(W), np.arange(L), np.arange(H), indexing='ij')
        self.X, self.Y, self.Z = X, Y, Z
        self.DX = np.abs(X - self.cx)          # 0.5, 1.5, ... from the centre line
        self.wheel_parts = []
        self.extra_parts = []
        self.meta = {}

    # ------------------------------------------------------------------ shaping
    def fill(self, hw, zlo, zhi, color, part=BODY, y0=0, y1=None, dx_min=-1.0,
             top_inset=(), bot_inset=(), only_empty=False):
        """Fill, for every y in [y0, y1], the voxels with zlo(y) <= z <= zhi(y) and
        dx < hw(y, z). `top_inset=(2, 1)` shrinks the top layer by 2 and the next by 1
        on each side (rounded shoulders); `bot_inset` does the same from the bottom."""
        y1 = self.L - 1 if y1 is None else y1
        dxs = self.DX[:, 0, 0]
        two_arg = hw.__code__.co_argcount >= 2 if hasattr(hw, '__code__') else False
        for y in range(max(0, y0), min(self.L - 1, y1) + 1):
            lo, hi = zlo(y), zhi(y)
            zl, zh = int(math.floor(lo + 0.5)), int(math.floor(hi + 0.5))
            ti = top_inset(y) if callable(top_inset) else top_inset
            bi = bot_inset(y) if callable(bot_inset) else bot_inset
            for z in range(max(0, zl), min(self.H - 1, zh) + 1):
                w = hw(y, z) if two_arg else hw(y)
                k = zh - z
                if k < len(ti):
                    w -= ti[k]
                k = z - zl
                if k < len(bi):
                    w -= bi[k]
                m = (dxs < w) & (dxs >= dx_min)
                if only_empty:
                    m &= self.v[:, y, z] == 0
                self.v[m, y, z] = color
                self.part[m, y, z] = part

    def box(self, x0, x1, y0, y1, z0, z1, color, part=TRIM, mirror=True, only_filled=False):
        """Inclusive box in grid coords; mirrored across the centre line by default."""
        def put(a0, a1):
            xs = slice(max(0, min(a0, a1)), min(self.W - 1, max(a0, a1)) + 1)
            ys = slice(max(0, y0), min(self.L - 1, y1) + 1)
            zs = slice(max(0, z0), min(self.H - 1, z1) + 1)
            if only_filled:
                sub = self.v[xs, ys, zs]
                m = sub > 0
                sub[m] = color
                self.part[xs, ys, zs][m] = part
            else:
                self.v[xs, ys, zs] = color
                self.part[xs, ys, zs] = part
        put(x0, x1)
        if mirror:
            put(self.W - 1 - x0, self.W - 1 - x1)

    def sbox(self, dx0, dx1, y0, y1, z0, z1, color, part=TRIM, only_filled=False):
        """Symmetric box by distance from the centre line (dx is 0-based voxel index
        from the centre: 0 = the two centre columns)."""
        a0 = int(self.W // 2 + dx0)
        a1 = int(self.W // 2 + dx1)
        self.box(a0, a1, y0, y1, z0, z1, color, part, mirror=True, only_filled=only_filled)

    def clear(self, cond):
        m = cond & (self.v > 0)
        self.v[m] = 0
        self.part[m] = 0

    # ----------------------------------------------------------------- masks
    def filled(self):
        return self.v > 0

    def empty_nb(self, axis, step):
        f = self.v > 0
        sh = np.zeros_like(f)
        idx_src = [slice(None)] * 3
        idx_dst = [slice(None)] * 3
        if step > 0:
            idx_dst[axis] = slice(0, -1)
            idx_src[axis] = slice(1, None)
        else:
            idx_dst[axis] = slice(1, None)
            idx_src[axis] = slice(0, -1)
        sh[tuple(idx_dst)] = f[tuple(idx_src)]
        return f & ~sh

    def exposed(self, face):
        if face == 'top':
            return self.empty_nb(2, 1)
        if face == 'bottom':
            return self.empty_nb(2, -1)
        if face == 'front':
            return self.empty_nb(1, -1)
        if face == 'rear':
            return self.empty_nb(1, 1)
        if face == 'side':
            right = self.empty_nb(0, -1) & (self.X < self.cx)
            left = self.empty_nb(0, 1) & (self.X > self.cx)
            return right | left
        raise ValueError(face)

    def surface(self):
        m = np.zeros_like(self.v, dtype=bool)
        for a in range(3):
            m |= self.empty_nb(a, 1) | self.empty_nb(a, -1)
        return m

    def paint(self, cond, color, part=None, surface=False, face=None, only=None, keep=None):
        m = cond & (self.v > 0)
        if part is not None:
            m &= np.isin(self.part, part if isinstance(part, (list, tuple)) else [part])
        if only is not None:
            m &= np.isin(self.v, only if isinstance(only, (list, tuple)) else [only])
        if keep is not None:
            m &= ~np.isin(self.v, keep if isinstance(keep, (list, tuple)) else [keep])
        if surface:
            m &= self.surface()
        if face is not None:
            faces = face if isinstance(face, (list, tuple)) else [face]
            fm = np.zeros_like(m)
            for f in faces:
                fm |= self.exposed(f)
            m &= fm
        self.v[m] = color
        return m

    # --------------------------------------------------------------- cabin
    def hollow(self, part=CABIN, floor_z=None, inset=1.5, y0=None, y1=None):
        """Remove interior voxels of the cabin so glass is see-through, and optionally
        dig the passenger compartment down into the body to `floor_z`."""
        cab = self.part == part
        sur = self.surface()
        self.clear(cab & ~sur)
        if floor_z is not None:
            ys = (self.Y >= y0) & (self.Y <= y1)
            # inner width follows the cabin base at each y
            for y in range(y0, y1 + 1):
                col = (self.part[:, y, :] == part)
                if not col.any():
                    continue
                zs = np.nonzero(col.any(axis=0))[0]
                zb = zs.min()
                xs = np.nonzero(col[:, zb])[0]
                if len(xs) == 0:
                    continue
                half = (xs.max() - xs.min() + 1) / 2.0 - inset
                m = (self.DX[:, y, :] < half) & (self.Z[:, y, :] >= floor_z) & (self.Z[:, y, :] < zb + 1)
                self.v[:, y, :][m] = 0
                self.part[:, y, :][m] = 0

    # ---------------------------------------------------------------- wheels
    def arch(self, y_axle, z_axle, r_cut, dx_in, well_color, depth=2):
        """Cut a wheel opening (outboard of dx_in) and darken the wheel-well wall."""
        dy = self.Y + 0.5 - y_axle
        dz = self.Z + 0.5 - z_axle
        r = np.sqrt(dy * dy + dz * dz)
        self.clear((r <= r_cut) & (self.DX >= dx_in) & (dz > -r_cut - 1))
        well = (r <= r_cut + 0.6) & (self.DX < dx_in) & (self.DX >= dx_in - depth)
        self.paint(well, well_color)
        # also open the bottom of the well under the cut so the tyre clears the body
        self.clear((np.abs(dy) <= r_cut - 0.5) & (dz < 0) & (self.DX >= dx_in))

    def wheel(self, y_axle, z_axle, R, width, x_out, rim_fn, tire, name_y='F'):
        """Add a mirrored pair of wheel parts.

        y_axle, z_axle: axle position in grid boundary coordinates (integers).
        x_out: distance of the tyre's outer face from the centre line (integer).
        rim_fn(py, pz, from_outer, r, ang, R) -> colour index or None (= tyre).
        """
        D = 2 * R
        for side, suffix in ((1, 'L'), (-1, 'R')):
            g = np.zeros((width, D, D), np.uint8)
            for j in range(D):
                for k in range(D):
                    py, pz = j + 0.5 - R, k + 0.5 - R
                    rr = math.hypot(py, pz)
                    if rr > R - 0.15:
                        continue
                    ang = math.atan2(pz, py)
                    for i in range(width):
                        from_outer = (width - 1 - i) if side == 1 else i
                        c = rim_fn(py, pz, from_outer, rr, ang, R)
                        g[i, j, k] = c if c else tire
            if side == 1:
                x_start = self.W // 2 + x_out - width
            else:
                x_start = self.W // 2 - x_out
            t = (x_start - self.W // 2 + width // 2, y_axle - self.L // 2, z_axle)
            self.wheel_parts.append({'name': 'wheel_%s%s' % (name_y, suffix), 'grid': g, 't': t})

    # ---------------------------------------------------------------- export
    def parts(self):
        body = {'name': 'body', 'grid': self.v, 't': (0, 0, self.H // 2)}
        return [body] + self.wheel_parts + self.extra_parts

    def roof_height(self):
        zs = np.nonzero(self.v.any(axis=(0, 1)))[0]
        return int(zs.max()) + 1


# ------------------------------------------------------------------ wheel designs

def wheel_design(rim, recess, style='spokes', n=5, lip=None, cap=None, tire_t=1.6,
                 spoke_w=0.6, hub_r=1.3, caliper=None):
    """Returns rim_fn(py, pz, from_outer, r, ang, R) -> colour or None (tyre).

    style 'spokes': N spokes on the outer face, recessed gaps between them.
    style 'holes' : solid dish with N round-ish holes (80s style).
    style 'mesh'  : fine multi-spoke (2N thin spokes).
    """
    def f(py, pz, from_outer, r, ang, R):
        if r > R - tire_t:
            return None
        inner_r = R - tire_t
        if from_outer == 0:
            if lip and r > inner_r - 0.85:
                return lip
            if cap and r < hub_r:
                return cap
            if style == 'holes':
                a = (ang * n / (2 * math.pi) + 0.5) % 1.0
                rr = inner_r * 0.55
                hole = abs(r - rr) < inner_r * 0.28 and min(a, 1 - a) < 0.2
                return recess if hole else rim
            k = n * 2 if style == 'mesh' else n
            a = (ang * k / (2 * math.pi)) % 1.0
            arc = min(a, 1 - a) * (2 * math.pi * max(r, 0.8) / k)
            if r < hub_r + 0.5 or arc < spoke_w:
                return rim
            return recess
        if from_outer == 1:
            if caliper and r > inner_r - 1.6 and r < inner_r - 0.4 and 0.4 < ang < 1.6:
                return caliper
            return recess
        return recess
    return f
