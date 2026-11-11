"""
Voxel cars, modelled after the reference renders in /cars_design.

Each builder returns a Car (see carkit.py). Scale: 1 voxel = 0.075 m, so a
58-voxel car is ~4.35 m long. All cars face -Y (front bumper at y = 0).
"""
import math

import numpy as np

from carkit import BODY, CABIN, INTERIOR, TRIM, Car, curve, wheel_design
from voxlib import Palette

REF = '/cars_design/'


def lin_hw(base, top, z0, z1):
    """Cabin half-width that tapers linearly from `base` at z0 to `top` at z1."""
    def f(y, z):
        t = 0.0 if z1 == z0 else (z - z0) / float(z1 - z0)
        return base + (top - base) * min(1.0, max(0.0, t))
    return f


def seats(car, y_front, y_back, z_floor, dx0, dx1, cushion, back, color_c, color_b=None):
    """Two front seats: cushion slab + seat back, mirrored."""
    color_b = color_b or color_c
    car.sbox(dx0, dx1, y_front, y_back, z_floor, z_floor + cushion - 1, color_c, part=INTERIOR)
    car.sbox(dx0, dx1, y_back - 1, y_back, z_floor, z_floor + back - 1, color_b, part=INTERIOR)


# =============================================================================
# 1. Retro panda coupe (white / black 80s hatchback, ref 3ECE4B01)
# =============================================================================

def retro_panda_coupe():
    P = Palette()
    white = P.add('white', '#eef1f6')
    black = P.add('black', '#17191d')
    deep = P.add('deep', '#0c0d10')
    glass = P.add('glass', '#10141a', 'glass')
    amber = P.add('amber', '#e37a12')
    tail = P.add('tail', '#e2262c', 'emit+brake')
    tail_d = P.add('tail_dark', '#8f1218', 'emit+brake')
    fog = P.add('fog', '#e9b511', 'emit+head')
    grey = P.add('grey', '#9ea2a8')
    lgrey = P.add('lgrey', '#c4c8ce')
    seat = P.add('seat', '#2c2d33')
    tire = P.add('tire', '#141518')
    rim = P.add('rim', '#202228')
    hole = P.add('hole', '#08090b')

    W, L, H = 26, 56, 20
    c = Car('retro_panda_coupe', W, L, H, P)

    # ---- body: bonnet that climbs to the cowl in terraces, flat beltline, short rear deck
    hw = curve((0, 10.8), (1, 11.6), (3, 12), (52, 12), (54, 11.6), (55, 11.2))
    deck = curve((10, 11), (47, 11), (48, 12), (55, 12))

    def zhi(y):
        return 8 if y <= 2 else 9 if y <= 5 else 10 if y <= 9 else deck(y)
    c.fill(hw, curve((0, 2), (55, 2)), zhi, white, top_inset=(2, 1))
    # the nose sits a voxel behind a wrap-round bumper, with the air dam tucked in underneath
    c.clear((c.Y == 0) & ((c.Z >= 6) | (c.Z == 2)))
    c.fill(lambda y: 11.6, lambda y: 3, lambda y: 5, white, y0=0, y1=1, top_inset=(1,))

    # ---- greenhouse: raked windshield, short roof plateau, liftback glass that runs down to the tail
    roof = curve((15, 11.6), (24, 19), (31, 19), (53, 13))
    c.fill(lin_hw(11, 10, 12, 19), lambda y: zhi(y) + 1, roof, white, part=CABIN,
           y0=15, y1=53, top_inset=(2,))

    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 19), white)                                   # roof plateau
    edge = cab & c.exposed('side')
    c.paint(edge & (Y <= 23), white)                                  # A-pillars
    c.paint(edge & (Y >= 29) & (Y <= 30), white)                      # B-pillars
    c.paint(edge & (Y + 1.6 * Z >= 68.8), white)                      # C-pillars, raked like the hatch
    c.paint(cab & (Y >= 53), white, surface=True)                     # hatch lip
    c.paint(cab & (Y >= 33) & (DX >= 8), white, face='top')            # sail panels frame the hatch glass

    # ---- panda split: black lower body, white stripe, black molding
    c.paint(Z <= 5, black, part=BODY)
    c.paint((Z == 6) & (Y > 42), black, part=BODY)
    c.paint((Z == 7) & (Y <= 44), black, part=BODY, face='side')       # molding line from the nose back
    c.paint((Y <= 15) & (DX < 10.5), black, part=BODY, face='top')     # black hood
    c.paint((Y <= 2) & (Z >= 2), black, part=BODY, face='front')
    c.paint((Y >= 53) & (Z >= 8) & (Z <= 11), black, part=BODY, face='rear')
    c.paint((Y >= 53) & (Z == 6), white, part=BODY)

    # ---- front details
    c.sbox(0, 11, 0, 0, 4, 4, deep, only_filled=True)    # bumper rub strip
    c.sbox(9, 10, 1, 1, 6, 6, amber, only_filled=True)   # turn signals ...
    c.sbox(11, 11, 1, 2, 6, 6, white, only_filled=True)  # ... beside the white stripe that wraps round from the sides
    c.sbox(8, 9, 1, 1, 8, 8, amber, only_filled=True)    # corner lamps on the bonnet edge
    c.box(12, 13, 1, 1, 6, 6, grey, mirror=False)        # badge
    c.sbox(4, 5, 0, 1, 1, 2, fog)                        # fog lamps hanging under the bumper

    # ---- rear details
    c.sbox(7, 9, 55, 55, 9, 10, tail)                  # square tail lamps out at the corners
    c.sbox(8, 8, 55, 55, 9, 10, tail_d)
    c.sbox(10, 11, 55, 55, 9, 10, amber)
    c.sbox(11, 11, 53, 54, 9, 10, amber)
    c.box(12, 13, 55, 55, 11, 11, grey, mirror=False)  # plate light
    c.box(5, 6, 55, 55, 2, 2, lgrey, mirror=False)     # exhaust tip
    c.sbox(11, 11, 43, 44, 6, 6, lgrey, only_filled=True)  # side marker

    c.sbox(12, 12, 17, 18, 12, 13, black)              # mirrors

    for ya in (11, 45):
        c.arch(ya, 5, 5.6, 8.0, deep)
    c.hollow(CABIN, floor_z=6, y0=18, y1=44)
    seats(c, 25, 31, 6, 1, 4, 3, 10, seat)
    c.sbox(0, 9, 17, 18, 10, 11, black, part=INTERIOR)   # dashboard
    design = wheel_design(rim, hole, style='holes', n=4, tire_t=1.5, hub_r=1.1)
    c.wheel(11, 5, 5, 4, 12, design, tire, 'F')
    c.wheel(45, 5, 5, 4, 12, design, tire, 'R')

    c.meta = {'label': 'Retro panda coupe', 'ref': REF + '3ECE4B01-5428-4DFB-91A3-D72CDAF1544D.jpeg', 'refView': [42, 24]}
    return c



def plus(c, dx, y, z, color, size=3):
    """Round-ish lamp: a 3x3 plus (or 2x2 block) on a face at grid row y, mirrored."""
    if size == 3:
        c.sbox(dx - 1, dx + 1, y, y, z, z, color)
        c.sbox(dx, dx, y, y, z - 1, z + 1, color)
    else:
        c.sbox(dx, dx + 1, y, y, z, z + 1, color)


