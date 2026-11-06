// Small helpers shared by the headless tools: command-line options, seed lists, .npy writing and
// a process pool (one simulation per process, so seeds run in parallel on all cores).

import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';

/** "1-4,9" -> [1, 2, 3, 4, 9] */
export function parseSeeds(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (Number.isFinite(b)) for (let s = a; s <= b; s++) out.push(s);
    else if (Number.isFinite(a)) out.push(a);
  }
  return out;
}

/** `--key value`, `--key=value` and `--flag` options; numbers where the default is a number. */
export function parseArgs(argv, defaults) {
  const o = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const key = m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
    let v = m[2];
    if (v === undefined) v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[key] = typeof defaults[key] === 'number' ? Number(v) : v;
  }
  return o;
}

/** Write a float32 array as a NumPy .npy file (np.load reads it). */
export function writeNpy(file, data, shape) {
  const f32 = data instanceof Float32Array ? data : Float32Array.from(data);
  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const total = Math.ceil((10 + dict.length + 1) / 64) * 64;          // header padded to 64 bytes
  const header = dict + ' '.repeat(total - 10 - dict.length - 1) + '\n';
  const buf = Buffer.alloc(total + f32.byteLength);
  buf.write('\x93NUMPY', 0, 'latin1');
  buf[6] = 1;
  buf[7] = 0;
  buf.writeUInt16LE(total - 10, 8);
  buf.write(header, 10, 'latin1');
  Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).copy(buf, total);
  fs.writeFileSync(file, buf);
}

/**
 * Run `script` once per task in child processes, `jobs` at a time. Each child gets its task as
 * JSON in argv (`--task {...}`) and may process.send() messages, passed to onMessage.
 */
export function runPool(script, tasks, jobs, onMessage) {
  jobs = Math.max(1, Math.min(jobs || Math.min(4, os.cpus().length - 1), tasks.length));   // ~300 MB each
  let next = 0, running = 0, failed = 0;
  return new Promise((resolve) => {
    const launch = () => {
      if (next >= tasks.length && running === 0) { resolve(failed); return; }
      while (running < jobs && next < tasks.length) {
        const task = tasks[next++];
        running++;
        const child = fork(script, ['--task', JSON.stringify(task)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.on('message', (m) => onMessage && onMessage(m, task));
        child.on('exit', (code) => {
          if (code) { failed++; console.error(`task ${JSON.stringify(task)} failed (exit ${code})`); }
          running--;
          launch();
        });
      }
    };
    launch();
  });
}

/** The task a child process was started with (see runPool), or null in the parent. */
export function childTask(argv = process.argv) {
  const i = argv.indexOf('--task');
  return i >= 0 ? JSON.parse(argv[i + 1]) : null;
}
