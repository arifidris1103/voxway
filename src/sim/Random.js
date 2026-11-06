// One seeded random stream for everything the simulation decides: traffic, pedestrians,
// incidents and the AV's scenario director. With the same seed and the same fixed time step a
// run replays exactly (in the same JS engine - browsers round some maths functions slightly
// differently), so a scene can be watched with the baseline predictor and then with a trained one.

let state = 1;
let current = 1;

/** Restart the stream. Any integer works; 0 / missing picks a random seed. Returns the seed used. */
export function seedRandom(seed) {
  let s = Math.floor(Number(seed)) >>> 0;
  if (!s) s = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
  state = s;
  current = s;
  return s;
}

/** The seed the stream was last started from. */
export const currentSeed = () => current;

/** Uniform number in [0, 1) (mulberry32). Use instead of Math.random() anywhere in the sim. */
export function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** In-place Fisher-Yates shuffle with the seeded stream. */
export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