def diag(c, dx, y0, z0, n, color, dy=1, dz=1):
    """Diagonal 2-voxel slash on the side (fender vents etc.)."""
    for k in range(n):
        c.sbox(dx, dx, y0 + k * dy, y0 + k * dy + 1, z0 + k * dz, z0 + k * dz, color, only_filled=True)


# =============================================================================
# 2. Classic red wing (low wedge supercar with an integrated wing, ref 31801029)
# =============================================================================

def classic_red_wing():
    P = Palette()
    red = P.add('red', '#9e2227')
    dgrey = P.add('dgrey', '#3a3b40')
    black = P.add('black', '#1b1c20')
    glass = P.add('glass', '#141920', 'glass')
    lamp = P.add('lamp', '#e9ebef', 'emit+head')
    lamp2 = P.add('lamp_rim', '#c3c6cc')
    brow = P.add('brow', '#3b1214')
    yellow = P.add('yellow', '#e6b81c')
    tail = P.add('tail', '#ff3b47', 'emit+brake')
    amber = P.add('tail_amber', '#ffa31a', 'emit+brake')
    awhite = P.add('tail_core', '#fff4d6', 'emit+brake')
    pink = P.add('reflector', '#f2727a')
    silver = P.add('silver', '#e2e4e8')
    seat = P.add('seat', '#7d1d22')
    tire = P.add('tire', '#1c1d21')
    rim = P.add('rim', '#3d3f45')
    recess = P.add('recess', '#16171a')

    W, L, H = 28, 56, 16
    c = Car('classic_red_wing', W, L, H, P)
    # very round nose in plan, layered bonnet rising to the windshield
    hw = curve((0, 8.5), (1, 10.5), (2, 11.6), (3, 12.3), (5, 12.8), (8, 13), (20, 13), (24, 12.5),
               (34, 12.5), (37, 13), (53, 13), (54, 12.6), (55, 12))
    zhi = curve((0, 4), (1, 5), (3, 5.6), (6, 6.2), (10, 6.8), (14, 7.4), (18, 8), (19, 9), (38, 9), (39, 10), (55, 10))
    c.fill(hw, curve((0, 2), (55, 2)), zhi, red, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((1, 5.6), (3, 6.6), (6, 7.6), (10, 8.4), (14, 8.8), (19, 9.2)), red,
           y0=1, y1=19, dx_min=8.0, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((33, 9.6), (37, 10.6), (44, 11), (52, 11), (55, 10.6)), red,
           y0=33, y1=55, dx_min=9.0, top_inset=(1,))
    c.fill(lambda y: 9.0, lambda y: 9, curve((35, 11.6), (53, 10.6)), red, y0=35, y1=53, top_inset=(1,))
    roof = curve((18, 9.6), (25, 14), (31, 14), (35, 13), (37, 11.6))
    c.fill(lin_hw(10.6, 8.8, 10, 14), lambda y: zhi(y) + 1, roof, red, part=CABIN, y0=18, y1=37, top_inset=(1,))

    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 14), red)                                          # flat red roof
    c.paint(cab & c.exposed('side') & (Y <= 24), black)                    # A-pillars
    c.paint(cab & c.exposed('side') & (Y >= 32), red)                      # sail panels
    # Lexan engine cover: dark louvres between the rear fenders
    c.paint((Y >= 36) & (Y <= 53) & (DX < 8.5) & (Y % 2 == 0), dgrey, face='top')
    c.paint((Y >= 35) & (Y <= 37) & (DX < 8.5) & (Z >= 11), glass, face='top')

    # grey belt stripe wrapping the car + grey splitter skirt
    c.paint((Z == 5) & (Y >= 3), dgrey, part=BODY, face='side')
    c.paint((Z == 5) & (Y >= 54), dgrey, part=BODY, face='rear')
    c.paint(Z == 2, dgrey, part=BODY)
    c.sbox(0, 12, 0, 1, 1, 1, dgrey)
    c.sbox(13, 13, 4, 52, 1, 2, dgrey)
    c.sbox(0, 11, 54, 55, 1, 1, dgrey)

    # nose: wide black slit over the splitter, recessed corner lamps under a dark brow
    c.sbox(0, 9, 0, 1, 3, 3, black)
    c.sbox(8, 10, 1, 2, 4, 5, lamp2, only_filled=True)
    c.sbox(8, 9, 1, 1, 4, 4, lamp)
    c.sbox(8, 11, 1, 3, 6, 6, brow, only_filled=True)
    c.box(13, 14, 2, 2, 5, 5, yellow, mirror=False)                         # bonnet badge
    c.paint((Y >= 9) & (Y <= 10) & (DX >= 3) & (DX < 5), black, part=BODY, face='top')   # NACA ducts
    # side details: fender badge, door NACA duct, quarter vent
    c.sbox(12, 12, 15, 15, 6, 7, yellow, only_filled=True)
    for k in range(3):
        c.sbox(12, 12, 27 + k, 28 + k, 7 + (k == 2), 7 + (k == 2), black, only_filled=True)
    c.sbox(12, 12, 34, 35, 6, 7, black, only_filled=True)

    # tall red rear fins rising to a thin dark wing, with daylight underneath
    for k in range(9):
        c.sbox(11, 12, 47 + k, 47 + k, 11, min(15, 11 + k // 2), red)
    c.sbox(0, 12, 52, 55, 15, 15, dgrey)
    c.sbox(0, 10, 52, 52, 14, 14, dgrey)

    # tail: black mesh between red + amber round lamps, finned diffuser
    c.sbox(0, 4, 55, 55, 6, 8, black)
    for z in (6, 8):
        c.sbox(0, 4, 55, 55, z, z, dgrey)
    plus(c, 6, 55, 7, tail)
    plus(c, 10, 55, 7, amber)
    c.sbox(10, 10, 55, 55, 7, 7, awhite)
    c.sbox(11, 11, 55, 55, 3, 3, pink)
    c.sbox(0, 0, 55, 55, 3, 3, silver)
    for k in (2, 5, 8):
        c.sbox(k, k, 53, 55, 1, 2, black)
    c.sbox(13, 13, 20, 21, 9, 10, red)                                       # mirrors

    for ya in (12, 43):
        c.arch(ya, 5, 5.6, 9.0, black)
    c.hollow(CABIN, floor_z=5, y0=21, y1=33)
    seats(c, 25, 31, 5, 1, 4, 3, 8, seat)
    design = wheel_design(rim, recess, style='spokes', n=5, cap=yellow, tire_t=1.5, spoke_w=0.7)
    c.wheel(12, 5, 5, 4, 13, design, tire, 'F')
    c.wheel(43, 5, 5, 4, 13, design, tire, 'R')
    c.meta = {'label': 'Classic red wing', 'ref': REF + '31801029-88A7-4FAC-8FCE-21278CA7EC8D.jpeg', 'refView': [40, 22]}
    return c

# =============================================================================
# 3. Hyper black / blue (wedge hypercar with big wing, ref 46FDEA09)
# =============================================================================

def hyper_black_blue():
    P = Palette()
    black = P.add('black', '#17181c')
    black2 = P.add('black2', '#0f1013')
    blue = P.add('blue', '#3d5fe4')
    white = P.add('white', '#eceef3')
    grey = P.add('grey', '#4a4c53')
    glass = P.add('glass', '#121722', 'glass')
    tail = P.add('tail', '#ff2d2d', 'emit+brake')
    head = P.add('head', '#e9ecf4', 'emit+head')
    seat = P.add('seat', '#22252c')
    tire = P.add('tire', '#16171a')
    rim = P.add('rim', '#22242a')
    recess = P.add('recess', '#0a0a0c')

    W, L, H = 30, 60, 16
    c = Car('hyper_black_blue', W, L, H, P)
    hw = curve((0, 8.6), (1, 10), (3, 11.6), (6, 13), (10, 14), (21, 14), (25, 13.2), (35, 13.2), (38, 14), (57, 14), (59, 13.2))
    zhi = curve((0, 5), (3, 5.6), (8, 6.6), (14, 7.4), (21, 8), (22, 9), (40, 9), (42, 10), (59, 10))
    c.fill(hw, curve((0, 2), (59, 2)), zhi, black, top_inset=(2, 1))
    # front fender blades stand well proud of a low bonnet (which has a raised spine) and
    # cover the tops of the front wheels
    fender = curve((1, 6), (3, 7.6), (6, 9.4), (9, 10.6), (10, 11), (16, 11), (19, 10.4), (22, 9.6))
    flare = curve((1, 10), (3, 11.6), (6, 13), (8, 14), (10, 15), (16, 15), (19, 14.4), (22, 14))
    c.fill(flare, lambda y: 3, fender, black, y0=1, y1=22, dx_min=8.0, top_inset=(1,))
    c.fill(lambda y: 8.0, lambda y: 3, lambda y: max(zhi(y), fender(y) - 1.6), black, y0=2, y1=21, dx_min=6.0)
    c.fill(lambda y: 2.0, lambda y: 3, lambda y: zhi(y) + 1, black, y0=1, y1=20, top_inset=(1,))
    c.fill(hw, lambda y: 3, curve((35, 9.6), (40, 11), (55, 11), (59, 10.6)), black, y0=35, y1=59, dx_min=10.0, top_inset=(1,))
    roof = curve((20, 9.6), (29, 14), (35, 14), (46, 10.6))
    c.fill(lin_hw(11.4, 8.4, 10, 14), lambda y: zhi(y) + 1, roof, black, part=CABIN, y0=20, y1=46, top_inset=(1,))

    Y, Z, DX = c.Y, c.Z, c.DX
    # nose: intakes under the bonnet lip either side of a centre recess with the tow hook
    c.clear((Y <= 1) & (DX >= 2) & (DX < 8) & (Z >= 2) & (Z <= 4))
    c.clear((Y == 0) & (DX < 2) & (Z >= 2) & (Z <= 3))
    cab = c.part == CABIN
    c.paint(cab & (Y <= 36), glass, surface=True)
    c.paint(cab & (Z >= 14), black)
    c.paint(cab & c.exposed('side') & (Y <= 28) & (Z >= 11), black)
    c.paint(cab & (Y >= 37) & (Y % 2 == 0) & (DX < 6), black2, face='top')

    # blue fender blades with white claw marks, blue bonnet panels beside the black spine
    c.paint((DX >= 6) & (Y <= 21) & (Z >= 6), blue, face='top', part=BODY)
    c.paint((DX >= 14), black, face='top', part=BODY)
    c.paint((DX >= 8) & (Y <= 8) & (Z >= 8), blue, face='front', part=BODY)
    for yy in (6, 9, 12):
        c.paint((DX >= 11) & (DX < 14) & (Y >= yy) & (Y <= yy + 1) & (DX < 11 + (Y - yy + 1) * 1.5), white, face='top', part=BODY)
    c.paint((DX >= 2) & (DX < 8) & (Y >= 2) & (Y <= 18), blue, face='top', part=BODY)
    for yy in (7, 12):
        c.paint((DX >= 3) & (DX < 7) & (Y == yy + (DX > 5)), black2, face='top', part=BODY)
    c.paint(cab & (DX < 1) & (Y >= 27), blue, face='top')
    c.paint((DX < 1) & (Y >= 46) & (Y <= 52), blue, face='top', part=BODY)
    c.paint((Z == 8) & (Y >= 31) & (Y <= 39), blue, face='side', part=BODY)
    c.sbox(13, 13, 32, 39, 3, 7, black2)

    # intake insides, tow hook, slim lamps on the fender fronts, splitter with end plates
    c.paint((Y == 2) & (DX >= 2) & (DX < 8) & (Z >= 2) & (Z <= 4), recess)
    c.paint((Y == 1) & (DX < 2) & (Z >= 2) & (Z <= 3), recess)
    c.box(14, 15, 1, 1, 3, 3, tail, mirror=False)
    c.paint((DX >= 8) & (DX < 11) & (Y <= 3) & (Z == 6), head, face='front')
    c.sbox(0, 12, 0, 3, 1, 1, black2)
    c.sbox(12, 12, 0, 3, 2, 2, black)

    # wing with blue edge and end plates
    c.sbox(5, 5, 54, 56, 11, 13, black2)
    c.sbox(0, 13, 53, 58, 14, 14, black)
    c.sbox(0, 13, 53, 53, 14, 14, blue)
    c.sbox(14, 14, 52, 59, 11, 15, black)
    c.sbox(14, 14, 52, 59, 15, 15, blue)

    # tail: Y lamps, centre exhaust, big diffuser
    c.paint((Y >= 58) & (Z <= 10), black2, part=BODY, face='rear')
    c.sbox(6, 12, 59, 59, 9, 9, tail)
    c.sbox(5, 6, 59, 59, 8, 8, tail)
    c.sbox(7, 11, 59, 59, 7, 7, tail)
    c.sbox(0, 2, 59, 59, 5, 6, grey)
    for k in range(3, 14, 3):
        c.sbox(k, k, 55, 59, 1, 4, black)
    c.sbox(14, 14, 20, 22, 9, 10, black)

    for ya in (13, 47):
        c.arch(ya, 5, 5.6, 10.0, black2)
    c.hollow(CABIN, floor_z=5, y0=23, y1=35)
    seats(c, 27, 33, 5, 1, 4, 3, 7, seat)
    design = wheel_design(rim, recess, style='mesh', n=7, tire_t=1.4, spoke_w=0.5)
    c.wheel(13, 5, 5, 4, 14, design, tire, 'F')
    c.wheel(47, 5, 5, 4, 14, design, tire, 'R')
    c.meta = {'label': 'Hyper black-blue', 'ref': REF + '46FDEA09-CFDC-4504-9010-B0800B2945B3_1_105_c.jpeg', 'refView': [40, 22]}
    return c


# =============================================================================
# 4. Super white / black (mid-engine canopy supercar, ref A9EBFA39)
# =============================================================================

def super_white_black():
    P = Palette()
    white = P.add('white', '#e9ebef')
    black = P.add('black', '#16171b')
    black2 = P.add('black2', '#0e0f12')
    grey = P.add('grey', '#5d6067')
    lgrey = P.add('lgrey', '#9a9ea6')
    glass = P.add('glass', '#10141a', 'glass')
    head = P.add('head', '#dfe3ea', 'emit+head')
    tail = P.add('tail', '#ff2f2f', 'emit+brake')
    seat = P.add('seat', '#2a2b30')
    tire = P.add('tire', '#16171a')
    rim = P.add('rim', '#202227')
    recess = P.add('recess', '#0a0a0c')

    W, L, H = 28, 56, 18
    c = Car('super_white_black', W, L, H, P)
    hw = curve((0, 9.4), (1, 10.8), (2, 11.8), (4, 12.6), (7, 13), (19, 13), (22, 12.5), (34, 12.5), (37, 13), (53, 13), (55, 12.2))
    zhi = curve((0, 6), (1, 7), (6, 8), (15, 8.6), (18, 9), (19, 10), (38, 10), (40, 11), (55, 11))
    c.fill(hw, curve((0, 2), (55, 2)), zhi, white, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((0, 6.6), (3, 9), (9, 10), (18, 10.2)), white, y0=0, y1=18, dx_min=7.5, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((34, 10.6), (39, 11.8), (52, 11.8), (55, 11.4)), white, y0=34, y1=55, dx_min=9.0, top_inset=(2, 1))
    roof = curve((17, 10.6), (26, 16), (33, 16), (46, 11.6))
    c.fill(lin_hw(11.2, 8.4, 11, 16), lambda y: zhi(y) + 1, roof, white, part=CABIN, y0=17, y1=46, top_inset=(2,))

    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    # dark glass all round, white roof plateau, wide white flying buttresses
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 16), white)
    side = cab & c.exposed('side')
    c.paint(side & (Y >= 33), white)
    c.paint(cab & (Y >= 34) & (DX >= 6.5), white, face='top')
    c.paint(cab & (Y >= 35) & (DX < 6.5), glass, face='top')              # glass engine cover
    c.sbox(0, 1, 30, 33, 17, 17, black)                                     # roof scoop
    # curved black bonnet section in front of the windshield
    c.paint((Y >= 10) & (Y <= 18) & (DX < (Y - 8) * 0.62), black, part=BODY, face='top')

    # black lower body all the way between the wheels, door intakes
    c.paint(Z <= 4, black, part=BODY)
    c.paint((Y >= 9) & (Y <= 47) & (Z <= 5), black, part=BODY, face='side')
    c.paint((Y >= 23) & (Y <= 38) & (Z <= 7), black, part=BODY, face='side')
    c.sbox(12, 12, 29, 37, 5, 7, black2, only_filled=True)
    # nose: eye-socket lamps, wide black lower intake, white lip
    c.sbox(8, 11, 0, 3, 6, 7, grey, only_filled=True)
    c.sbox(9, 10, 0, 1, 6, 6, head)
    c.sbox(9, 11, 0, 0, 7, 7, lgrey, only_filled=True)
    c.sbox(2, 11, 0, 0, 3, 5, black)
    c.sbox(0, 1, 0, 0, 3, 4, lgrey)
    c.sbox(0, 11, 0, 1, 2, 2, white, only_filled=True)
    c.sbox(13, 13, 19, 20, 11, 11, black)                                  # mirror stalks
    c.sbox(13, 13, 18, 21, 12, 13, white)

    # tail: black fascia with slim red corner blades, white centre strip, spoiler
    c.paint((Y >= 54) & (Z <= 9), black, part=BODY, face='rear')
    c.paint((Y >= 54) & (Z <= 9) & (DX >= 11), white, part=BODY, face='rear')
    c.sbox(5, 12, 55, 55, 9, 9, tail)
    c.sbox(12, 12, 55, 55, 7, 9, tail)
    c.sbox(11, 12, 53, 54, 9, 9, tail, only_filled=True)
    for z in (4, 6, 8):
        c.sbox(1, 9, 55, 55, z, z, black2)
    c.box(13, 14, 55, 55, 2, 5, white, mirror=False)
    for k in (2, 5, 8, 11):
        c.sbox(k, k, 53, 55, 1, 2, black2)
    c.sbox(0, 11, 53, 54, 12, 13, black)                                   # raised rear spoiler
    c.sbox(4, 4, 53, 53, 11, 11, black)

    for ya in (11, 44):
        c.arch(ya, 5, 5.6, 9.0, black2)
    c.hollow(CABIN, floor_z=5, y0=21, y1=33)
    seats(c, 25, 31, 5, 1, 4, 3, 9, seat)
    design = wheel_design(rim, recess, style='mesh', n=6, tire_t=1.4, spoke_w=0.55)
    c.wheel(11, 5, 5, 4, 13, design, tire, 'F')
    c.wheel(44, 5, 5, 4, 13, design, tire, 'R')
    c.meta = {'label': 'Super white-black', 'ref': REF + 'A9EBFA39-61BF-44B5-AFC3-6CBB7CF3A551.jpeg', 'refView': [36, 18]}
    return c

