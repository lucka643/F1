/**
 * main.js — boot, state machine and the frame loop.
 *
 * Structure:
 *   boot()      one-time: renderer, physics world, circuit, car, subsystems
 *   menu        pick a mode, then startSession()
 *   session     the frame loop: fixed-step physics, then one render
 *   results     classification, then back to the menu
 *
 * The loop runs physics on a fixed 1/120 s accumulator and rendering on
 * whatever the display gives us. A racing car simulated on a variable timestep
 * changes its handling with your frame rate, which is unacceptable — so the
 * only thing allowed to vary is how many physics steps happen per frame.
 */

import * as THREE from 'three';
import RAPIER from 'rapier';

import { buildCircuit } from './circuit/build.js';
import { createVehicle } from './sim/vehicle.js';
import { createPipeline, detectCapabilities } from './render/pipeline.js';
import { loadCar, loadRivalCar } from './render/car.js';
import { createCameraRig, RIG_LABELS } from './render/camera.js';
import { PRESETS } from './render/presets.js';
import { createInput } from './game/input.js';
import { createTiming } from './game/timing.js';
import { createField } from './game/ai.js';
import { createAudio } from './game/audio.js';
import { createHUD, formatLapTime } from './ui/hud.js';
import { createSettingsUI, loadSettings, saveSettings } from './ui/settings.js';
import { VERSION } from './version.js';

const $ = id => document.getElementById(id);
const PHYSICS_STEP = 1 / 120;
const MAX_STEPS_PER_FRAME = 8;      // beyond this we accept slow-motion over a spiral

const settings = loadSettings();

// Stamp the build version everywhere it is shown, before anything can fail —
// so even a boot error tells you which build produced it.
for (const id of ['version', 'boot-version', 'menu-version']) {
  const node = document.getElementById(id);
  if (node) node.textContent = `v${VERSION}`;
}
console.info(`APEX v${VERSION}`);

/* ─────────────────────────────── boot ─────────────────────────────── */

function progress(fraction, message, detail) {
  $('boot-bar').style.width = `${Math.round(fraction * 100)}%`;
  if (message) $('boot-status').textContent = message;
  if (detail !== undefined) $('boot-detail').textContent = detail;
}

const game = {
  phase: 'boot',
  mode: 'race',
  frameIndex: 0,
  elapsed: 0,
  paused: false,
};

