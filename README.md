# Voxel AV Sim

**Crossy Road, flipped.** Your self-driving car is the one in traffic, and voxel pedestrians hop across the road in front of it. The car has to yield, merge and get through intersections. The problem at its centre is a real AV problem: **predicting pedestrians**.

Every asset is a **MagicaVoxel `.vox` file** and everything is rendered with **three.js**. The world is a voxel take on a Shanghai expressway interchange (`road/busy-city-road-F4A024.jpg`). It has two expressway levels: a viaduct on hammerhead piers with teal parapets, crossed by a higher flyover that is joined to it by two long curved ramps. Just outside the city, a loop ramp at each end links the flyover with north_st, which carries on out of town underneath it, and both expressways run on into the haze. The ramps join like real ones: the deck widens into an exit or entry lane with a dashed edge line, a painted gore narrows to a nose, and only then does the ramp separate and climb or descend (7 % at most). Underneath are a busy six-lane boulevard, red-roof residential rows, white residential towers, blue glass offices, and a park with an oval flower bed.

```bash
npm install
npm run dev        # http://localhost:5173  (simulator)
                   # http://localhost:5173/garage.html  (asset viewer, side by side with the reference renders)
```

## What happens in the sim

- **The AV** (any of the 7 cars, with a voxel lidar/camera roof kit) drives a loop of about 3 km:
  - **City streets:** protected left turns, right turns across busy crosswalks, a **road-works lane closure** where it has to merge, and three passes under the viaduct.
  - **Expressway:** out of town on north_st and off at the west loop ramp, which climbs through the gap between the street and the flyover and merges into flyover traffic at 22 m. Across the city past the curved-ramp junctions (one exit, one merge), then off at the east loop ramp, back down to north_st and into the city.
- **Traffic**: about 76 ground vehicles and about 72 on the elevated roads (the viaduct, the flyover and the ramps, which merge zipper-style). They use IDM car-following, obey 4-phase signals (protected lefts, pedestrian walk phases), don't block the box, yield to pedestrians, and make gap-accepting lane changes. Some drivers are courteous and let a waiting merger in. On the expressway, cars overtake slower traffic on the left and then move back right.
- **Pedestrians**: about 90 pedestrians walk the sidewalk graph, wait for WALK and cross at zebra crossings. Some **jaywalk** mid-block. "Hoppers" cross Crossy-Road style in discrete hops and sometimes freeze mid-road, which is what makes them hard to predict. A scenario director keeps sending jaywalkers into the AV's path.
- **Accidents**: drivers make the mistakes real drivers make:
  - a distracted driver stops watching the car ahead (rear-end)
  - a driver runs a red light (T-bone, or a near miss)
  - someone changes lanes into an occupied lane (sideswipe)
  - on the expressway, a **speeding** driver goes 40–55% over the limit:
    - tailgates and reacts late (rear-end at speed)
    - squeezes into small gaps when overtaking, and some never check the blind spot (sideswipe)
    - takes a curved ramp far too fast and **loses control** into the parapet

  Expressway wrecks stay on the deck, blocking one or both lanes, so traffic and the AV have to change lanes around them or wait.

  Crashes use simple impulse physics, so the cars slide and spin, with flying debris, smoke, hazard lights and a warning triangle. Wrecks stay on the road for about 40 s:
  - traffic changes lanes or takes another exit around them
  - the AV detours, or re-plans its route and re-joins its loop
  - bystanders stop to look

  Drivers at fault still brake hard for the AV, and each of those cases is logged as a near miss. The default rate is about 0.8 incidents per minute, biased toward the AV's route.
- **The AV's "thoughts"** are drawn in the scene:
  - its planned path (green = go, amber = caution or merge, red = yield or stop)
  - multi-hypothesis pedestrian forecasts (dashed: cyan = walking on, amber = may cross, red = conflicts with the AV)
  - a ring around the pedestrian it is yielding to
  - a lidar sweep
- **HUD**: speed, decision (`CRUISE / FOLLOW / TURN / MERGE / CAUTION / YIELD / STOP · SIGNAL / AVOID · CRASH`), the reason, the yield target with TTC and probability, safety counters (yields, signal stops, merges, traffic accidents, AV crash detours and re-routes, closest pedestrian clearance while the AV is moving, **pedestrian collisions**), and a minimap that also shows the flyover, the ramps and wrecks.