# =============================================================================
# 5. GT grey with red lip (tall big-wing GT coupe, ref C200F790)
# =============================================================================

def gt_grey_red_lip():
    P = Palette()
    grey = P.add('grey', '#7d8997')
    black = P.add('black', '#17181c')
    black2 = P.add('black2', '#0e0f12')
    red = P.add('red', '#d2232b')
    white = P.add('white', '#f1f3f6')
    lgrey = P.add('lgrey', '#b9bec6')
    glass = P.add('glass', '#11151c', 'glass')
    head = P.add('head', '#e8ecf3', 'emit+head')
    tail = P.add('tail', '#ff2b2b', 'emit+brake')
    seat = P.add('seat', '#2b2c31')
    tire = P.add('tire', '#16171a')
    rim = P.add('rim', '#1d1f23')
    recess = P.add('recess', '#0a0a0c')

    W, L, H = 28, 58, 20
    c = Car('gt_grey_red_lip', W, L, H, P)
    hw = curve((0, 10.6), (1, 11.8), (2, 12.4), (4, 12.8), (6, 13), (54, 13), (56, 12.5), (57, 11.8))
    zhi = curve((0, 9), (1, 10), (4, 10.6), (14, 11), (19, 11.6), (20, 12), (44, 12), (46, 13), (57, 13))
    c.fill(hw, curve((0, 2), (57, 2)), zhi, grey, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((0, 9.6), (3, 11.4), (10, 12), (19, 12.4)), grey, y0=0, y1=19, dx_min=8.0, top_inset=(1,))
    roof = curve((19, 12.6), (27, 18), (35, 18), (48, 13.6))
    c.fill(lin_hw(11.6, 9.6, 13, 18), lambda y: zhi(y) + 1, roof, grey, part=CABIN, y0=19, y1=48, top_inset=(2,))

    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 17), black)
    c.paint(cab & c.exposed('side') & (Y <= 26), black)
    c.paint(cab & c.exposed('side') & (Y + 0.8 * Z >= 54), grey)
    c.paint((Y >= 40) & (Y <= 43) & (DX < 9), black, part=BODY, face='top')

    # nose: big grille, side intakes with teeth, lamp housings with white DRL
    c.sbox(0, 5, 0, 0, 3, 7, black)
    c.sbox(6, 12, 0, 0, 2, 5, black)
    for k in (6, 8, 10):
        c.sbox(k, k, 0, 0, 3, 3, lgrey)
    c.sbox(8, 12, 0, 2, 8, 9, black, only_filled=True)
    c.sbox(9, 12, 0, 3, 10, 10, white, only_filled=True)
    c.sbox(10, 11, 0, 0, 8, 8, head)
    diag(c, 12, 18, 6, 4, black)

    # red lip all round, black sills
    c.paint(Z == 2, red, part=BODY, face=['side', 'front', 'rear'])
    c.paint(Z == 3, black, part=BODY, face=['side'])
    c.sbox(0, 12, 0, 1, 1, 1, red)

    # tail: quad round lamps, black lower, exhausts
    c.paint((Y >= 56) & (Z <= 8) & (Z >= 3), black, part=BODY, face='rear')
    plus(c, 4, 57, 11, tail)
    plus(c, 9, 57, 11, tail)
    c.sbox(9, 11, 57, 57, 3, 4, white)
    c.sbox(0, 2, 57, 57, 10, 10, lgrey)

    # GT wing on tall stays
    c.sbox(7, 8, 51, 53, 14, 17, black)
    c.sbox(0, 12, 49, 55, 18, 18, black)
    c.sbox(13, 13, 49, 55, 16, 18, black)
    c.sbox(13, 13, 21, 22, 13, 14, black)

    for ya in (12, 45):
        c.arch(ya, 5, 5.6, 9.0, black2)
    c.hollow(CABIN, floor_z=6, y0=22, y1=42)
    seats(c, 28, 34, 6, 1, 4, 3, 9, seat)
    design = wheel_design(rim, recess, style='mesh', n=6, tire_t=1.4, spoke_w=0.55)
    c.wheel(12, 5, 5, 4, 13, design, tire, 'F')
    c.wheel(45, 5, 5, 4, 13, design, tire, 'R')
    c.meta = {'label': 'GT grey red-lip', 'ref': REF + 'C200F790-5909-4E23-8BED-CFDEC5B066A8.jpeg', 'refView': [38, 16]}
    return c


