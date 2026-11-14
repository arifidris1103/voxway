// DOM overlay: AV status, decision badge, safety counters and a minimap.

import { LAYOUT, roadHalfWidth } from '../world/RoadNetwork.js';

const BADGE = {
  CRUISE: '#34e3a0', FOLLOW: '#7cc4ff', TURN: '#7cc4ff', MERGE: '#ffb02e', CAUTION: '#ffb02e',
  YIELD: '#ff5a3c', 'STOP · SIGNAL': '#ff5a3c', 'AVOID · CRASH': '#c061ff', 'GIVE WAY': '#ffb02e',
  PAUSED: '#ffc62e',
};

const group = (title, rows) => `<div class="group"><h3>${title}</h3>${rows.map(([k, v, cls]) =>
  `<div class="stat${cls ? ' ' + cls : ''}"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;

export class Hud {
  constructor(root) {
    this.el = {
      speed: root.querySelector('#speed'),
      state: root.querySelector('#state'),
      reason: root.querySelector('#reason'),
      target: root.querySelector('#target'),
      stats: root.querySelector('#stats'),
      cam: root.querySelector('#cam'),
      predictor: root.querySelector('#predictor'),
      toast: root.querySelector('#toast'),
      car: root.querySelector('#car'),
      seed: root.querySelector('#seed'),
    };
    this.map = root.querySelector('#minimap');
    this.ctx = this.map.getContext('2d');
    this.mapClock = 0;
    this.toastTimer = 0;
  }

  toast(msg) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('on');
    this.toastTimer = 2.6;
  }

  update(dt, { ego, planner, traffic, peds, camMode, carLabel, paused, seed }) {
    this.ramps = traffic.net.ramps;
    this.el.speed.textContent = Math.round(ego.v * 3.6);
    const st = paused ? 'PAUSED' : planner.state;
    this.el.state.textContent = st;
    this.el.state.style.setProperty('--badge', BADGE[st] || '#8a93a0');
    this.el.reason.textContent = paused ? 'esc or space to resume' : (ego.reason || '') + (ego.pose.y > 2 ? ` · expressway, ${Math.round(ego.pose.y)} m up` : '');
    const t = planner.target;
    if (t) {
      const ttc = t.d / Math.max(ego.v, 0.5);
      this.el.target.innerHTML = `<b>Pedestrian #${t.ped.id}</b> · ${t.ped.style} · conflict in ${t.d.toFixed(0)} m · p=${t.prob.toFixed(2)}${ego.v > 0.5 ? ` · TTC ${ttc.toFixed(1)} s` : ''}`;
      this.el.target.classList.add('on');
    } else this.el.target.classList.remove('on');
    const S = planner.stats;
    const html = group('Safety', [
      ['Pedestrian yields', S.pedYields],
      ['Closest pedestrian (AV moving)', isFinite(S.minPedGap) ? Math.max(0, S.minPedGap).toFixed(1) + ' m' : '—'],
      ['Pedestrian collisions', S.collisions, S.collisions > 0 ? 'bad' : ''],
      ['Jaywalkers seen', peds.stats.jaywalks],
    ]) + group('Traffic', [
      ['Signal stops', S.redStops],
      ['Merges', S.merges],
      ['Traffic accidents', traffic.incidents ? traffic.incidents.stats.collisions : 0],
      ['AV crash detours / re-routes', `${S.crashScenes} / ${S.reroutes}`],
    ]) + group('Trip', [
      ['Distance', (S.distance / 1000).toFixed(2) + ' km'],
      ['Agents', `${traffic.vehicles.length} cars · ${peds.peds.length} peds`],
    ]);
    if (html !== this.statsHtml) { this.el.stats.innerHTML = html; this.statsHtml = html; }
    this.el.cam.textContent = camMode;
    this.el.car.textContent = carLabel;
    if (this.el.seed) this.el.seed.textContent = seed ?? '—';
    this.el.predictor.textContent = planner.custom ? planner.customName || 'custom model' : planner.predictor.name;
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('on');
    }
    this.mapClock -= dt;
    if (this.mapClock <= 0) { this.mapClock = 0.1; this.drawMap(ego, planner, traffic, peds); }
  }

  drawMap(ego, planner, traffic, peds) {
    const c = this.ctx, W = this.map.width, H = this.map.height;
    const R = 260, k = W / (2 * R);                      // follows the AV
    const X = (x) => (x - ego.pose.x + R) * k, Z = (z) => (z - ego.pose.z + R) * k;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#161d28';
    c.fillRect(0, 0, W, H);
    c.fillStyle = '#3a414c';
    for (const a of LAYOUT.avenues) { const hw = roadHalfWidth(a); c.fillRect(X(a.x - hw), 0, hw * 2 * k, H); }
    for (const s of LAYOUT.streets) { const hw = roadHalfWidth(s); c.fillRect(0, Z(s.z - hw), W, hw * 2 * k); }
    const V = LAYOUT.viaduct, F = LAYOUT.flyover;
    c.fillStyle = 'rgba(79,179,162,0.55)';
    c.fillRect(X(V.x - V.halfWidth), 0, V.halfWidth * 2 * k, H);
    c.fillStyle = 'rgba(120,214,198,0.65)';
    c.fillRect(0, Z(F.z - F.halfWidth), W, F.halfWidth * 2 * k);
    c.strokeStyle = 'rgba(120,214,198,0.75)';
    c.lineWidth = F.rampHalfWidth * 2 * k;
    for (const r of this.ramps || []) {
      c.beginPath();
      r.pts.forEach((p, i) => (i ? c.lineTo(X(p.x), Z(p.z)) : c.moveTo(X(p.x), Z(p.z))));
      c.stroke();
    }
    c.fillStyle = '#c7ced8';
    for (const v of traffic.vehicles) {
      if (v.isEgo) continue;
      c.fillStyle = v.wreck ? '#c061ff' : '#c7ced8';
      const r = v.wreck ? 2.6 : 1.2;
      c.fillRect(X(v.pose.x) - r, Z(v.pose.z) - r, r * 2, r * 2);
    }
    for (const p of peds.peds) {
      c.fillStyle = p.state === 'jaycross' || p.state === 'jaywait' ? '#ff5a3c' : '#ffb02e';
      c.fillRect(X(p.pos.x) - 1, Z(p.pos.z) - 1, 2, 2);
    }
    if (planner.target) {
      const p = planner.target.ped;
      c.strokeStyle = '#ff5a3c';
      c.lineWidth = 1.5;
      c.beginPath(); c.arc(X(p.pos.x), Z(p.pos.z), 5, 0, Math.PI * 2); c.stroke();
    }
    // ego arrow
    const h = ego.pose.heading;
    c.save();
    c.translate(X(ego.pose.x), Z(ego.pose.z));
    c.rotate(-h);
    c.fillStyle = '#ffc62e';                            // VOXWAY yellow, outlined in ink
    c.strokeStyle = '#141a23';
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.beginPath(); c.moveTo(0, 8); c.lineTo(-5.5, -5); c.lineTo(5.5, -5); c.closePath(); c.stroke(); c.fill();
    c.restore();
  }
}