| Key | Action |
| --- | --- |
| `C` | camera: chase → Crossy-style iso → aerial overview (like the photo) → interchange → incident (latest crash) → hood → free orbit |
| `P` | show/hide predictions |
| `N` | night drive |
| `1`–`7` | swap the AV's car |
| `J` | send a jaywalker into the AV's path |
| `X` | cause a traffic accident ahead of the AV (on the expressway: a speeding driver near the AV) |
| `Space` | pause |
| `R` | export the last 9.1 s as a **Waymo-Open-Motion-style scenario JSON** |
| `M` | switch between the baseline pedestrian predictor and your trained model (with `?model=`) |

URL options: `?seed=42` (replay the same run: same traffic, pedestrians and incidents; the HUD shows each run's seed), `?model=models/ped_mlp.json` (drive with your trained pedestrian predictor, see below), `?cam=overview`, `?night=1`, `?car=3`, `?peds=120`, `?cars=90` (ground traffic), `?hwy=28` (traffic on the lower viaduct), `?fly=90` (traffic on the upper flyover), `?warm=20` (simulate 20 s before showing), `?jay=3` (start with a jaywalker 3 s into crossing), `?crashes=2` (accidents per minute; `0` = off), `?crash=1&after=2` (start 2 s after a crash; `crash=red_light`, `unsafe_lane_change`, `distracted` or `speeding` picks the mistake), `?until=loop` / `flyover` / `loopE` (fast-forward until the AV reaches that part of its loop, e.g. `?until=flyover&crash=speeding&cam=incident`; the old names `spiral` / `spiralE` still work).

## Plugging in your model (Waymo Open Motion Dataset)

The world is built so a model trained on WOMD can drive the AV's pedestrian forecasts:

- **Same sampling**: the history buffer is 10 Hz with 11 steps (1.1 s), like WOMD.
- **Same map vocabulary**: lanes are polylines with `entry_lanes`/`exit_lanes` and speed limits, crosswalks are polygons, and signals give per-lane states with stop points (`src/world/RoadNetwork.js`).
- **Same schema on export**: `R` (or `sim.exportScenario()`) writes a `Scenario` with WOMD's field names and enum values. That covers `tracks[].states[]` (`center_x/y/z`, `length/width/height`, `heading`, `velocity_x/y`, `valid`), `object_type` (1 vehicle, 2 pedestrian), `sdc_track_index`, `tracks_to_predict`, `map_features` (`lane`, `crosswalk`) and `dynamic_map_states[].lane_states` (`LANE_STATE_*` numbers). It has 91 steps with `current_time_index = 10`. Coordinates follow WOMD: x east, y north, z up (the sim's three.js z is south, so `y = -z`).

- **Accident labels**: WOMD has no accident labels, so they go in an extra `metadata.events` list. Each event has a time within the window and the track ids involved. The event types are:
  - `distracted_driver`, `red_light_violation`, `unsafe_lane_change` and `speeding` (with `over_limit`)
  - `collision`, with `kind` (`rear_end` / `t_bone` / `sideswipe` / `head_on` / `loss_of_control` / `chain`, worked out from the geometry of the impact), `cause` (the mistake behind it), `at_fault`, `rel_speed` and `elevated` (on the expressway)
  - `near_miss` with the AV, and `cleared`

  Cars involved in a collision are also added to `tracks_to_predict` with `difficulty: 2`. `sim.crash(kind)` causes one on demand.

Swap the baseline predictor from the browser console (or your own script):

```js
sim.setPredictor((agents) =>
  // agents: [{ id, ped, history: [{ x, z, h }, ...] }]  (sim frame: x east, z south, 10 Hz, oldest first)
  agents.map((a) => [
    // one entry per mode: probability + future points (t seconds ahead, world x/z)
    { prob: 1.0, traj: [{ t: 0.5, x: a.ped.pos.x, z: a.ped.pos.z }, /* ... up to ~4 s */] },
  ]),
);
sim.setPredictor(null); // back to the baseline
```

The AV yields when one guess with probability ≥ 0.3 crosses its path at about the time it gets there (or the pedestrian is already in its path), and also when several less likely guesses that cross add up to 0.3. So a model with many guesses doesn't have to put 0.3 on any single one.