# =============================================================================
# 6 & 7. Rear-engine sports cars: blue light-bar coupe and white GT with wing
# =============================================================================

def _rear_engine_base(name, W, H, P, body, wide=0.0):
    """Round front fenders with lamps on top, low bonnet between them, compact
    cabin and a fastback that runs down to the tail over wide rear haunches."""
    L = 54
    w = wide
    c = Car(name, W, L, H, P)
    hw = curve((0, 9.0 + w), (1, 10.2 + w), (2, 10.8 + w), (4, 11.4 + w), (7, 11.8 + w), (19, 11.8 + w),
               (23, 11.4 + w), (31, 11.4 + w), (36, 12.0 + w), (48, 12.0 + w), (51, 11.6 + w), (53, 10.8 + w))
    zhi = curve((0, 6), (1, 7), (3, 8), (10, 8.6), (16, 9.6), (17, 11), (37, 11), (53, 10.4))
    c.fill(hw, curve((0, 2), (53, 2)), zhi, body, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((0, 7), (2, 9.4), (6, 10.4), (12, 11), (16, 11.2)), body, y0=0, y1=16, dx_min=6.5, top_inset=(2, 1))
    c.fill(hw, lambda y: 3, curve((31, 11.2), (36, 12), (47, 12), (51, 11.6), (53, 11)), body, y0=31, y1=53, dx_min=7.5, top_inset=(2, 1))
    roof = curve((16, 11.6), (23, 17), (29, 17), (40, 14.2), (50, 11.6))
    c.fill(lin_hw(10.4 + w, 8.4 + w, 12, 17), lambda y: zhi(y) + 1, roof, body, part=CABIN, y0=16, y1=50, top_inset=(2,))
    return c


