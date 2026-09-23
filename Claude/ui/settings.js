/**
 * settings.js — the settings model, its persistence, and the DOM that edits it.
 *
 * One object is the single source of truth. Controls are bound to it by id, so
 * adding a setting means adding a default here and an element with a matching
 * id in index.html — nothing else. Every change is validated against the same
 * schema used to sanitise what comes back out of localStorage, because saved
 * settings are the one input a user can trivially corrupt.
 */

import { PRESETS, TIER_ORDER, suggestPreset } from '../render/presets.js';

const STORAGE_KEY = 'apex.settings.v1';
const $ = id => document.getElementById(id);

export const DEFAULTS = {
  // graphics
  preset: suggestPreset(),
  renderScale: 0,          // 0 = follow the preset; >0 overrides it
  fov: 72,
  adaptiveRes: true,
  showFPS: false,
  opponentWheels: true,     // animate AI wheel steer/spin; off helps low-power devices
  timeOfDay: 'afternoon',
  weather: 'clear',
  // driving
  assistPreset: 'SPORT',
  tractionControl: 2,
  abs: true,
  stability: true,
  autoGears: true,
  racingLine: false,
  steeringSensitivity: 1,
  gripLevel: 1,
  suspension: true,
  carCollisions: false,     // off = cars pass through each other
  crashSideGrip: 75,        // % of a sideways shove the tyres absorb in a car-to-car hit
  frontWing: 6,
  rearWing: 6,
  brakeBias: 58,
  // controls
  camera: 'chase',
  chaseDistance: 7.5,
  cameraShake: true,
  invertLook: false,
  onScreenControls: 'auto',   // auto = show on touch devices
  // audio
  sound: true,
  volume: 70,
  engineVolume: 80,
  effectsVolume: 70,
};

/** Allowed values, used both for UI binding and for sanitising stored data. */
const SCHEMA = {
  preset: { enum: TIER_ORDER },
  renderScale: { range: [0.5, 1], step: 0.05, unit: '×', allowZero: true },
  fov: { range: [50, 105], unit: '°' },
  timeOfDay: { enum: ['noon', 'afternoon', 'sunset', 'night'] },
  weather: { enum: ['clear', 'cloudy', 'damp', 'wet'] },
  assistPreset: { enum: ['ARCADE', 'SPORT', 'PRO'] },
  tractionControl: { enum: [0, 1, 2], numeric: true },
  steeringSensitivity: { range: [0.4, 1.6], unit: '×' },
  gripLevel: { range: [0.5, 1.8], unit: '×' },
  crashSideGrip: { range: [0, 100], unit: '%' },
  onScreenControls: { enum: ['auto', 'always', 'never'] },
  frontWing: { range: [1, 11] },
  rearWing: { range: [1, 11] },
  brakeBias: { range: [50, 70], unit: '%' },
  camera: { enum: ['chase', 'close', 'tv', 'cockpit', 'halo', 'nose'] },
  chaseDistance: { range: [4, 14], unit: ' m' },
  volume: { range: [0, 100], unit: '%' },
  engineVolume: { range: [0, 100], unit: '%' },
  effectsVolume: { range: [0, 100], unit: '%' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function sanitise(key, value, fallback) {
  const rule = SCHEMA[key];
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  if (!rule) return value === undefined ? fallback : value;
  if (rule.enum) {
    const candidate = rule.numeric ? Number(value) : value;
    return rule.enum.includes(candidate) ? candidate : fallback;
  }
  if (rule.range) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (rule.allowZero && n === 0) return 0;
    return clamp(n, rule.range[0], rule.range[1]);
  }
  return value ?? fallback;
}

export function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* corrupt */ }
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    settings[key] = sanitise(key, stored[key], DEFAULTS[key]);
  }
  return settings;
}

export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

/**
 * Bind the settings dialog to a settings object.
 * @param settings  the live settings object (mutated in place)
 * @param onChange  called as (key, value, settings) after every committed edit
 */