async function boot() {
  progress(0.02, 'Starting the renderer…');

  const canvas = $('viewport');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,              // the pipeline owns anti-aliasing
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const capabilities = detectCapabilities(renderer);
  const scene = new THREE.Scene();
  // Near plane is tight: in the halo view the hoop sits ~0.4 m from the eye and
  // must not be clipped away.
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 6000);

  progress(0.08, 'Starting the physics engine…');
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYSICS_STEP;
  world.integrationParameters.maxCcdSubsteps = 6;

  progress(0.18, 'Rebuilding the circuit…', 'Welding and stitching the original road mesh');
  const track = await buildCircuit(scene, world, RAPIER, {
    quality: PRESETS[settings.preset],
    renderer,
  });
  const circuit = track.circuit;
  progress(0.45, 'Circuit ready',
    `${(circuit.lapLength / 1000).toFixed(3)} km · ${track.corners.length} corners · ` +
    `${circuit.stats.triangles} triangles`);

  progress(0.50, 'Loading the RB19…');
  const car = await loadCar(renderer, {
    quality: PRESETS[settings.preset].car,
    onProgress: f => progress(0.50 + f * 0.22, 'Loading the RB19…'),
  });
  scene.add(car.root);

  // The opponents' cars: one model per team, loaded once and shared by every
  // car of that team. A model that fails to load is simply left out, and the
  // field falls back to a recoloured copy of the player's car for that team.
  progress(0.72, 'Loading the opposition…');
  const rivalAssets = new Map();
  const rivalFiles = ['ferrari-sf23.glb', 'mclaren-mcl60.glb',
    'aston-martin-amr23.glb', 'alpine-a523.glb', 'alphatauri-at04.glb'];
  await Promise.all(rivalFiles.map(async (file, i) => {
    try {
      const model = await loadRivalCar(renderer, new URL(`assets/cars/${file}`, import.meta.url).href,
        { name: file.replace('.glb', '') });
      rivalAssets.set(file, model);
    } catch (error) {
      console.warn(`Opponent car ${file} failed to load:`, error);
    }
    progress(0.72 + ((i + 1) / rivalFiles.length) * 0.02, 'Loading the opposition…');
  }));

  progress(0.74, 'Building the render pipeline…');
  const pipeline = createPipeline(renderer, scene, camera, { capabilities });
  pipeline.setPreset(settings.preset);
  pipeline.registerDynamic(car.root);

  progress(0.86, 'Preparing the car…');
  const vehicle = createVehicle(world, RAPIER, circuit, {
    setup: {
      frontWing: settings.frontWing,
      rearWing: settings.rearWing,
      brakeBias: settings.brakeBias,
    },
  });

  const cameraRig = createCameraRig(camera, {
    rig: settings.camera,
    fov: settings.fov,
    chaseDistance: settings.chaseDistance,
    cameraShake: settings.cameraShake,
    invertLook: settings.invertLook,
    domElement: renderer.domElement,      // free look listens here
  });

  const hud = createHUD(circuit, { revLimit: vehicle.state.revLimit ?? 15000 });
  const input = createInput(window, {
    onGamepad: id => hud.notice(`Gamepad connected — ${id.split('(')[0].trim()}`, 4000),
  });
  const timing = createTiming(circuit, {});
  const audio = createAudio({
    volume: settings.volume / 100,
    engineVolume: settings.engineVolume / 100,
    effectsVolume: settings.effectsVolume / 100,
  });

  progress(0.96, 'Ready');

  Object.assign(game, {
    renderer, scene, camera, world, track, circuit, car, rivalAssets,
    pipeline, vehicle, cameraRig, hud, input, timing, audio, field: null,
  });

  // Read-only handle for diagnostics. Useful when the picture is wrong but
  // nothing throws — which is most graphics bugs.
  window.__APEX = game;

  wireInterface();
  applyAllSettings();
  resize();
  drawMenuMap();
  showMenu();
  progress(1, 'Ready');
  requestAnimationFrame(frame);
}

/* ──────────────────────────── interface ──────────────────────────── */

let settingsUI;

function wireInterface() {
  settingsUI = createSettingsUI(settings, onSettingChange);

  for (const button of document.querySelectorAll('.mode')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.mode')) {
        other.classList.toggle('selected', other === button);
      }
      game.mode = button.dataset.mode;
      $('race-options').hidden = game.mode !== 'race';
    });
  }

  for (const id of ['opponents', 'laps', 'skill']) {
    const node = $(id);
    const output = $(`${id}-value`);
    if (!node || !output) continue;      // a missing control must not break boot
    const render = () => {
      output.textContent = id === 'skill' ? `${node.value}%`
                         : id === 'laps' ? `${node.value} lap${node.value === '1' ? '' : 's'}`
                         : `${node.value} cars`;
    };
    node.addEventListener('input', render);
    render();
  }

  $('start-session').addEventListener('click', () => startSession());
  $('open-settings').addEventListener('click', () => settingsUI.open(false));
  $('close-settings').addEventListener('click', () => closeSettings());
  $('resume').addEventListener('click', () => closeSettings());
  $('hud-menu').addEventListener('click', () => pause());
  $('quit-session').addEventListener('click', () => { closeSettings(); endSession(); });
  $('results-again').addEventListener('click', () => { $('results').hidden = true; startSession(); });
  $('results-menu').addEventListener('click', () => { $('results').hidden = true; showMenu(); });
  settingsUI.dialog.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.phase === 'session') pause();
  });
  game.renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    window.apexFail(new Error('The graphics context was lost. Reload to restart.'));
  });
}