def sport_blue_lightbar():
    P = Palette()
    blue = P.add('blue', '#2f5fcf')
    dark = P.add('dark', '#2a2c31')
    black = P.add('black', '#15161a')
    glass = P.add('glass', '#141a24', 'glass')
    lamp = P.add('lamp', '#e6e9ee', 'emit+head')
    ring = P.add('lamp_ring', '#3a3d44')
    fog = P.add('fog', '#d7dae0')
    yellow = P.add('yellow', '#e4b51c')
    bar = P.add('lightbar', '#ff4545', 'emit+brake')
    barw = P.add('lightbar_logo', '#ffd6d6', 'emit+brake')
    silver = P.add('silver', '#c9ccd2')
    seat = P.add('seat', '#c9c3b8')
    tire = P.add('tire', '#17181b')
    rim = P.add('rim', '#2c2e33')
    recess = P.add('recess', '#121315')

    c = _rear_engine_base('sport_blue_lightbar', 26, 18, P, blue)
    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 16) & (Y <= 32), blue)
    c.paint(cab & c.exposed('side') & (Y <= 22), black)
    c.paint(cab & c.exposed('side') & (Y + 1.2 * Z >= 52), blue)
    c.paint(cab & (Y >= 42), blue, surface=True)
    for yy in (44, 46, 48):
        c.paint(cab & (Y == yy) & (DX < 6), black, face='top')

    c.paint((Z <= 3), dark, part=BODY)
    c.paint((Y <= 1) & (Z <= 4), dark, part=BODY)
    c.paint((Y >= 52) & (Z <= 4), dark, part=BODY)
    c.sbox(0, 10, 0, 0, 2, 4, black)
    c.sbox(8, 10, 0, 0, 4, 4, fog)
    c.sbox(7, 10, 0, 3, 8, 10, ring, only_filled=True)
    c.sbox(8, 9, 0, 2, 9, 9, lamp)
    c.sbox(8, 9, 2, 2, 10, 10, lamp, only_filled=True)
    c.box(12, 13, 3, 3, 8, 8, yellow, mirror=False)
    c.paint((Y >= 52) & (Z == 9) & (DX < 11.5), bar, part=BODY, face='rear')
    c.sbox(0, 2, 53, 53, 9, 9, barw)
    c.sbox(0, 3, 53, 53, 2, 4, black)
    c.sbox(1, 2, 53, 53, 3, 3, silver)
    c.sbox(12, 12, 18, 19, 13, 13, blue)
    c.sbox(11, 11, 24, 25, 10, 10, black, only_filled=True)

    for ya in (11, 42):
        c.arch(ya, 5, 5.6, 8.0, black)
    c.hollow(CABIN, floor_z=6, y0=19, y1=36)
    seats(c, 25, 31, 6, 1, 4, 3, 9, seat)
    design = wheel_design(rim, recess, style='spokes', n=5, cap=yellow, tire_t=1.5, spoke_w=0.65)
    c.wheel(11, 5, 5, 4, 12, design, tire, 'F')
    c.wheel(42, 5, 5, 4, 12, design, tire, 'R')
    c.meta = {'label': 'Sport blue light-bar', 'ref': REF + 'D0996A50-4FF5-42CA-8AB3-09D1B6A13260.jpeg', 'refView': [38, 14]}
    return c