export function createSettingsUI(settings, onChange) {
  const dialog = $('settings');

  /* ------------------------------------------------ the preset picker */
  // This is the headline control: the user asked for "realistic modes" with an
  // extremely realistic top mode, so each tier is a card that says in plain
  // English what it actually does and roughly what it costs.
  const picker = $('preset-picker');
  picker.replaceChildren(...TIER_ORDER.map(name => {
    const preset = PRESETS[name];
    const button = document.createElement('button');
    button.className = 'preset-option';
    button.dataset.preset = name;
    button.type = 'button';
    for (const [cls, text] of [['name', preset.label], ['desc', preset.blurb], ['cost', preset.cost]]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      button.append(span);
    }
    button.addEventListener('click', () => selectPreset(name));
    return button;
  }));

  const quick = $('preset-quick');
  quick.replaceChildren(...TIER_ORDER.map(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = PRESETS[name].label;
    return option;
  }));
  quick.addEventListener('change', () => selectPreset(quick.value));

  function selectPreset(name) {
    if (!TIER_ORDER.includes(name)) return;
    settings.preset = name;
    reflectPreset();
    commit('preset', name);
  }

  function reflectPreset() {
    for (const node of picker.children) {
      node.classList.toggle('selected', node.dataset.preset === settings.preset);
    }
    quick.value = settings.preset;
    // Only APEX carries an honesty note; showing a generic one everywhere would
    // train people to ignore it.
    const honesty = PRESETS[settings.preset].honesty;
    const panel = $('preset-honesty');
    panel.hidden = !honesty;
    panel.textContent = honesty ?? '';
  }

  /* ------------------------------------------------------ tab switching */
  const tabs = [...document.querySelectorAll('.tabs [data-tab]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) other.classList.toggle('selected', other === tab);
      for (const panel of panels) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  }

  /* --------------------------------------------------- generic binding */
  function label(key, value) {
    const output = $(`${key}-value`);
    if (!output) return;
    const rule = SCHEMA[key];
    if (key === 'renderScale' && value === 0) { output.textContent = 'Auto'; return; }
    output.textContent = `${value}${rule?.unit ?? ''}`;
  }

  function commit(key, value) {
    label(key, value);
    saveSettings(settings);
    onChange?.(key, value, settings);
  }

  for (const key of Object.keys(DEFAULTS)) {
    const node = $(key);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = settings[key];
    else node.value = settings[key];
    label(key, settings[key]);

    node.addEventListener(node.type === 'range' ? 'input' : 'change', () => {
      const raw = node.type === 'checkbox' ? node.checked : node.value;
      settings[key] = sanitise(key, raw, DEFAULTS[key]);
      // A range can be clamped by sanitise; write the accepted value back so the
      // control and the model can never disagree.
      if (node.type !== 'checkbox' && String(settings[key]) !== String(raw)) {
        node.value = settings[key];
      }
      commit(key, settings[key]);
    });
  }

  reflectPreset();

  /* ------------------------------------------------- assist ladder sync */
  // Choosing an assist preset moves the individual toggles, because the ladder
  // is only a shortcut for them — but touching a toggle afterwards leaves the
  // preset selector alone rather than fighting the user.
  const LADDER = {
    ARCADE: { tractionControl: 2, abs: true, stability: true, autoGears: true, gripLevel: 1.3 },
    SPORT:  { tractionControl: 1, abs: true, stability: false, autoGears: true, gripLevel: 1.0 },
    PRO:    { tractionControl: 0, abs: false, stability: false, autoGears: false, gripLevel: 0.85 },
  };
  $('assistPreset')?.addEventListener('change', event => {
    const ladder = LADDER[event.target.value];
    if (!ladder) return;
    for (const [key, value] of Object.entries(ladder)) {
      // Apply to the model whether or not a control for it is on screen. Most
      // of these no longer have their own widget — the ladder IS the interface
      // for them now — so the write must not depend on the DOM.
      settings[key] = value;
      const node = $(key);
      if (node) {
        if (node.type === 'checkbox') node.checked = value; else node.value = value;
      }
      label(key, value);
      onChange?.(key, value, settings);
    }
    saveSettings(settings);
  });

  return {
    open(inSession) {
      $('quit-session').hidden = !inSession;
      if (!dialog.open) dialog.showModal();
    },
    close() { if (dialog.open) dialog.close(); },
    get isOpen() { return dialog.open; },
    reflectPreset,
    dialog,
  };
}
