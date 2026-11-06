"""Train a pedestrian trajectory predictor on data exported from the simulator.

    npm run dataset -- --seeds 1-8 --minutes 5          # make data/peds (see tools/headless)
    pip install -r ml/requirements.txt
    python ml/train_ped_predictor.py --data data/peds   # -> public/models/ped_mlp.json

The model is a small multimodal MLP. It reads what the AV can observe about one pedestrian
(src/sim/PedFeatures.js: 1 s of motion, nearby kerbs, the crosswalk and its walk light, the
nearest cars) and predicts K possible paths for the next 4 s (20 points, 0.2 s apart) plus a
probability for each. Training uses the usual "winner takes all" loss: only the guess closest to
what really happened is pulled towards it, and the probabilities learn which guess wins.
Pedestrians on the road, at a crossing or about to step out count 5x (--focus 4): they are rare,
but they are the ones the AV must not get wrong.

Validation uses separate seeds (different simulated days), so the scores are honest. Reported,
next to the hand-written baseline on the same pedestrians:
  final error, top-1      how far (m) the most likely guess ends from where they really were after 4 s
  final error, best of 2  the same for the better of the two most likely guesses (the baseline
                          makes at most two, so this is the fair multi-guess comparison)
  missed by > 2 m         share of pedestrians whose best-of-2 guess ends more than 2 m away
  best of K               the best of all the model's guesses (minFDE), for reference
overall and for the cases that matter: hoppers, people waiting at a crossing, about to jaywalk,
jaywalking, and stepping into the road.

The trained weights are written as JSON that the simulator loads directly:
    http://localhost:5173/?model=models/ped_mlp.json      (press M to switch back and forth)
    npm run evaluate -- --model public/models/ped_mlp.json   (closed loop, baseline vs model)
"""

import argparse
import base64
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
STATES = ['walk', 'idle', 'watch', 'wait', 'cross', 'jaywait', 'jaycross', 'park', 'work']


# ----------------------------------------------------------------------------- data

def load(data_dir):
    """All seed_XXXX folders under data_dir -> dict of numpy arrays + info."""
    seeds = sorted(Path(data_dir).glob('seed_*'))
    if not seeds:
        raise SystemExit(f'No seed_XXXX folders in {data_dir}. Export some first: npm run dataset')
    parts, info = [], None
    for d in seeds:
        i = json.loads((d / 'info.json').read_text())
        if info and i['features'] != info['features']:
            raise SystemExit(f'{d} was exported with different features; re-export all seeds')
        info = info or i
        parts.append({k: np.load(d / f'{k}.npy') for k in ['X', 'Y', 'M', 'BL', 'BLP', 'meta']})
    data = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    return data, info


def split_by_seed(meta, val_frac):
    """Validation = the last seeds, so no simulated day is in both sets."""
    seeds = np.unique(meta[:, 0])
    if len(seeds) == 1:
        print('Only one seed: validating on its last 20 % of simulated time (export more seeds for an honest score)')
        t = meta[:, 1]
        cut = np.quantile(t, 0.8)
        return t < cut - 4, t >= cut      # 4 s gap: no shared futures
    n_val = max(1, round(len(seeds) * val_frac))
    val_seeds = seeds[-n_val:]
    val = np.isin(meta[:, 0], val_seeds)
    return ~val, val


# ---------------------------------------------------------------------------- model

class PedMLP(nn.Module):
    """features -> K paths of T (a, b) points + K logits. Plain Linear/ReLU so the simulator can
    run it in a few lines of JavaScript (src/sim/LearnedPredictor.js)."""

    def __init__(self, n_in, modes, steps, hidden=256, depth=3):
        super().__init__()
        self.modes, self.steps = modes, steps
        layers, d = [], n_in
        for _ in range(depth):
            layers += [nn.Linear(d, hidden), nn.ReLU()]
            d = hidden
        layers.append(nn.Linear(d, modes * steps * 2 + modes))
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        out = self.net(x)
        n = self.modes * self.steps * 2
        return out[:, :n].view(-1, self.modes, self.steps, 2), out[:, n:]


def mode_ade(paths, y, m):
    """paths (N,K,T,2), y (N,T,2), m (N,T) -> masked average displacement per mode (N,K)."""
    d = torch.linalg.norm(paths - y[:, None], dim=-1)                 # (N,K,T)
    return (d * m[:, None]).sum(-1) / m.sum(-1, keepdim=True).clamp(min=1)


def wta_loss(paths, logits, y, m, w, cls_weight):
    """Winner takes all: pull the closest guess towards the truth, teach the probabilities which
    guess wins. w = per-sample weight."""
    ade = mode_ade(paths, y, m)
    best = ade.argmin(1)
    win = paths[torch.arange(len(y)), best]                          # (N,T,2)
    mw = m * w[:, None]
    reg = (F.smooth_l1_loss(win, y, reduction='none').sum(-1) * mw).sum() / mw.sum().clamp(min=1)
    cls = (F.cross_entropy(logits, best, reduction='none') * w).sum() / w.sum()
    return reg + cls_weight * cls, reg.item(), cls.item()