def gt_white_orange():
    P = Palette()
    white = P.add('white', '#f0f2f5')
    black = P.add('black', '#16171b')
    black2 = P.add('black2', '#0d0e11')
    orange = P.add('orange', '#f26b14')
    yellow = P.add('yellow', '#f2c21c')
    dgrey = P.add('lamp_housing', '#3a3d44')
    lgrey = P.add('lamp_lower', '#8f949c')
    glass = P.add('glass', '#12161d', 'glass')
    lamp = P.add('lamp', '#e9ecf1', 'emit+head')
    bar = P.add('lightbar', '#ff3d3d', 'emit+brake')
    seat = P.add('seat', '#ea6512')
    tire = P.add('tire', '#16171a')
    rim = P.add('rim', '#1c1d21')
    recess = P.add('recess', '#0b0b0d')

    c = _rear_engine_base('gt_white_orange', 28, 20, P, white, wide=1.0)
    Y, Z, DX = c.Y, c.Z, c.DX
    cab = c.part == CABIN
    c.paint(cab, glass, surface=True)
    c.paint(cab & (Z >= 16) & (Y <= 33), black)                             # black double-bubble roof
    c.paint(cab & c.exposed('side') & (Y <= 22), black)
    c.paint(cab & c.exposed('side') & (Y + 1.2 * Z >= 52), white)
    c.paint(cab & (Y >= 42), white, surface=True)
    for yy in (43, 45, 47):
        c.paint(cab & (Y == yy) & (DX < 6), black, face='top')              # engine-lid slats
    c.paint(cab & (Y == 41) & (DX >= 3) & (DX < 5), orange, face='top')     # orange lid accents

    # bonnet: twin orange vents with black slots
    c.paint((Y >= 3) & (Y <= 5) & (DX >= 1) & (DX < 4), orange, part=BODY, face='top')
    c.paint((Y == 4) & (DX >= 1.5) & (DX < 3.5), black, part=BODY, face='top')
    # front fender louvres + yellow mark at the A-pillar base
    for yy in (12, 14, 16):
        c.paint((Y == yy) & (DX >= 8.5) & (DX < 11), black, part=BODY, face='top')
    c.paint((Y >= 17) & (Y <= 18) & (DX >= 10.5) & (DX < 12), yellow, part=BODY, face='top')
    # rear fender louvres + intake box behind the side window
    for yy in (44, 46):
        c.paint((Y == yy) & (DX >= 9) & (DX < 12), black, part=BODY, face='top')
    c.sbox(10, 12, 35, 37, 11, 12, black)
    c.sbox(11, 11, 36, 36, 12, 12, black2)
    # dark lamp housings on the fender fronts
    c.sbox(8, 11, 0, 3, 8, 10, dgrey, only_filled=True)
    c.sbox(8, 11, 0, 1, 8, 8, lgrey, only_filled=True)
    c.sbox(9, 10, 0, 0, 9, 9, lamp)
    # lower front: big black intakes, orange tow strap, yellow mark, splitter
    c.paint(Z <= 3, black, part=BODY)
    c.sbox(3, 11, 0, 0, 2, 5, black2)
    c.sbox(0, 2, 0, 0, 2, 3, black2)
    c.box(10, 11, 0, 0, 2, 3, orange, mirror=False)
    c.box(9, 12, 0, 0, 3, 3, orange, mirror=False)
    c.box(20, 20, 0, 0, 6, 6, yellow, mirror=False)
    c.sbox(0, 12, 0, 1, 1, 1, black)
    c.sbox(12, 12, 32, 35, 8, 10, black2, only_filled=True)                 # side intake
    c.paint((Y >= 52) & (Z <= 6), black, part=BODY)
    c.paint((Y >= 52) & (Z == 9) & (DX < 12.5), bar, part=BODY, face='rear')
    # mirrors: white heads on black stalks
    c.sbox(12, 13, 20, 20, 11, 11, black)
    c.sbox(13, 13, 19, 21, 12, 13, white)

    # tall swan-neck wing, black, with orange end plates
    c.sbox(4, 5, 47, 50, 12, 16, black)
    c.sbox(0, 12, 47, 51, 17, 17, black)
    c.sbox(0, 12, 47, 47, 16, 16, black)
    c.sbox(13, 13, 47, 51, 15, 18, orange)

    for ya in (11, 42):
        c.arch(ya, 5, 5.6, 9.0, black2)
    c.hollow(CABIN, floor_z=6, y0=19, y1=36)
    seats(c, 25, 31, 6, 1, 4, 3, 9, seat)
    design = wheel_design(rim, recess, style='spokes', n=10, lip=orange, cap=black, tire_t=1.3, spoke_w=0.45)
    c.wheel(11, 5, 5, 4, 13, design, tire, 'F')
    c.wheel(42, 5, 5, 4, 13, design, tire, 'R')
    c.meta = {'label': 'GT white-orange', 'ref': REF + '228AFA34-0D0D-42BF-96B1-F09395B3E7DB.jpeg', 'refView': [34, 28]}
    return c

BUILDERS = [gt_white_orange, classic_red_wing, retro_panda_coupe, hyper_black_blue,
            super_white_black, gt_grey_red_lip, sport_blue_lightbar]


# =============================================================================
# Open-wheel single-seaters ("formula" cars): one shared shape, six colour schemes.
# The shape follows the usual breakdown: front wing, nose, monocoque with a halo,
# sidepods, engine cover with an airbox, floor, rear wing. No headlamps; the red
# rain light at the back doubles as the brake light.
# =============================================================================