The predictor runs every frame, so a remote model should be asynchronous. Keep the latest result in a cache and return it, and refresh it from your server in the background at about 10 Hz (`sim.observation()` gives the current frame in WOMD terms). Batch data generation works headlessly: `sim.advance(seconds)` steps the sim without rendering, then `sim.exportScenario()`.

The baseline (`src/sim/Predictor.js`) is intentionally simple. It has a constant-velocity mode, plus a "crossing" mode for pedestrians standing at a kerb facing the road, gated by the walk signal at signalised crossings. Hop pauses fool its velocity estimate, which is exactly the gap a learned model should close.

## Training your own pedestrian predictor

The whole loop runs on your laptop: make data with the sim, train it in PyTorch, then let the AV drive with the result.

```bash
npm run dataset -- --seeds 1-8 --minutes 5       # ~220k labelled samples in data/peds
pip install -r ml/requirements.txt              # numpy + torch
python ml/train_ped_predictor.py                # trains, scores it against the baseline, writes public/models/ped_mlp.json
npm run evaluate -- --seeds 101-108             # the AV drives the same seeds with each predictor
```

Then open `http://localhost:5173/?model=models/ped_mlp.json` and press **M** to switch between the baseline and your model.

- **Reproducible runs.** Everything random in the simulation comes from one seeded stream (`src/sim/Random.js`), and the sim steps at a fixed 1/60 s. So `?seed=42` replays the same traffic, pedestrians and incidents until you press J, X or 1–7. The headless tools are deterministic per seed too. (Replays are exact within one JS engine; Safari and Node round some maths slightly differently.)
- **Headless.** `tools/headless` runs the same simulation code in plain Node, about 15× faster than real time, one process per seed.
- **The data** (`tools/headless/export-dataset.mjs`). Once a second, every pedestrian on the streets becomes a sample:
  - the 78 inputs from `src/sim/PedFeatures.js`: 1 s of motion, the nearest kerbs, the crosswalk and its walk light, and the 4 nearest cars, all in the pedestrian's own frame
  - where it really was over the next 4 s
  - the baseline's guesses, for comparison
  - labels a real AV couldn't see: walker or hopper, its state (`jaywait` = about to jaywalk) and whether it steps into the road

  The arrays are `.npy` files, and `info.json` lists the columns. `--womd 30` also saves a full WOMD-style scene every 30 s, which now includes `sim_labels` on pedestrian tracks and the walk-light states.
- **The model** (`ml/train_ped_predictor.py`). An MLP predicts 6 possible 4-second paths with a probability each, trained winner-takes-all. Pedestrians on the road, at a crossing or about to step out count 5× in the loss (`--focus 4`), because they're rare but they're the ones that matter. It's validated on seeds it never saw and compared with the baseline on the same pedestrians: overall, and for hoppers, people waiting at a crossing, about to jaywalk, jaywalking and stepping into the road. The weights are exported as JSON and run in plain JavaScript (`src/sim/LearnedPredictor.js`), so the browser needs no ML library and the build still works on GitHub Pages.
- **Closed loop** (`tools/headless/evaluate.mjs`). Offline scores say how well a model guesses; this says whether the AV drives better with it. It reports pedestrian collisions, close calls, time spent yielding, hard braking and average speed for the baseline and your model on the same seeds.
- **When you change the inputs**, edit `PedFeatures.js`, bump `FEATURE_VERSION`, export the data again and retrain. The sim refuses a model trained on different inputs.

The features and the model are kept small so the pipeline is easy to follow. Ideas to try next: a GRU or Transformer over the history, more cars or the AV's planned path as inputs, a different `--focus`, or pretraining on real WOMD pedestrians. Watch the closed-loop numbers as well as the offline ones: a model that's more accurate on average can still yield later to the rare jaywalker.

## MagicaVoxel workflow

All assets live in `public/assets/vox/` and are listed in `public/assets/manifest.json` (voxel size, material tags):