def sample_weights(meta, focus):
    """1 for ordinary pedestrians, 1 + focus for the rare ones the AV must not get wrong: on the
    road, about to jaywalk / jaywalking, waiting at or using a crossing, or stepping into the road."""
    st = meta[:, 4].astype(int)
    risky = (meta[:, 5] == 1) | (meta[:, 6] == 1) | np.isin(st, [STATES.index(s) for s in ('wait', 'cross', 'jaywait', 'jaycross')])
    return 1.0 + focus * risky.astype(np.float32)


# -------------------------------------------------------------------------- metrics

def ade_np(paths, y, m):
    d = np.linalg.norm(paths - y[:, None], axis=-1)
    return (d * m[:, None]).sum(-1) / np.maximum(m.sum(-1, keepdims=True), 1)


def scores(paths, probs, y, m):
    """Best-of-k distances for k = 1 (the most likely guess), 2 and all, using the k most likely
    guesses. paths (N,K,T,2), probs (N,K) (missing guesses have probability 0)."""
    full = m.sum(1) == m.shape[1]                                     # FDE needs the whole 4 s
    order = np.argsort(-probs, axis=1)
    ade = np.take_along_axis(ade_np(paths, y, m), order, 1)
    fde = np.take_along_axis(np.linalg.norm(paths[:, :, -1] - y[:, None, -1], axis=-1), order, 1)
    avail = np.take_along_axis(probs, order, 1) > 0
    ade, fde = np.where(avail, ade, np.inf), np.where(avail, fde, np.inf)
    out = {'n': int(len(y))}
    for k, tag in [(1, 'top1'), (2, 'best_of_2'), (probs.shape[1], 'best_of_all')]:
        out[f'{tag}_ADE'] = float(ade[:, :k].min(1).mean())
        out[f'{tag}_FDE'] = float(fde[full, :k].min(1).mean()) if full.any() else math.nan
        out[f'{tag}_miss'] = float((fde[full, :k].min(1) > 2.0).mean()) if full.any() else math.nan
    return out


def subsets(meta):
    st = meta[:, 4].astype(int)
    return {
        'all': np.ones(len(meta), bool),
        'hoppers': meta[:, 3] == 1,
        'walkers': meta[:, 3] == 0,
        'waiting to cross': st == STATES.index('wait'),
        'about to jaywalk': st == STATES.index('jaywait'),
        'jaywalking': st == STATES.index('jaycross'),
        'steps into the road': meta[:, 6] == 1,
    }


def report(model_pred, data, sel, title):
    """Model vs baseline on the same pedestrians. The baseline makes at most 2 guesses, so the
    fair comparisons are the most likely guess (top-1) and the best of the 2 most likely."""
    paths, probs = model_pred
    y, m, meta = data['Y'][sel], data['M'][sel], data['meta'][sel]
    rows = {}
    print(f'\n{title}')
    print(f'{"":20s} {"":>7s}   {"final error, top-1":^19s}   {"final error, best of 2":^22s}   {"missed by > 2 m":^17s}   {"model":>9s}')
    print(f'{"":20s} {"n":>7s}   {"model":>9s} {"baseline":>9s}   {"model":>10s} {"baseline":>11s}   {"model":>8s} {"baseline":>8s}   {"best of " + str(probs.shape[1]):>9s}')
    for name, s in subsets(meta).items():
        if s.sum() == 0:
            continue
        a = scores(paths[s], probs[s], y[s], m[s])
        b = scores(data['BL'][sel][s], data['BLP'][sel][s], y[s], m[s])
        rows[name] = {'model': a, 'baseline': b}
        print(f'{name:20s} {a["n"]:7d}   {a["top1_FDE"]:8.2f}m {b["top1_FDE"]:8.2f}m   {a["best_of_2_FDE"]:9.2f}m {b["best_of_2_FDE"]:10.2f}m'
              f'   {a["best_of_2_miss"]:8.1%} {b["best_of_2_miss"]:8.1%}   {a["best_of_all_FDE"]:8.2f}m')
    return rows


# --------------------------------------------------------------------------- export

def b64(t):
    return base64.b64encode(t.detach().cpu().numpy().astype('<f4').tobytes()).decode('ascii')