def _formula(name, label, main, paint, helmet='#f2f2f2', wheel=None, cam='#141518'):
    wheel = wheel or {}
    P = Palette()
    body = P.add('body', main)
    carbon = P.add('carbon', '#141518')
    dark = P.add('dark', '#08090b')
    rain = P.add('rain', '#ff2a2a', 'emit+brake')
    helm = P.add('helmet', helmet)
    visor = P.add('visor', '#0d1016')
    tire = P.add('tire', '#111214')
    cover = P.add('cover', wheel.get('cover', '#1d1f24'))
    rings = [P.add('ring%d' % k, col) for k, col in enumerate(wheel.get('ring', []))]
    dot = P.add('dot', wheel['dot']) if wheel.get('dot') else None
    camc = P.add('cam', cam)

    W, L, H = 26, 68, 16
    c = Car(name, W, L, H, P)

    # floor
    c.fill(curve((16, 4), (22, 10.5), (48, 10.5), (51, 6.5), (58, 6)), lambda y: 1, lambda y: 1, carbon, y0=16, y1=58)
    # nose and monocoque
    c.fill(curve((2, 1.5), (10, 2.2), (16, 3.2), (24, 5), (30, 5.5)),
           curve((2, 3), (8, 3), (14, 2), (30, 2)),
           curve((2, 3.6), (8, 5), (14, 6.4), (20, 7.4), (30, 7.6)), body, y0=2, y1=30, top_inset=(1,))
    # sidepods, tapering in towards the rear wheels
    c.fill(curve((26, 10.5), (40, 10.5), (46, 8), (52, 4.5)), lambda y: 2,
           curve((26, 7), (34, 7), (44, 5.6), (52, 4)), body, y0=26, y1=52, top_inset=(1,))
    # engine cover with the airbox behind the driver's head
    c.fill(curve((30, 3.2), (40, 2.6), (50, 1.6), (58, 1.2)), lambda y: 2,
           curve((30, 7.6), (32, 12.4), (35, 13), (44, 10.6), (52, 8), (58, 5.5)), body, y0=30, y1=58, top_inset=(1,))
    # gearbox and rear crash structure
    c.fill(lambda y: 1.5, lambda y: 2, lambda y: 5, carbon, y0=58, y1=65)

    Y, Z, DX = c.Y, c.Z, c.DX
    # cockpit, driver and halo
    c.clear((Y >= 24) & (Y <= 30) & (DX < 2) & (Z >= 6))
    c.sbox(0, 0, 27, 29, 6, 9, helm)
    c.sbox(0, 0, 27, 27, 8, 8, visor)
    c.sbox(2, 2, 25, 31, 9, 9, carbon)
    c.sbox(0, 2, 24, 24, 9, 9, carbon)
    c.sbox(0, 0, 23, 23, 8, 9, carbon)
    c.sbox(4, 5, 24, 24, 8, 8, carbon)                    # mirrors
    c.paint((Y == 26) & (DX >= 5.5) & (Z >= 3) & (Z <= 5), dark)   # sidepod intakes
    c.paint((Y >= 31) & (Y <= 32) & (Z >= 10) & (Z <= 11) & (DX < 1), dark, face='front')  # airbox intake

    # front wing: two elements, end plates, pylons under the nose
    c.sbox(0, 12, 1, 5, 1, 1, carbon)
    c.sbox(3, 12, 3, 5, 2, 2, carbon)
    c.sbox(12, 12, 1, 6, 1, 4, carbon)
    c.sbox(0, 1, 2, 5, 2, 2, carbon)
    # suspension arms
    c.sbox(3, 7, 11, 11, 6, 6, carbon)
    c.sbox(3, 7, 13, 13, 4, 4, carbon)
    c.sbox(2, 6, 56, 56, 6, 6, carbon)
    c.sbox(2, 6, 58, 58, 4, 4, carbon)
    # rear wing between the wheels, on a centre pylon, with a beam wing and diffuser
    c.sbox(6, 6, 60, 67, 5, 12, carbon)
    c.sbox(0, 6, 61, 65, 11, 11, carbon)
    c.sbox(0, 6, 64, 67, 12, 12, carbon)
    c.sbox(0, 0, 60, 62, 6, 10, carbon)
    c.sbox(0, 5, 63, 66, 6, 6, carbon)
    c.sbox(0, 5, 59, 64, 1, 2, dark)
    c.sbox(0, 0, 66, 66, 3, 5, rain)

    paint(c, P, body, carbon)

    c.paint((Y >= 33) & (Y <= 34) & (Z >= 13), camc)               # camera pod on the airbox

    def rim(py, pz, from_outer, r, ang, R):
        if r > R - 1.5:
            return None
        if from_outer == 0:
            if rings and r > R - 2.5:               # one colour, or segments round the rim
                return rings[int((ang + math.pi) / (2 * math.pi) * len(rings)) % len(rings)]
            if dot and r < 1.0:
                return dot
        return cover
    c.wheel(12, 5, 5, 5, 13, rim, tire, 'F')
    c.wheel(57, 5, 5, 6, 13, rim, tire, 'R')
    c.meta = {'label': label}
    return c


def formula_navy_blue():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        navy = P.add('navy', '#12239a'); blue = P.add('blue', '#2163f2'); white = P.add('white', '#f4f6fa')
        orange = P.add('orange', '#f07a1c'); black = P.add('black', '#17181c')
        # near-black nose -> navy -> royal blue towards the tail
        c.paint((Y >= 12) & (Y < 17) & ((Y + Z) % 2 == 0), navy, only=body)
        c.paint(Y >= 17, navy, only=body)
        c.paint((Y >= 30) & (Y < 36) & (Z >= 4) & ((Y + Z) % 2 == 0), blue, only=navy)
        c.paint((Y >= 36) & (Z >= 4), blue, only=navy)
        c.paint((Y >= 26) & (Z <= 3), black, only=[body, navy, blue])
        side = dict(only=[body, navy, blue], face='side')
        c.paint((Y >= 14) & (Y <= 20) & (Z == 4) & (Y % 2 == 0), white, **side)        # dashes by the front wheel
        c.paint((Y >= 27) & (Y <= 28) & (Z == 6), orange, **side)
        c.paint((Y >= 30) & (Y <= 34) & (Z == 6) & (Y % 2 == 0), white, **side)
        c.paint((Y >= 38) & (Y <= 46) & (Z == 4) & (Y % 3 != 0), white, **side)        # low on the sidepod
        c.paint((Y >= 40) & (Y <= 48) & (Z == 8), white, **side)                       # stripe on the engine cover
        c.paint((Y >= 42) & (Y <= 46) & (Z == 9) & (Y % 2 == 0), white, **side)
        c.paint((Y == 50) & (Z == 5), orange, **side)
        c.paint((DX > 6) & (Y >= 60) & (Z >= 7), body, only=carbon)                    # rear wing end plates
        c.paint((DX > 6) & (Y >= 62) & (Y <= 66) & (Z == 10), white, only=body)
        c.paint((DX > 12) & (Y <= 6) & (Z >= 2), body, only=carbon)
    return _formula('formula_navy_blue', 'Formula navy-blue', '#070d3d', paint, helmet='#f4f6fa',
                    wheel={'cover': '#eef0f4', 'dot': '#d8222a'}, cam='#f07a1c')


def formula_blue_pink():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        pink = P.add('pink', '#ff8fcf'); white = P.add('white', '#f4f6fa'); black = P.add('black', '#17181c')
        light = P.add('light', '#5cbcff')
        c.paint((Y <= 6) & (Z == 2), pink, only=carbon)                                # pink front wing flap and end plates
        c.paint((DX > 12) & (Y <= 6), pink, only=carbon)
        c.paint((Y >= 3) & (Y <= 22) & (DX < 1), pink, only=body, face='top')          # stripe along the top of the nose
        c.paint((Y >= 26) & (Z <= 3), black, only=body)
        c.paint((Y >= 30) & (Y <= 44) & (Z >= 4) & (Z <= 5), pink, only=body, face='side')   # pink band low on the sidepod
        c.paint((Y >= 30) & (Y <= 46) & (Z >= 7) & ((Y * 3 + Z * 5) % 4 == 0), light, only=body)   # mottled engine cover
        c.paint((Y >= 32) & (Y <= 46) & (Z >= 8) & ((Y * 7 + Z * 3) % 9 == 0), white, only=[body, light])
        c.paint((Y >= 46) & (Y <= 56) & (Z >= 4) & ((Y + Z) % 2 == 0), pink, only=[body, light])   # pink and white tail
        c.paint((Y >= 46) & (Y <= 56) & (Z >= 4), white, only=[body, light])
        c.paint((DX > 6) & (Y >= 60) & (Z >= 6), pink, only=carbon)
        c.paint((DX > 6) & (Y >= 62) & (Y <= 66) & (Z == 9), white, only=pink)
        c.paint((Y >= 64) & (Z == 12), pink, only=carbon, face='top')
    return _formula('formula_blue_pink', 'Formula blue-pink', '#1478e8', paint, helmet='#58b8ff',
                    wheel={'cover': '#eef0f4', 'dot': '#d8222a'})


