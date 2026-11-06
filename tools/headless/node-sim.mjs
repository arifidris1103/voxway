// Runs the simulation in plain Node - no browser, no rendering - for the dataset exporter and
// the evaluator. Same code as the browser app (src/sim/Simulation.js); the .vox assets are read
// straight from public/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC = path.join(ROOT, 'public');

// fetch() for the asset loader: '/assets/...' is served from public/assets/...
const webFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (/^[a-z]+:/i.test(u)) return webFetch(url, opts);
  const buf = await fs.readFile(path.join(PUBLIC, decodeURIComponent(u.replace(/^\.?\//, ''))));
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(buf.toString('utf8')),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

export const { createSimulation, STEP } = await import('../../src/sim/Simulation.js');
