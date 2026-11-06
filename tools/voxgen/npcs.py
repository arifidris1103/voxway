"""
Voxel pedestrians.

The six hand-made characters in /npcs are used as-is. New characters generated
here follow exactly the same rig layout (10 named parts: head, body,
arm_upper_R/L, arm_lower_R/L, leg_upper_R/L, leg_lower_R/L), face -Y and stand
on z = 0, so the simulator animates them the same way.
"""
import numpy as np

from voxlib import Palette

# 1 NPC voxel = 3.6 cm  ->  a 48-voxel character is ~1.73 m tall.
NPC_VOXEL = 0.036


def _grid(w, d, h):
    return np.zeros((w, d, h), np.uint8)


def _head(P, o, kid=False):
    W, D, H = (13, 11, 13) if kid else (14, 12, 14)
    g = _grid(W, D, H + 4)                      # headroom for hats
    skin, hair = P[o['skin']], P[o['hair']]
    g[:, :, :H] = skin
    style = o.get('hair_style', 'short')
    # hair cap: top layers, back, upper sides
    top = H - 4
    if style != 'bald':
        g[:, :, top:H] = hair
        g[:, D - 3:, 4:H] = hair
        g[[0, W - 1], 3:, top - 4:H] = hair
        if style == 'long':
            g[:, D - 3:, 0:H] = hair
            g[[0, W - 1], 2:, 1:H] = hair
        if style == 'fringe':
            g[1:W - 1, 0, top - 1:top] = hair
        if style == 'grey':
            g[2:W - 2, 0, top:top + 1] = skin   # receding hairline
    else:
        g[:, D - 4:, 4:8] = hair
    # face (front is y = 0)
    ey = 6 if not kid else 5
    eye = P['eye']
    for x0 in (3, W - 5):
        g[x0:x0 + 2, 0, ey:ey + 2] = eye
    g[W // 2 - 1:W // 2 + 1, 0, ey - 3] = P['mouth']
    if o.get('glasses'):
        # open frames (skin shows through) with a 1x2 pupil, like npcs/npc_glasses.vox
        fr = P['frame']
        for x0 in (2, W - 6):
            g[x0:x0 + 4, 0, ey - 1:ey + 3] = fr
            g[x0 + 1:x0 + 3, 0, ey:ey + 2] = skin
            g[x0 + 1, 0, ey:ey + 2] = eye
        g[W // 2 - 1:W // 2 + 1, 0, ey + 1] = fr
    hat = o.get('hat')
    if hat == 'helmet':
        c, v = P['hat'], P['visor']
        g[:, :, H - 5:H + 2] = 0
        g[:, :, H - 5:H + 2] = c
        g[1:W - 1, 1:D - 1, H + 2] = c
        g[2:W - 2, 0, H - 4:H - 2] = v
    elif hat == 'hardhat':
        c = P['hat']
        g[:, :, H - 2:H + 1] = c
        g[2:W - 2, 2:D - 2, H + 1:H + 3] = c
        g[:, 0:1, H - 2] = c
        g[2:W - 2, 0, H - 3] = c                # brim
    elif hat == 'cap':
        c = P['hat']
        g[:, :, H - 3:H + 1] = c
        g[2:W - 2, 2:D - 2, H + 1] = c
        g[2:W - 2, 0, H - 3] = c
        brim = _grid(W, D + 3, H + 4)
        brim[:, 3:, :] = g
        brim[3:W - 3, 0:3, H - 3] = c           # visor sticks out in front
        g = brim
    elif hat == 'headband':
        g[:, :, H - 5] = P['hat']
    # trim empty headroom
    zs = np.nonzero(g.any(axis=(0, 1)))[0]
    return g[:, :, :zs.max() + 1], (W, D, H)


def _body(P, o, kid=False):
    W, D, H = (10, 6, 13) if kid else (12, 6, 18)
    back = o.get('pack_depth', 0)
    g = _grid(W, D + back, H)
    top, bottom = P[o['top']], P[o['bottom']]
    g[:, :D, :] = top
    g[:, :D, :3] = bottom                       # hips
    g[W // 2 - 2:W // 2 + 2, 0:2, H - 1] = P[o['skin']]   # neck line
    det = o.get('detail')
    if det == 'tie':
        g[W // 2 - 1:W // 2 + 1, 0, 4:H - 1] = P['accent']
    elif det == 'zip':
        g[W // 2 - 1:W // 2, 0, 3:H - 1] = P['accent']
    elif det == 'vest':
        s = P['accent']
        g[:, 0, 7:9] = s
        g[:, D - 1, 7:9] = s
        g[[0, W - 1], :D, 7:9] = s
        g[2:4, 0, 9:H] = s
        g[W - 4:W - 2, 0, 9:H] = s
    elif det == 'stripes':
        for z in range(4, H - 1, 4):
            g[:, :D, z] = P['accent']
    elif det == 'cardigan':
        g[W // 2 - 1:W // 2 + 1, 0, 3:H - 1] = P['accent']
        g[W // 2 - 2:W // 2 + 2, 0, H - 3:H - 1] = P['accent']
    elif det == 'belt':
        g[:, :D, 3] = P['accent']
    if back:
        pk = P[o.get('pack', 'pack')]
        bw = o.get('pack_w', W)
        x0 = (W - bw) // 2
        g[x0:x0 + bw, D:D + back, o.get('pack_z0', 3):H] = pk
        if 'pack_trim' in o:
            g[x0:x0 + bw, D + back - 1, o.get('pack_z0', 3) + 2:H - 2] = P[o['pack_trim']]
    return g, (W, D, H)


def _arm(P, o, upper, kid=False):
    W, D = 4, 3
    H = (6 if upper else 8) if kid else (8 if upper else 10)
    g = _grid(W, D, H)
    sleeve = P[o['top']]
    skin = P[o['skin']]
    g[:, :, :] = sleeve
    if not upper:
        g[:, :, :3] = skin                      # hand
        if o.get('short_sleeves'):
            g[:, :, :] = skin
    elif o.get('short_sleeves'):
        g[:, :, :H - 4] = skin
    if o.get('arm_band') and not upper:
        g[:, :, 3] = P['accent']
    return g


def _leg(P, o, upper, kid=False):
    if upper:
        H = 9 if kid else 12
        g = _grid(4, 4, H)
        g[:, :, :] = P[o['bottom']]
        if o.get('shorts'):
            g[:, :, :H - 6] = P[o['skin']]
        return g
    H = 8 if kid else 11
    g = _grid(4, 5, H)
    g[:, 1:, 3:] = P[o['skin']] if o.get('shorts') else P[o['bottom']]
    if o.get('socks'):
        g[:, 1:, 3:5] = P['sock']
    g[:, :, :3] = P[o['shoes']]
    g[:, :, 0] = P['sole']
    return g


def humanoid(name, label, colors, o, kid=False):
    P = Palette()
    for k, v in colors.items():
        P.add(k, v)
    head, (hw, hd, hh) = _head(P, o, kid)
    body, (bw, bd, bh) = _body(P, o, kid)
    au, al = _arm(P, o, True, kid), _arm(P, o, False, kid)
    lu, ll = _leg(P, o, True, kid), _leg(P, o, False, kid)

    # Stack bottom-up exactly like the hand-made rigs.
    ll_h, lu_h = ll.shape[2], lu.shape[2]
    lu_z0 = ll_h - 4                             # knee overlap
    body_z0 = lu_z0 + lu_h - 3                   # hip overlap
    head_z0 = body_z0 + bh
    al_h, au_h = al.shape[2], au.shape[2]
    au_z0 = body_z0 + bh - au_h - 1              # shoulder just under the collar
    al_z0 = au_z0 - al_h + 3
    leg_x = 2 if kid else 3
    arm_x = bw // 2 + 2

    def t(g, x, y, z0):
        sx, sy, sz = g.shape
        return (x, y, z0 + sz // 2)

    # body / pack: body front at world y = -bd/2 (pack sticks out behind)
    parts = [
        {'name': 'head', 'grid': head, 't': (0, (head.shape[1] - hd) // 2 + 0, head_z0 + head.shape[2] // 2)},
        {'name': 'body', 'grid': body, 't': (0, (body.shape[1] - bd) // 2, body_z0 + bh // 2)},
    ]
    if o.get('hat') == 'cap':
        # the cap's visor extends the grid 3 voxels forward; keep the face where it was
        D2 = head.shape[1]
        parts[0]['t'] = (0, -(hd // 2) - 3 + D2 // 2, head_z0 + head.shape[2] // 2)
    for side, sx in (('R', -1), ('L', 1)):
        parts += [
            {'name': 'arm_upper_' + side, 'grid': au, 't': t(au, sx * arm_x, 0, au_z0)},
            {'name': 'arm_lower_' + side, 'grid': al, 't': t(al, sx * arm_x, 0, al_z0)},
            {'name': 'leg_upper_' + side, 'grid': lu, 't': t(lu, sx * leg_x, 0, lu_z0)},
            {'name': 'leg_lower_' + side, 'grid': ll, 't': t(ll, sx * leg_x, -1, 0)},
        ]
    # keep the same part order as the hand-made files
    order = ['head', 'body', 'arm_upper_R', 'arm_lower_R', 'arm_upper_L', 'arm_lower_L',
             'leg_upper_R', 'leg_lower_R', 'leg_upper_L', 'leg_lower_L']
    parts.sort(key=lambda p: order.index(p['name']))
    return name, parts, P, label


BASE = {'eye': '#17110d', 'mouth': '#8a3b2b', 'sole': '#e8e8ec', 'frame': '#3b2f2a', 'sock': '#f2f2f2'}


def npc_courier():
    c = dict(BASE, skin='#f2c39b', hair='#1d1612', jacket='#f7c21a', pants='#2a2f3d', shoes='#1b1b1e',
             accent='#24356b', hat='#f7c21a', visor='#1b2230', box='#f5b90c', trim='#24356b')
    o = dict(skin='skin', hair='hair', top='jacket', bottom='pants', shoes='shoes', hat='helmet',
             detail='zip', pack_depth=7, pack='box', pack_w=12, pack_z0=4, pack_trim='trim', arm_band=True)
    return humanoid('npc_courier', 'Courier', c, o)


def npc_worker():
    c = dict(BASE, skin='#d9a27a', hair='#2b2420', vest='#ff7a1a', jeans='#3b5a8a', shoes='#6b4423',
             accent='#d9dde3', hat='#f4f4f0')
    o = dict(skin='skin', hair='hair', top='vest', bottom='jeans', shoes='shoes', hat='hardhat', detail='vest')
    return humanoid('npc_worker', 'Worker', c, o)


def npc_elder():
    c = dict(BASE, skin='#f0c9a5', hair='#c9c9cc', cardigan='#7a2a3a', slacks='#b9a27e', shoes='#4a3426',
             accent='#efe9dc')
    o = dict(skin='skin', hair='hair', top='cardigan', bottom='slacks', shoes='shoes', hair_style='grey',
             detail='cardigan', glasses=True)
    return humanoid('npc_elder', 'Elder', c, o)


def npc_jogger():
    c = dict(BASE, skin='#c98e66', hair='#120e0c', tank='#e0307a', shorts='#1c1c22', shoes='#7ef04a',
             accent='#ffffff', hat='#ffffff')
    o = dict(skin='skin', hair='hair', top='tank', bottom='shorts', shoes='shoes', hat='headband',
             short_sleeves=True, shorts=True, socks=True, detail='stripes')
    return humanoid('npc_jogger', 'Jogger', c, o)


def npc_kid():
    c = dict(BASE, skin='#f6d0ad', hair='#3a2416', tee='#e8402f', shorts='#2d5fb8', shoes='#f4f4f4',
             accent='#ffd23a', hat='#ffd23a', pack='#3aa65a')
    o = dict(skin='skin', hair='hair', top='tee', bottom='shorts', shoes='shoes', hat='cap',
             short_sleeves=True, shorts=True, pack_depth=3, pack='pack', pack_w=8, pack_z0=3)
    return humanoid('npc_kid', 'Kid', c, o, kid=True)


BUILDERS = [npc_courier, npc_worker, npc_elder, npc_jogger, npc_kid]