def formula_navy_red():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        red = P.add('red', '#e0452a'); yellow = P.add('yellow', '#ffd21f'); white = P.add('white', '#f4f6fa')
        c.paint(Y <= 4, yellow, only=body)                                             # yellow tip, red band
        c.paint((Y >= 5) & (Y <= 8), red, only=body)
        c.paint((Y >= 31) & (Y <= 47) & (Z >= 8), yellow, only=body)                   # yellow engine cover, red centre
        c.paint((Y >= 35) & (Y <= 43) & (Z >= 10), red, only=yellow)
        c.paint((Y >= 48) & (Y <= 53) & (Z == 8), yellow, only=body, face='side')
        c.paint((Y >= 27) & (Y <= 28) & (Z == 3), yellow, only=body, face='side')
        c.paint((Y == 29) & (Z == 3), red, only=body, face='side')
        c.paint((Y >= 31) & (Y <= 48) & (Z == 2), red, only=body, face='side')         # thin red line along the floor edge
        c.paint((Y >= 52) & (Y <= 56) & (Z >= 5) & (Z <= 6), red, only=body, face='side')
        c.paint((DX > 6) & (Y >= 60) & (Z >= 7), body, only=carbon)
        c.paint((DX > 6) & (Y >= 63) & (Y <= 66) & (Z >= 10) & (Z <= 11), red, only=body)
        c.paint((DX > 6) & (Y >= 61) & (Y <= 62) & (Z == 8), white, only=body)
        c.paint((DX > 12) & (Y <= 6) & (Z >= 3), yellow, only=carbon)
    return _formula('formula_navy_red', 'Formula navy-red', '#101a44', paint, helmet='#ffd21f',
                    wheel={'ring': ['#d8222a']}, cam='#ffd21f')


def formula_silver_teal():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        black = P.add('black', '#17181c'); teal = P.add('teal', '#17d1bd'); white = P.add('white', '#ffffff')
        c.paint((Y >= 26) & (Z <= 5), black, only=body)                                # black sidepods and floor edge
        c.paint((Y >= 40) & (Y < 48) & ((Y + Z) % 2 == 0), black, only=body)           # chequered fade to a black tail
        c.paint(Y >= 48, black, only=body)
        side = dict(only=[body, black], face='side')
        c.paint((Y >= 8) & (Y <= 25) & (Z == 5), teal, **side)                         # teal line from the nose ...
        c.paint((Y >= 26) & (Y <= 46) & (Z == 3), teal, **side)                        # ... along the sidepod, rising at the back
        c.paint((Y >= 47) & (Y <= 52) & (Z == 4), teal, **side)
        c.paint((Y >= 34) & (Y <= 42) & (Z == 5), white, **side)
        c.paint((Y >= 30) & (Y <= 38) & (Z >= 9), white, only=body, face='top')
        c.paint((DX > 12) & (Y <= 6) & (Z >= 3), teal, only=carbon)
        c.paint((DX > 6) & (Y >= 62) & (Y <= 66) & (Z == 10), white, only=carbon)
    return _formula('formula_silver_teal', 'Formula silver-teal', '#d4d9df', paint, helmet='#ffe23a',
                    wheel={'dot': '#17d1bd', 'ring': ['#3a3d44']})


def formula_papaya():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        black = P.add('black', '#1b1c20')
        c.paint((Y >= 16) & (Z <= 3), black, only=body)
        c.paint((Y >= 18) & (Y <= 25) & (Z == 3) & (Y % 2 == 0), body, only=black, face='side')   # papaya dashes on the black chin
        c.paint((Y >= 23) & (Y <= 31) & (Z >= 6), black, only=body, face='side')       # black round the cockpit
        c.paint((Y >= 28) & (Y <= 45) & (Z <= 6) & (Y + Z <= 49), black, only=body, face='side')  # black sidepod; papaya sweeps in from the tail
        c.paint((Y >= 30) & (Y <= 40) & (Z >= 11), black, only=body)                   # black airbox
        c.paint((Y >= 52) & (Z <= 4), black, only=body)
        c.paint((DX > 12) & (Y <= 6) & (Z >= 2), body, only=carbon)                    # papaya wing tips
        c.paint((Y >= 3) & (Y <= 5) & (Z == 2) & (DX > 7), body, only=carbon)
        c.paint((DX > 6) & (Y >= 60) & (Z >= 9), body, only=carbon)
        c.paint((DX > 6) & (Y >= 63) & (Y <= 66) & (Z == 10), black, only=body)
    return _formula('formula_papaya', 'Formula papaya', '#ff8f1a', paint, helmet='#f4f6fa',
                    wheel={'ring': ['#ffd21f', '#d8222a', '#2340d8', '#27a844']})


def formula_red():
    def paint(c, P, body, carbon):
        Y, Z, DX = c.Y, c.Z, c.DX
        white = P.add('white', '#f4f6fa'); deep = P.add('deepred', '#8e0a10'); yellow = P.add('yellow', '#ffd21f')
        black = P.add('black', '#17181c')
        c.paint((Y >= 26) & (Z <= 2), black, only=body)
        c.paint((Y >= 40) & (Z >= 7) & ((Y + Z) % 2 == 0) & (Y < 44), deep, only=body)  # darker red over the engine cover
        c.paint((Y >= 44) & (Z >= 7), deep, only=body)
        c.paint((Y >= 31) & (Z >= 12), deep, only=body)
        side = dict(only=[body, deep], face='side')
        c.paint((Y >= 16) & (Y <= 20) & (Z == 4), white, **side)
        c.paint((Y >= 28) & (Y <= 29) & (Z >= 4) & (Z <= 5), yellow, **side)
        c.paint((Y >= 32) & (Y <= 36) & (Z == 5), white, **side)
        c.paint((Y >= 39) & (Y <= 40) & (Z >= 3) & (Z <= 4), yellow, **side)
        c.paint((Y >= 43) & (Y <= 50) & (Z == 4) & (Y % 3 != 0), white, **side)
        c.paint((Y >= 38) & (Y <= 44) & (Z == 8), white, **side)
        c.paint((Y <= 2) & (DX < 2) & (Z == 1), white, only=carbon)                    # white tip on the front wing
        c.paint((DX > 12) & (Y <= 6) & (Z >= 3), body, only=carbon)
        c.paint((DX > 6) & (Y >= 62) & (Y <= 66) & (Z == 10), white, only=carbon)
        c.paint((Y >= 64) & (Z == 12), body, only=carbon, face='top')
    return _formula('formula_red', 'Formula red', '#d6101a', paint, helmet='#ffd21f',
                    wheel={'ring': ['#ffd21f']}, cam='#23b7c9')


FORMULA = [formula_navy_blue, formula_blue_pink, formula_navy_red, formula_silver_teal, formula_papaya, formula_red]
BUILDERS += FORMULA