function onSettingChange(key, value) {
  switch (key) {
    case 'preset':
      game.pipeline.setPreset(value);
      game.track.setQuality(PRESETS[value]);
      resize();
      break;
    case 'renderScale':
    case 'adaptiveRes':
      resize();
      break;
    case 'fov': game.cameraRig.setFov(value); break;
    case 'camera': game.cameraRig.setRig(value); break;
    case 'chaseDistance': game.cameraRig.setChaseDistance(value); break;
    case 'cameraShake': game.cameraRig.setShake(value); break;
    case 'invertLook': game.cameraRig.setInvertLook(value); break;
    case 'opponentWheels': game.field?.setWheelAnimation(value); break;
    case 'carCollisions': game.field?.setCollisions(value); break;
    case 'onScreenControls': game.hud.setTouchVisible(shouldShowOnScreenControls()); break;
    case 'assistPreset': case 'gripLevel': break;   // read live by the vehicle each step
    case 'timeOfDay': game.pipeline.setTimeOfDay(value); break;
    case 'weather':
      game.pipeline.setWetness({ clear: 0, cloudy: 0, damp: 0.45, wet: 1 }[value] ?? 0);
      break;
    case 'sound': game.audio.setEnabled(value); break;
    case 'volume': game.audio.setVolume(value / 100); break;
    case 'showFPS': break;                       // read directly in the frame loop
    case 'frontWing': case 'rearWing': case 'brakeBias':
      game.vehicle.setup({ [key]: value });
      break;
    default: break;
  }
  saveSettings(settings);
}

function applyAllSettings() {
  game.pipeline.setTimeOfDay(settings.timeOfDay);
  game.pipeline.setWetness({ clear: 0, cloudy: 0, damp: 0.45, wet: 1 }[settings.weather] ?? 0);
  game.cameraRig.setRig(settings.camera);
  game.cameraRig.setFov(settings.fov);
  game.cameraRig.setChaseDistance(settings.chaseDistance);
  game.cameraRig.setShake(settings.cameraShake);
  game.audio.setEnabled(settings.sound);
  game.audio.setVolume(settings.volume / 100);
}

/** Auto shows the pads only on touch devices; the other modes are explicit. */
function shouldShowOnScreenControls() {
  if (settings.onScreenControls === 'always') return true;
  if (settings.onScreenControls === 'never') return false;
  return matchMedia('(pointer: coarse)').matches;
}

function resize() {
  const preset = PRESETS[settings.preset];
  const scale = settings.renderScale > 0 ? settings.renderScale : preset.renderScale;
  const pixelRatio = Math.min(devicePixelRatio || 1, preset.maxPixelRatio);
  game.camera.aspect = innerWidth / innerHeight;
  game.camera.updateProjectionMatrix();
  game.renderer.setPixelRatio(pixelRatio);
  game.renderer.setSize(innerWidth, innerHeight, false);
  game.pipeline.setSize(innerWidth, innerHeight, pixelRatio * scale);
  game.pipeline.invalidateHistory();
}

/* ──────────────────────────── phases ──────────────────────────── */

function showMenu() {
  game.phase = 'menu';
  $('start-lights').hidden = true;
  game.start = null;
  game.paused = false;
  $('boot').hidden = true;
  $('menu').hidden = false;
  game.hud.hide();
  game.input.setEnabled(false);
  game.audio.stop();
  disposeField();

  const best = game.timing.loadBest();
  $('menu-best').textContent = best ? formatLapTime(best) : '—';
  $('menu-length').textContent = `${(game.circuit.lapLength / 1000).toFixed(3)} km`;
  $('menu-corners').textContent = String(game.track.corners.length);
}

