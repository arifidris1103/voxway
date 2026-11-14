// Pause menu: every control, a little voxel keyboard showing where each key is, Resume and the garage.
// The control list below is the one place the key bindings are described (main.js handles them).

export const CONTROLS = [
  { group: 'View', items: [
    { keys: ['C'], label: 'Switch camera (7 views)' },
    { keys: ['N'], label: 'Day / night' },
    { keys: ['P'], label: 'Show the AV\'s predictions' },
  ] },
  { group: 'AV car', items: [
    { keys: ['1', '7'], range: true, label: 'Pick a road car' },
    { keys: ['F'], label: 'Formula car (next livery)' },
  ] },
  { group: 'Scenarios', items: [
    { keys: ['J'], label: 'Send a jaywalker' },
    { keys: ['X'], label: 'Cause an accident' },
  ] },
  { group: 'Sim & data', items: [
    { keys: ['Esc', 'Space'], label: 'Pause / resume' },
    { keys: ['R'], label: 'Export a WOMD scenario' },
    { keys: ['M'], label: 'Baseline / your model' },
  ] },
  { group: 'Mouse · free camera (press C until it says free)', mouse: true, items: [
    { mouse: 'Drag', label: 'Orbit' },
    { mouse: 'Right-drag', label: 'Pan' },
    { mouse: 'Scroll', label: 'Zoom' },
  ] },
];

const KEYBOARD = [
  ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ['Space'],
];

/** The keyboard keys a control uses ("1" to "7" for a range). */
function keysOf(item) {
  if (!item.keys) return [];
  if (!item.range) return item.keys;
  const [a, b] = item.keys.map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
}

const cap = (k, cls = 'vx-white') => `<kbd class="vx sm ${cls}">${k}</kbd>`;

export class PauseMenu {
  constructor(root, { onResume }) {
    this.el = root.querySelector('#menu');
    this.kb = root.querySelector('#kb');
    this.list = root.querySelector('#controls');
    this.mouse = root.querySelector('#mouse');
    this.build();
    root.querySelector('#resume').addEventListener('click', (e) => { e.currentTarget.blur(); onResume(); });
  }

  build() {
    const used = new Set(CONTROLS.flatMap((g) => g.items.flatMap(keysOf)));
    this.kb.innerHTML = KEYBOARD.map((row) => `<div class="kb-row">${row.map((k) =>
      `<div class="key vx${used.has(k) ? ' used' : ''}${k === 'Space' ? ' space' : ''}" data-k="${k}">${k}</div>`).join('')}</div>`).join('');
    const groups = (list) => list.map((g) => `<div class="ctl-group"><h3>${g.group}</h3>${g.items.map((it) => {
      const keys = it.mouse ? cap(it.mouse, '')
        : it.range ? `${cap(it.keys[0])}<span>to</span>${cap(it.keys[1])}`
          : it.keys.map((k) => cap(k)).join('<span>or</span>');
      return `<div class="ctl" data-keys="${keysOf(it).join(' ')}"><span>${it.label}</span><div class="keys">${keys}</div></div>`;
    }).join('')}</div>`).join('');
    this.list.innerHTML = groups(CONTROLS.filter((g) => !g.mouse));
    this.mouse.innerHTML = groups(CONTROLS.filter((g) => g.mouse));

    // hover a control to light up its keys on the keyboard, or a key to find its control
    const light = (keys, on) => {
      for (const k of keys) this.kb.querySelector(`[data-k="${k}"]`)?.classList.toggle('hot', on);
      for (const row of this.el.querySelectorAll('.ctl')) {
        if (row.dataset.keys && keys.some((k) => row.dataset.keys.split(' ').includes(k))) row.classList.toggle('hot', on);
      }
    };
    for (const row of this.el.querySelectorAll('.ctl')) {
      const keys = row.dataset.keys ? row.dataset.keys.split(' ') : [];
      row.addEventListener('mouseenter', () => light(keys, true));
      row.addEventListener('mouseleave', () => light(keys, false));
    }
    for (const key of this.kb.querySelectorAll('.key.used')) {
      key.addEventListener('mouseenter', () => light([key.dataset.k], true));
      key.addEventListener('mouseleave', () => light([key.dataset.k], false));
    }
  }

  show(on) {
    this.el.hidden = !on;
    document.body.classList.toggle('paused', on);
  }
}
