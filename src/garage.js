// Voxel Garage: inspect any .vox asset at the same camera angles as the reference renders.
//   /garage.html?asset=cars/retro_panda_coupe&view=both

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadManifest, loadAsset } from './vox/VoxAssets.js';
import { Npc } from './sim/NpcRig.js';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const label = document.getElementById('label');
const refPane = document.getElementById('ref');

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const bg = new THREE.Color('#' + (params.get('bg') || 'b9b9bb'));
scene.background = bg;
document.documentElement.style.setProperty('--bg', '#' + bg.getHexString());
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
sun.shadow.camera.right = sun.shadow.camera.top = 6;
sun.shadow.radius = 6;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.32 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camA = new THREE.PerspectiveCamera(18, 1, 0.05, 500);
const camB = new THREE.PerspectiveCamera(18, 1, 0.05, 500);
const controls = new OrbitControls(camA, renderer.domElement);
controls.enableDamping = true;

let view = params.get('view') || 'both';
let current = null;
let npc = null;
let radius = 3;
let center = new THREE.Vector3();

// Azimuth from +Z (car front) towards +X (car's left side), elevation in degrees.
// Front/rear match the reference renders: a fairly close camera (about 2x the
// car's length away) with a ~32 deg horizontal field of view, so the near wheel
// reads noticeably larger than the far one.
const num = (k, d) => (params.has(k) ? +params.get(k) : d);
const VIEWS = {
  front: [num('az', 42), num('el', 24)],
  rear: [222, 24],
  side: [90, 4],
  top: [90, 88],
};
let span = 4;   // longest horizontal extent of the asset, metres

function place(cam, [az, el]) {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  let d;
  if (view === 'side' || view === 'top' || view === 'orbit' || !current || npc) {
    d = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * num('zoom', 0.9);
  } else {
    const hfov = THREE.MathUtils.degToRad(num('hfov', 22));
    cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / cam.aspect));
    cam.updateProjectionMatrix();
    d = span * num('dist', 3.0);
  }
  cam.position.set(center.x + d * Math.cos(e) * Math.sin(a), center.y + d * Math.sin(e), center.z + d * Math.cos(e) * Math.cos(a));
  cam.lookAt(center);
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
}
addEventListener('resize', resize);

async function show(key) {
  if (current) scene.remove(current);
  npc = null;
  const asset = await loadAsset(key);
  if (asset.meta.category === 'npc') {
    npc = new Npc(asset);
    current = npc.root;
  } else {
    current = asset.instantiate();
  }
  scene.add(current);
  const box = new THREE.Box3().setFromObject(current);
  box.getCenter(center);
  const size = box.getSize(new THREE.Vector3());
  radius = size.length() / 2;
  span = Math.max(size.x, size.z);
  const s = Math.max(radius, 1);
  sun.position.set(center.x + s * 2.2, center.y + s * 4, center.z + s * 3);
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -s * 1.6;
  sc.right = sc.top = s * 1.6;
  sc.far = s * 12;
  sc.updateProjectionMatrix();
  controls.target.copy(center);
  // Each reference render was shot from a slightly different angle.
  const [az, el] = asset.meta.refView || [42, 24];
  VIEWS.front = [num('az', az), num('el', el)];
  VIEWS.rear = [180 + num('az', az), num('el', el)];
  place(camA, VIEWS.front);
  label.textContent = `${asset.meta.label || key}  ·  ${asset.parts.length} parts  ·  ${(asset.bounds.max.z - asset.bounds.min.z).toFixed(2)} m`;
  const showRef = !!asset.meta.ref && params.get('ref') !== '0';
  refPane.classList.toggle('on', showRef);
  document.getElementById('app').classList.toggle('withref', showRef);
  if (showRef) {
    const img = refPane.querySelector('img');
    // reference renders live in /cars_design (dev only); hide the pane if absent
    img.onerror = () => { refPane.classList.remove('on'); document.getElementById('app').classList.remove('withref'); requestAnimationFrame(resize); };
    img.src = asset.meta.ref.replace(/^\//, '');
  }
  requestAnimationFrame(resize);
  for (const b of document.querySelectorAll('#list button')) b.classList.toggle('on', b.dataset.key === key);
  params.set('asset', key);
  history.replaceState(null, '', '?' + params);
}

function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === v);
  if (VIEWS[v]) place(camA, VIEWS[v]);
  params.set('view', v);
  history.replaceState(null, '', '?' + params);
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const w = stage.clientWidth, h = stage.clientHeight;
  if (npc) npc.update(dt, params.get('anim') || 'idle');
  if (view === 'both') {
    renderer.setScissorTest(true);
    const hh = h / 2, vw = Math.min(w, hh * 1.54), x0 = (w - vw) / 2;
    for (const [cam, v, y] of [[camA, VIEWS.front, hh], [camB, VIEWS.rear, 0]]) {
      cam.aspect = vw / hh;
      cam.updateProjectionMatrix();
      place(cam, v);
      renderer.setViewport(x0, y, vw, hh);
      renderer.setScissor(x0, y, vw, hh);
      renderer.render(scene, cam);
    }
    renderer.setScissorTest(false);
  } else {
    camA.aspect = w / h;
    camA.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, h);
    if (view === 'orbit') controls.update();
    else place(camA, VIEWS[view]);
    renderer.render(scene, camA);
  }
}

async function init() {
  const manifest = await loadManifest();
  const views = document.getElementById('views');
  for (const v of ['both', 'front', 'rear', 'side', 'top', 'orbit']) {
    const b = document.createElement('button');
    b.textContent = v;
    b.dataset.view = v;
    b.onclick = () => setView(v);
    views.append(b);
  }
  const list = document.getElementById('list');
  const groups = {};
  for (const [k, m] of Object.entries(manifest)) (groups[m.category] ||= []).push([k, m]);
  const order = ['car', 'npc', 'prop', 'building'];
  for (const [cat, items] of Object.entries(groups).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))) {
    const h = document.createElement('h2');
    h.textContent = cat;
    list.append(h);
    for (const [k, m] of items.sort((a, b) => (a[1].label || a[0]).localeCompare(b[1].label || b[0]))) {
      const b = document.createElement('button');
      b.textContent = m.label || k;
      b.dataset.key = k;
      b.onclick = () => show(k);
      list.append(b);
    }
  }
  setView(view);
  resize();
  await show(params.get('asset') || Object.keys(manifest)[0]);
  frame();
}

init();