function drawMenuMap() {
  const canvas = $('menu-map');
  const context = canvas.getContext('2d');
  const line = game.circuit.centreline;
  const xs = line.map(s => s.x), zs = line.map(s => s.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 22;
  const scale = Math.min((canvas.width - pad * 2) / (maxX - minX),
                         (canvas.height - pad * 2) / (maxZ - minZ));
  const ox = (canvas.width - (maxX - minX) * scale) / 2;
  const oz = (canvas.height - (maxZ - minZ) * scale) / 2;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineJoin = context.lineCap = 'round';
  context.beginPath();
  line.forEach((s, i) => {
    const x = ox + (s.x - minX) * scale, y = oz + (s.z - minZ) * scale;
    if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.closePath();
  context.strokeStyle = 'rgba(255,255,255,0.10)';
  context.lineWidth = 11;
  context.stroke();
  context.strokeStyle = '#ff2d55';
  context.lineWidth = 2.5;
  context.stroke();

  const start = line[0];
  context.beginPath();
  context.arc(ox + (start.x - minX) * scale, oz + (start.z - minZ) * scale, 4, 0, Math.PI * 2);
  context.fillStyle = '#fff';
  context.fill();
}

function startSession() {
  const opponents = game.mode === 'race' ? Number($('opponents').value) : 0;
  const totalLaps = game.mode === 'race' ? Number($('laps').value) : 0;
  const skill = Number($('skill').value) / 100;
  settings.assistPreset = $('assists').value;

  $('menu').hidden = true;
  game.hud.show();
  game.hud.setTouchVisible(shouldShowOnScreenControls());
  game.phase = 'session';
  game.paused = false;
  game.input.setEnabled(true);

  game.timing.reset(game.mode);
  game.race = {
    totalLaps, position: 1, classification: [],
    gapAhead: null, gapBehind: null, finished: false,
  };

  // Grid slot 0 is pole; the player starts from the back in a race so there is
  // something to actually do, and on an empty track otherwise.
  // Start mid-grid: half the field ahead, half behind. Starting at the back
  // put the whole field up to ~70 m ahead before the lights went out.
  const slotIndex = opponents > 0 ? Math.min(Math.floor(opponents / 2), game.track.gridSlots.length - 1) : 0;
  const slot = game.track.gridSlots[slotIndex] ?? game.track.start;
  game.vehicle.reset(slot);

  // Always clear the previous race's field first. "Race again" goes straight
  // from the results screen to here without passing through the menu, so the
  // old cars used to stay in the scene, frozen wherever they finished.
  disposeField();

  if (opponents > 0) {
    game.field = createField(game.circuit, RAPIER, game.world, game.scene, {
      count: opponents,
      skill,
      gridSlots: game.track.gridSlots,
      playerSlot: slotIndex,
      carAsset: game.car,
      rivalAssets: game.rivalAssets,
      renderer: game.renderer,
      gripLevel: settings.gripLevel,     // the field keeps pace with the player's car
      animateWheels: settings.opponentWheels,
      collisions: settings.carCollisions,
    });
    for (const rival of game.field.cars) game.pipeline.registerDynamic(rival.root);
    // Line the field up on its grid boxes, stationary, facing down the track.
    game.field.place(game.vehicle.state);
  }

  // A race starts from the lights; practice and time trial start at once.
  startLights(game.mode === 'race');

  game.cameraRig.snap(game.vehicle.state);
  game.pipeline.invalidateHistory();
  game.audio.start();
  game.hud.notice(
    game.mode === 'race' ? `${totalLaps} laps · ${opponents} opponents` :
    game.mode === 'timetrial' ? 'Time trial — set a lap' : 'Free practice',
    4500);
}

/* ──────────────────────────── start lights ──────────────────────────── */

// Five red lights come on one per second; after a random hold they all turn
// green and the race is on. Nothing moves before that — not you, not the AI.
const LIGHT_INTERVAL = 1.0;
const GREEN_SHOWN_FOR = 20;

function startLights(enabled) {
  const pod = $('start-lights');
  const lamps = [...pod.children];
  for (const lamp of lamps) lamp.className = '';
  if (!enabled) { game.start = { phase: 'green', t: 0, shown: 0 }; pod.hidden = true; return; }
  game.start = { phase: 'lights', t: 0, lit: 0, hold: 5 * LIGHT_INTERVAL + 0.6 + Math.random() * 1.9, shown: 0 };
  pod.hidden = false;
  pod.classList.remove('fade');
}

/** Advance the light sequence. Returns true while cars must stay put. */
function updateStartLights(delta) {
  const start = game.start;
  if (!start) return false;
  const pod = $('start-lights');
  const lamps = pod.children;
  if (start.phase === 'lights') {
    start.t += delta;
    const lit = Math.min(5, Math.floor(start.t / LIGHT_INTERVAL));
    for (let i = 0; i < lamps.length; i++) lamps[i].className = i < lit ? 'red' : '';
    if (start.t >= start.hold) {
      start.phase = 'green';
      start.shown = GREEN_SHOWN_FOR;
      for (const lamp of lamps) lamp.className = 'green';
      game.field?.go();
      game.hud.notice('GO!', 1500);
      return false;
    }
    return true;
  }
  if (start.shown > 0) {
    start.shown -= delta;
    if (start.shown < 1.2) pod.classList.add('fade');
    if (start.shown <= 0) pod.hidden = true;
  }
  return false;
}

function disposeField() {
  if (!game.field) return;
  for (const rival of game.field.cars) game.pipeline.unregisterDynamic(rival.root);
  game.field.dispose();
  game.field = null;
}

function endSession() {
  disposeField();
  showMenu();
}

function showResults() {
  game.phase = 'results';
  $('start-lights').hidden = true;
  game.input.setEnabled(false);
  game.audio.stop();
  game.hud.hide();

  const rows = game.race.classification.length
    ? game.race.classification
    : [{ name: 'You', isPlayer: true, best: game.timing.state.bestLap }];

  const body = $('results-table').querySelector('tbody');
  body.replaceChildren(...rows.map((entry, i) => {
    const tr = document.createElement('tr');
    if (entry.isPlayer) tr.className = 'player';
    for (const text of [String(i + 1), entry.name, formatLapTime(entry.best)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
  $('results-title').textContent = game.mode === 'race' ? 'Race result' : 'Session summary';
  $('results').hidden = false;
}

function pause() {
  if (game.phase !== 'session') return;
  game.paused = true;
  game.input.clear();
  game.input.setEnabled(false);
  settingsUI.open(true);
}

function closeSettings() {
  settingsUI.close();
  if (game.phase === 'session') {
    game.paused = false;
    game.input.setEnabled(true);
    game.cameraRig.snap(game.vehicle.state);
    game.pipeline.invalidateHistory();
  }
}

/* ──────────────────────────── frame loop ──────────────────────────── */

let previousTime = performance.now();
let accumulator = 0;
const pendingShift = { up: false, down: false };
let fpsAccumulator = 0;
let fpsFrames = 0;
let fpsValue = 0;
let renderFailures = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const delta = Math.min((now - previousTime) / 1000, 0.1);
  previousTime = now;
  game.elapsed += delta;
  game.frameIndex++;

  const running = game.phase === 'session' && !game.paused && !settingsUI?.isOpen;

  if (running) {
    const inputState = game.input.sample();
    const holding = updateStartLights(delta);

    if (game.input.consume('pause')) { pause(); }
    if (game.input.consume('respawn')) {
      game.vehicle.reset(nearestRestart());
      game.cameraRig.snap(game.vehicle.state);
      game.pipeline.invalidateHistory();
      game.hud.notice('Car returned to the track', 2500);
    }
    if (game.input.consume('camera')) {
      const rig = game.cameraRig.cycleRig();
      game.cameraRig.recentreLook();
      settings.camera = rig;
      saveSettings(settings);
      game.pipeline.invalidateHistory();
      game.hud.notice(`${RIG_LABELS[rig]} camera`, 1800);
    }

    // Fixed-step physics. Clamping the accumulator stops a long stall (a tab
    // switch, a shader compile) turning into a burst of hundreds of steps.
    // The AI steps inside the same fixed loop as the car, so its physics
    // bodies move smoothly and contact with the player is solid every step.
    accumulator = holding ? 0 : Math.min(accumulator + delta, PHYSICS_STEP * MAX_STEPS_PER_FRAME);

    // Gear shifts are one-shot presses, sampled once per frame, but physics
    // runs 0-8 steps per frame. On a 120-165 Hz display many frames run no
    // step at all, and a shift pressed on one of those was simply lost. Hold
    // each press until exactly one physics step has seen it.
    if (inputState.shiftUp) pendingShift.up = true;
    if (inputState.shiftDown) pendingShift.down = true;
    if (holding) pendingShift.up = pendingShift.down = false;

    let steps = 0;
    while (accumulator >= PHYSICS_STEP && steps < MAX_STEPS_PER_FRAME) {
      inputState.shiftUp = pendingShift.up;
      inputState.shiftDown = pendingShift.down;
      game.field?.step(PHYSICS_STEP, game.vehicle.state);
      game.vehicle.step(PHYSICS_STEP, inputState, settings);
      pendingShift.up = pendingShift.down = false;
      accumulator -= PHYSICS_STEP;
      steps++;
    }

    updateRace();
    if (!holding) game.timing.update(delta, game.vehicle.state.lapDistance, !game.vehicle.state.offTrack);

    // Finish on laps actually COMPLETED, never on the lap counter, which can
    // be moved by a re-seed after a teleport; and never in the first seconds
    // of a race, because a race that ends as the lights go green is always a
    // bug rather than a result.
    if (game.race.totalLaps > 0
        && game.timing.state.lapCount >= game.race.totalLaps
        && game.timing.state.sessionTime > 5) {
      console.info(`Race over: ${game.timing.state.lapCount}/${game.race.totalLaps} laps ` +
        `after ${game.timing.state.sessionTime.toFixed(1)} s`);
      showResults();
    }
  } else {
    accumulator = 0;
  }

  // Visual state follows physics even when paused, so the menu shows the car.
  game.car.sync(game.vehicle.state);
  game.cameraRig.update(game.vehicle.state, delta, {
    world: game.world, RAPIER, body: game.vehicle.body,
  });

  if (game.phase === 'session') {
    game.audio.update(delta, game.vehicle.state, game.field?.cars, game.camera);
    game.hud.update({
      vehicle: game.vehicle.state,
      timing: game.timing.state,
      race: game.race,
      minimapRivals: game.field?.cars,
      tcActive: game.vehicle.state.tractionControlActive,
      flags: activeFlags(),
      showFPS: settings.showFPS,
      stats: statsText(),
    });
  }

  game.track.update(delta, game.camera.position);
  try {
    game.pipeline.render(delta, game.frameIndex);
  } catch (error) {
    // rAF is scheduled at the top of this function, so a throw here would
    // otherwise repeat silently forever and just look like a black screen.
    if (!frame.reported) { frame.reported = true; console.error('Render failed:', error); }
    renderFailures++;
    if (renderFailures > 120) { window.apexFail(error); return; }
  }

  fpsAccumulator += delta;
  fpsFrames++;
  if (fpsAccumulator > 0.5) {
    fpsValue = Math.round(fpsFrames / fpsAccumulator);
    fpsAccumulator = 0;
    fpsFrames = 0;
  }
}

/** Put the car back on the racing line, facing the right way. */
function nearestRestart() {
  const state = game.vehicle.state;
  const point = game.circuit.lineAt(state.lapDistance ?? 0);
  const yaw = Math.atan2(point.tx, point.tz);
  return {
    position: new THREE.Vector3(point.x, point.y + 0.62, point.z),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
  };
}

function updateRace() {
  if (!game.field) { game.race.classification = []; return; }
  const board = game.field.classification(game.vehicle.state, game.timing.state.lapCount);
  game.race.classification = board;
  const me = board.findIndex(entry => entry.isPlayer);
  game.race.position = me + 1;
  game.race.gapAhead = me > 0 ? board[me - 1].gapToPlayer : null;
  game.race.gapBehind = me >= 0 && me < board.length - 1 ? board[me + 1].gapToPlayer : null;
}

function activeFlags() {
  const flags = [];
  if (game.vehicle.state.offTrack) flags.push({ kind: 'yellow', text: 'Off track' });
  if (game.timing.state.valid === false) flags.push({ kind: 'invalid', text: 'Lap invalidated' });
  return flags;
}

function statsText() {
  const stats = game.pipeline.stats ?? {};
  return [
    `${fpsValue} FPS`,
    `${stats.preset ?? settings.preset} @ ${((stats.renderScale ?? 1) * 100).toFixed(0)}%`,
    `${stats.drawCalls ?? 0} calls · ${((stats.triangles ?? 0) / 1000).toFixed(0)}k tris`,
  ].join('\n');
}

/* ─────────────────────────────── go ─────────────────────────────── */

boot().catch(error => window.apexFail(error));
