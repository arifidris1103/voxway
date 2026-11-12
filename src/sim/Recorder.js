// Records the simulation at 10 Hz and exports it with the field names and enum
// values of the Waymo Open Motion Dataset `Scenario` proto (scenario.proto), so a
// model trained on WOMD can be evaluated on simulator scenes with the same
// preprocessing. 91 steps = 1.1 s history + current + 8 s future.
//
// Frames: WOMD uses x = east, y = north, z = up. The simulator uses three.js axes
// (x = east, y = up, z = south), so y_womd = -z_sim.

const TYPE = { vehicle: 1, pedestrian: 2 };          // ObjectType
const LANE_TYPE = { road: 2, connector: 2, viaduct: 1, ramp: 1 }; // TYPE_SURFACE_STREET / TYPE_FREEWAY
// TrafficSignalLaneState.State
const STATE = { arrow: { 0: 1, 1: 2, 2: 3 }, plain: { 0: 4, 1: 5, 2: 6 } };

export class ScenarioRecorder {
  constructor(net, { steps = 91 } = {}) {
    this.net = net;
    this.steps = steps;
    this.frames = [];
    this.acc = 0;
    this.time = 0;
  }

  update(dt, ego, traffic, peds) {
    this.time += dt;
    this.acc += dt;
    if (this.acc < 0.1 - 1e-6) return;      // 10 Hz, without float drift
    this.acc -= 0.1;
    this.frames.push(this.snapshot(ego, traffic, peds));
    if (this.frames.length > this.steps) this.frames.shift();
  }

  snapshot(ego, traffic, peds) {
    const agents = [];
    const veh = (v) => ({
      id: v.isEgo ? 0 : 100000 + v.id, type: TYPE.vehicle,
      x: v.pose.x, y: -v.pose.z, z: v.pose.y + v.height / 2,
      length: v.length, width: v.width, height: v.height,
      heading: Math.atan2(-Math.cos(v.pose.heading), Math.sin(v.pose.heading)),
      vx: v.pose.vx, vy: -v.pose.vz,
    });
    for (const v of traffic.vehicles) agents.push(veh(v));
    for (const p of peds.peds) {
      agents.push({
        id: 200000 + p.id, type: TYPE.pedestrian,
        x: p.pos.x, y: -p.pos.z, z: p.y + p.height / 2,
        length: p.length, width: p.width, height: p.height,
        heading: Math.atan2(-Math.cos(p.heading), Math.sin(p.heading)),
        vx: p.vel.x, vy: -p.vel.z,
        style: p.style, state: p.state,
      });
    }
    const signals = [];
    for (const l of this.net.lanes) {
      if (!l.signal) continue;
      const sig = l.signal.inter.signal;
      const st = sig.state(l.signal.group);
      const p0 = l.pts[0];
      // a left turn lane follows its arrow during the arrow phase, otherwise the road's plain
      // light (green there = permissive: go when there is a gap)
      const state = l.movement !== 'left' ? STATE.plain[st] : st !== 0 ? STATE.arrow[st] : STATE.plain[sig.state(l.signal.group.replace(/L$/, ''))];
      signals.push({ lane: l.id, state, stop_point: { x: p0.x, y: -p0.z, z: l.y } });
    }
    // pedestrian walk lights (not in WOMD; 0 = don't walk, 1 = flashing, 2 = walk)
    const walks = this.net.crosswalks.map((c) => ({ crosswalk: 50000 + c.id, walk: c.walk() }));
    return { t: this.time, agents, signals, walks, ego: ego ? { x: ego.pose.x, y: -ego.pose.z } : null };
  }

  /** Current observation in WOMD terms (useful for online inference). */
  observation() { return this.frames[this.frames.length - 1] || null; }