def export_json(model, mean, std, info, path, extra):
    layers = [l for l in model.net if isinstance(l, nn.Linear)]
    out = {
        'format': 'voxel-av-sim/ped-mlp',
        'version': 1,
        'name': f'learned MLP ({model.modes} modes)',
        'feature_version': info['feature_version'],
        'n_features': len(info['features']),
        'modes': model.modes,
        'steps': model.steps,
        'dt': info['future_dt'],
        'mean': [float(v) for v in mean],
        'std': [float(v) for v in std],
        # weights row-major [out][in] (PyTorch layout), float32 little-endian, base64
        'layers': [{'in': l.in_features, 'out': l.out_features, 'act': 'relu' if i < len(layers) - 1 else 'none',
                    'W': b64(l.weight), 'b': b64(l.bias)} for i, l in enumerate(layers)],
        **extra,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    print(f'\nWrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} ({path.stat().st_size / 1e6:.1f} MB)')


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', default=str(ROOT / 'data' / 'peds'), help='folder with seed_XXXX exports')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'models' / 'ped_mlp.json'), help='model JSON for the simulator')
    ap.add_argument('--modes', type=int, default=6, help='number of predicted paths')
    ap.add_argument('--hidden', type=int, default=256)
    ap.add_argument('--depth', type=int, default=3, help='hidden layers')
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--batch', type=int, default=512)
    ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--cls-weight', type=float, default=0.5, help='weight of the which-path-wins loss')
    ap.add_argument('--focus', type=float, default=4.0,
                    help='extra weight for pedestrians on or about to step into the road (0 = all equal)')
    ap.add_argument('--val-frac', type=float, default=0.25, help='share of seeds held out for validation')
    ap.add_argument('--device', default='auto', help='auto | cpu | mps | cuda')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    dev = torch.device(('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
                       if args.device == 'auto' else args.device)

    data, info = load(args.data)
    tr, va = split_by_seed(data['meta'], args.val_frac)
    n_feat, steps = data['X'].shape[1], data['Y'].shape[1]
    print(f'{len(data["X"]):,} samples ({tr.sum():,} train / {va.sum():,} validation), {n_feat} features, '
          f'{steps} steps x {info["future_dt"]} s, device {dev}')

    # normalise inputs with training statistics (stored in the model file, applied in the sim)
    mean = data['X'][tr].mean(0)
    std = np.maximum(data['X'][tr].std(0), 1e-3)
    t = lambda a: torch.as_tensor(a, dtype=torch.float32, device=dev)
    Xtr, Ytr, Mtr = t((data['X'][tr] - mean) / std), t(data['Y'][tr]), t(data['M'][tr])
    Wtr = t(sample_weights(data['meta'][tr], args.focus))
    Xva, Yva, Mva = t((data['X'][va] - mean) / std), t(data['Y'][va]), t(data['M'][va])

    model = PedMLP(n_feat, args.modes, steps, args.hidden, args.depth).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    batches = math.ceil(len(Xtr) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * batches)
    print(f'model: {sum(p.numel() for p in model.parameters()):,} parameters')

    def predict(X):
        model.eval()
        with torch.no_grad():
            outs = [model(X[i:i + 4096]) for i in range(0, len(X), 4096)]
        paths = torch.cat([o[0] for o in outs])
        probs = torch.softmax(torch.cat([o[1] for o in outs]), -1)
        return paths, probs

    best, best_state = math.inf, None
    t0 = time.time()
    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = torch.randperm(len(Xtr), device=dev)
        tot = 0.0
        for b in range(batches):
            i = perm[b * args.batch:(b + 1) * args.batch]
            paths, logits = model(Xtr[i])
            loss, _, _ = wta_loss(paths, logits, Ytr[i], Mtr[i], Wtr[i], args.cls_weight)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
        paths, probs = predict(Xva)
        ade = mode_ade(paths, Yva, Mva)
        val_min = ade.min(1).values.mean().item()
        val_top = ade[torch.arange(len(ade)), probs.argmax(1)].mean().item()
        flag = ''
        if val_min + val_top < best:                 # keep the epoch best at both
            best, flag = val_min + val_top, '  *'
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        print(f'epoch {epoch:3d}  train loss {tot / batches:.3f}  validation error: top-1 {val_top:.3f} m, '
              f'best of {args.modes} {val_min:.3f} m  ({time.time() - t0:.0f} s){flag}')

    model.load_state_dict(best_state)
    paths, probs = predict(Xva)
    rows = report((paths.cpu().numpy(), probs.cpu().numpy()), data, va,
                  f'Validation ({va.sum():,} samples from seeds the model never saw). Distances in metres.')

    run_dir = ROOT / 'ml' / 'runs' / datetime.now().strftime('%Y%m%d-%H%M%S')
    run_dir.mkdir(parents=True, exist_ok=True)
    torch.save({'state_dict': model.state_dict(), 'args': vars(args), 'mean': mean, 'std': std,
                'features': info['features']}, run_dir / 'model.pt')
    (run_dir / 'metrics.json').write_text(json.dumps(rows, indent=1))
    print(f'Saved the checkpoint and metrics in {run_dir.relative_to(ROOT)}')
    seeds = sorted({int(s) for s in data['meta'][:, 0]})
    export_json(model, mean, std, info, Path(args.out), {
        'trained': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'data': {'seeds': seeds, 'train_samples': int(tr.sum()), 'val_samples': int(va.sum())},
        'val': {k: v['model'] for k, v in rows.items()},
    })
    print('Try it: http://localhost:5173/?model=models/' + Path(args.out).name + '  (M switches baseline / model)')


if __name__ == '__main__':
    main()