| Folder | What | Voxel size |
| --- | --- | --- |
| `cars/` | 7 road cars modelled from `cars_design/`, plus 6 open-wheel formula cars in different colour schemes (`body` + `wheel_FL/FR/RL/RR` parts). Keys 1–7 pick a road car for the AV, F cycles through the formula cars | 0.075 m |
| `npcs/` | your 6 hand-made NPCs (copied from `npcs/`) + 5 new ones (courier, worker, elder, jogger, kid) | 0.036 m |
| `props/` | lamps, signals, ped signals, trees, cones, barriers, gantry, viaduct / flyover / ramp piers, warning triangle, bus shelter, AV roof kit… | 0.04–0.25 m |
| `buildings/` | red-roof slabs, residential towers, glass offices, shop rows (stored as hollow shells) | 0.5 m |

- **Open any `.vox` in MagicaVoxel**, edit it and save. The sim and the garage load the file directly, so a browser refresh shows the change.
- The generated assets come from Python scripts in `tools/voxgen/` (`cars.py`, `npcs.py`, `props.py`; numpy only). `npm run assets` regenerates everything; `python3 tools/voxgen/build_all.py cars:retro_panda_coupe` regenerates one. **Regenerating overwrites hand edits** to that file, so after editing a generated car in MagicaVoxel, add its name to `HAND_EDITED` in `tools/voxgen/build_all.py` (the panda coupe is already there): `npm run assets` then leaves it alone, and only naming it explicitly regenerates it. If you change its size, update its `length`/`width` in `manifest.json` by hand. Your files in `npcs/` are only ever copied.
- Conventions (same as your NPCs): Z up, models face **−Y**. Cars keep wheels as separate parts so they spin and steer. NPCs use 10 parts (`head`, `body`, `arm_upper/lower_R/L`, `leg_upper/lower_R/L`), which `src/sim/NpcRig.js` turns into a jointed skeleton for walk, run, wait and hop animations.
- Materials: MagicaVoxel **glass** and **emissive** materials (MATL) are honoured. Brake lights, headlights and signal lamps are palette indices tagged in the manifest (`brake`, `head`, `sig_red/yellow/green`, `ped_walk/stop`), so the sim can switch them.

## Code map

```
src/
  vox/VoxParser.js     .vox parser (v150/200, scene graph, MATL)
  vox/VoxMesher.js     greedy mesher with baked ambient occlusion, glass/emissive groups, exterior flood fill
  vox/VoxAssets.js     asset cache, instancing, 2x-downsampled LOD meshes
  world/RoadNetwork.js layout, lane graph (two expressway levels, curved ramps, loop ramps), signals, crosswalks, sidewalk graph (WOMD-like)
  world/WorldBuilder.js roads, markings, sidewalks, viaduct + flyover decks, ramp decks with tapers and gores, props and buildings (chunked + LOD)
  sim/Traffic.js       vehicles: IDM, signals, yielding, lane changes / merging
  sim/Pedestrians.js   walking, signalised crossing, jaywalking, hopping (never into a car that cannot stop)
  sim/Incidents.js     driver mistakes, crash detection + impulse physics, wrecks, debris, accident events
  sim/Predictor.js     10 Hz history + baseline pedestrian predictor (swap for your model)
  sim/EgoPlanner.js    AV route, lane choice, prediction-aware yielding, visualisation
  sim/Recorder.js      WOMD-style scenario export (+ pedestrian style/state labels, walk lights)
  sim/Simulation.js    builds and steps the whole simulation (browser and headless)
  sim/Random.js        the seeded random stream (?seed=)
  sim/PedFeatures.js   inputs for a learned pedestrian predictor (shared by export and inference)
  sim/LearnedPredictor.js  runs a model trained with ml/train_ped_predictor.py in the sim
  ui/Hud.js, main.js   HUD, minimap, cameras, night mode
tools/voxgen/          Python generators that write the .vox files + manifest
tools/headless/        the sim in plain Node: dataset export, closed-loop evaluation
ml/                    PyTorch training script for the pedestrian predictor
```

`npm run build` produces a static site in `dist/` (relative paths, so it can be hosted on GitHub Pages).

## Credits

- The car designs are voxel re-creations of the reference renders in `cars_design/` by the voxel artist **@FENRATE**. The real-world car designs belong to their manufacturers. If you publish this project, credit the artist. The reference images are only shown in the local garage and are not part of `npm run build`. They're also kept out of git (see `.gitignore`).
- The NPCs in `npcs/` are your own designs. The road reference photo (`road/`) is a stock image used only as visual reference, and is kept out of git too.