  mapFeatures() {
    const out = [];
    for (const l of this.net.lanes) {
      out.push({
        id: l.id,
        lane: {
          speed_limit_mph: +(l.speed * 2.23694).toFixed(1),
          type: LANE_TYPE[l.kind],
          polyline: l.pts.map((p, i) => ({ x: p.x, y: -p.z, z: l.yProfile ? l.yProfile(l.cum[i] / l.length) : l.y })),
          entry_lanes: l.prev.map((x) => x.id),
          exit_lanes: l.next.map((x) => x.id),
          interpolating: l.kind === 'connector',
        },
      });
    }
    for (const c of this.net.crosswalks) {
      const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: c.cx + a * c.hx, y: -(c.cz + b * c.hz), z: 0 }));
      out.push({ id: 50000 + c.id, crosswalk: { polygon: poly } });
    }
    return out;
  }

  /** Build a WOMD-style Scenario object from the recorded window. */
  exportScenario() {
    const F = this.frames;
    if (!F.length) return null;
    const ids = new Map();
    for (const f of F) for (const a of f.agents) if (!ids.has(a.id)) ids.set(a.id, a.type);
    const tracks = [];
    const order = [...ids.keys()].sort((a, b) => a - b);  // ego (id 0) first
    for (const id of order) {
      const states = F.map((f) => {
        const a = f.agents.find((q) => q.id === id);
        return a
          ? { center_x: a.x, center_y: a.y, center_z: a.z, length: a.length, width: a.width, height: a.height,
              heading: a.heading, velocity_x: a.vx, velocity_y: a.vy, valid: true }
          : { center_x: 0, center_y: 0, center_z: 0, length: 0, width: 0, height: 0, heading: 0, velocity_x: 0, velocity_y: 0, valid: false };
      });
      const track = { id, object_type: ids.get(id), states };
      if (ids.get(id) === TYPE.pedestrian) {
        // labels the simulator knows but a real AV can't see (not in WOMD): the pedestrian's
        // style ('walker' or 'hopper') and what it is doing at each step ('walk', 'wait' at a
        // crossing, 'cross', 'jaywait' = about to jaywalk, 'jaycross', 'idle', 'watch', 'park', 'work')
        const seen = F.map((f) => f.agents.find((q) => q.id === id));
        track.sim_labels = { style: seen.find(Boolean).style, states: seen.map((a) => (a ? a.state : null)) };
      }
      tracks.push(track);
    }
    const cur = Math.min(10, F.length - 1);
    const egoNow = F[cur].ego;
    // pedestrians near the AV at the current step are the prediction targets
    const toPredict = [];
    tracks.forEach((t, i) => {
      const s = t.states[cur];
      if (t.object_type === TYPE.pedestrian && s.valid && egoNow &&
          Math.hypot(s.center_x - egoNow.x, s.center_y - egoNow.y) < 40 && toPredict.length < 8) {
        toPredict.push({ track_index: i, difficulty: 0 });
      }
    });
    // labelled incidents inside the window (not part of WOMD: extra metadata)
    const t0 = F[0].t, t1 = F[F.length - 1].t;
    const tid = (id) => 100000 + id;
    const events = (this.incidents ? this.incidents.events : [])
      .filter((e) => e.t >= t0 - 0.05 && e.t <= t1 + 0.05)
      .map((e) => ({ ...e, t: +(e.t - t0).toFixed(2), track_ids: e.ids.map(tid), ids: undefined,
        at_fault: e.at_fault != null ? tid(e.at_fault) : undefined, x: e.x, y: -e.z, z: undefined }));
    for (const e of events) {
      if (e.type !== 'collision') continue;
      for (const id of e.track_ids) {
        const i = tracks.findIndex((t) => t.id === id);
        if (i >= 0 && !toPredict.some((p) => p.track_index === i)) toPredict.push({ track_index: i, difficulty: 2 });
      }
    }
    return {
      metadata: { simulator: 'voxel-av-sim', frame: 'x east, y north, z up (metres)', events },
      scenario_id: 'voxel-av-sim-' + new Date().toISOString().replace(/[:.]/g, '-'),
      timestamps_seconds: F.map((f) => +(f.t - F[0].t).toFixed(2)),
      current_time_index: cur,
      sdc_track_index: 0,
      tracks,
      tracks_to_predict: toPredict,
      objects_of_interest: toPredict.map((t) => tracks[t.track_index].id),
      dynamic_map_states: F.map((f) => ({ lane_states: f.signals, crosswalk_states: f.walks })),
      map_features: this.mapFeatures(),
    };
  }
}
