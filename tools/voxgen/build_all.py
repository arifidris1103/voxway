"""
Regenerate every MagicaVoxel asset and public/assets/manifest.json.

  python3 tools/voxgen/build_all.py            # everything
  python3 tools/voxgen/build_all.py cars       # one group
  python3 tools/voxgen/build_all.py cars:retro_panda_coupe

Hand-edited .vox files are never overwritten unless their generator is named
explicitly: the NPCs from /npcs are copied, not generated.
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)

from voxlib import Manifest, write_vox  # noqa: E402

PUBLIC = os.path.join(ROOT, 'public', 'assets')


def build_cars(manifest, only=None):
    import cars
    for fn in cars.BUILDERS:
        if only and fn.__name__ != only:
            continue
        car = fn()
        rel = 'vox/cars/%s.vox' % car.name
        n = write_vox(os.path.join(PUBLIC, rel), car.parts(), car.pal, layer_name='car')
        vs = car.vs
        manifest.add('cars/' + car.name, file=rel, category='car', voxelSize=vs,
                     tags=car.pal.kinds(), dims=[car.W, car.L, car.H],
                     length=round(car.L * vs, 3), width=round((car.W - 2) * vs, 3),
                     height=round(car.roof_height() * vs, 3), **car.meta)
        print('  car %-22s %6d voxels  %6.1f KB' % (car.name, int((car.v > 0).sum()), n / 1024))


def build_npcs(manifest, only=None):
    import npcs
    src = os.path.join(ROOT, 'npcs')
    dst = os.path.join(PUBLIC, 'vox', 'npcs')
    os.makedirs(dst, exist_ok=True)
    # The user's hand-made NPCs are copied verbatim.
    for f in sorted(os.listdir(src)):
        if f.endswith('.vox'):
            shutil.copyfile(os.path.join(src, f), os.path.join(dst, f))
            key = f[:-4]
            manifest.add('npcs/' + key, file='vox/npcs/' + f, category='npc', voxelSize=npcs.NPC_VOXEL,
                         label=key.replace('npc_', '').title(), source='hand-made (npcs/)')
    for fn in npcs.BUILDERS:
        if only and fn.__name__ != only:
            continue
        name, parts, pal, label = fn()
        rel = 'vox/npcs/%s.vox' % name
        write_vox(os.path.join(PUBLIC, rel), parts, pal, layer_name='character')
        manifest.add('npcs/' + name, file=rel, category='npc', voxelSize=npcs.NPC_VOXEL,
                     label=label, source='generated', tags=pal.kinds())
        print('  npc %s' % name)


def build_props(manifest, only=None):
    import props
    for fn in props.BUILDERS:
        if only and fn.__name__ != only:
            continue
        for item in fn():
            name, parts, pal, meta = item
            group = meta.pop('group', 'props')
            rel = 'vox/%s/%s.vox' % (group, name)
            write_vox(os.path.join(PUBLIC, rel), parts, pal, layer_name=group)
            category = meta.pop('category', 'building' if group == 'buildings' else 'prop')
            if name[-2:] in ('_a', '_b', '_c', '_d'):
                meta['label'] = '%s %s' % (meta.get('label', name), name[-1].upper())
            manifest.add('%s/%s' % (group, name), file=rel, category=category, tags=pal.kinds(), **meta)
            print('  %s/%s' % (group, name))


GROUPS = {'cars': build_cars, 'npcs': build_npcs, 'props': build_props}


def main(argv):
    manifest = Manifest(os.path.join(PUBLIC, 'manifest.json'))
    targets = argv or list(GROUPS)
    for t in targets:
        group, _, only = t.partition(':')
        if group not in GROUPS:
            print('unknown group', group)
            continue
        try:
            __import__({'cars': 'cars', 'npcs': 'npcs', 'props': 'props'}[group])
        except ModuleNotFoundError as e:
            print('skip %s (%s)' % (group, e))
            continue
        print('[%s]' % group)
        GROUPS[group](manifest, only or None)
    manifest.save()


if __name__ == '__main__':
    main(sys.argv[1:])
