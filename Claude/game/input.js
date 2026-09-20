/**
 * input.js — keyboard, gamepad and touch collapsed into one control vector.
 *
 * This layer only reports what the human is asking for, as analogue values in
 * 0..1 and -1..1. It deliberately does NOT smooth or rate-limit anything:
 * shaping a digital key press into something a tyre model can use is a vehicle
 * concern, not an input concern, and lives in sim/vehicle.js. Keeping them
 * apart means a gamepad's genuinely analogue trigger passes through untouched
 * instead of being smoothed twice.
 */

const DRIVING_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyE',
]);

const DEAD_ZONE = 0.12;

/** Rescale an axis so the dead zone does not eat the low end of its travel. */
function applyDeadZone(value, dead = DEAD_ZONE) {
  const magnitude = Math.abs(value);
  if (magnitude < dead) return 0;
  return Math.sign(value) * (magnitude - dead) / (1 - dead);
}

export function createInput(target = window, options = {}) {
  const keys = new Set();
  const touches = { throttle: new Set(), brake: new Set(), left: new Set(), right: new Set() };
  const edges = { shiftUp: false, shiftDown: false, respawn: false, camera: false, pause: false };

  let gamepadIndex = null;
  let lastGamepadButtons = [];
  let enabled = true;

  const state = {
    throttle: 0, brake: 0, steer: 0,
    handbrake: false, drs: false,
    shiftUp: false, shiftDown: false,
    device: 'keyboard',
  };

  /* ------------------------------------------------------------ keyboard */

  function onKeyDown(event) {
    if (!enabled) return;
    if (event.target.matches?.('input, select, textarea, button')) return;
    if (event.code === 'Escape') { edges.pause = true; return; }
    if (DRIVING_KEYS.has(event.code)) event.preventDefault();
    if (event.repeat) return;

    keys.add(event.code);
    state.device = 'keyboard';
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') edges.shiftUp = true;
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') edges.shiftDown = true;
    if (event.code === 'KeyR') edges.respawn = true;
    if (event.code === 'KeyC') edges.camera = true;
  }
  const onKeyUp = event => keys.delete(event.code);

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  /* --------------------------------------------------------------- touch */

  const padNodes = [...document.querySelectorAll('[data-control]')];
  const touchHandlers = [];
  for (const node of padNodes) {
    const control = node.dataset.control;
    if (!touches[control]) continue;
    const press = event => {
      event.preventDefault();
      if (!enabled) return;
      touches[control].add(event.pointerId);
      node.classList.add('pressed');
      state.device = 'touch';
      try { node.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    };
    const release = event => {
      touches[control].delete(event.pointerId);
      if (!touches[control].size) node.classList.remove('pressed');
    };
    node.addEventListener('pointerdown', press);
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('lostpointercapture', release);
    node.addEventListener('contextmenu', event => event.preventDefault());
    touchHandlers.push({ node, press, release });
  }

  /* ------------------------------------------------------------- gamepad */

  window.addEventListener('gamepadconnected', event => {
    gamepadIndex = event.gamepad.index;
    options.onGamepad?.(event.gamepad.id);
  });
  window.addEventListener('gamepaddisconnected', event => {
    if (gamepadIndex === event.gamepad.index) gamepadIndex = null;
  });

  function readGamepad() {
    if (gamepadIndex === null) return null;
    const pads = navigator.getGamepads?.();
    const pad = pads?.[gamepadIndex];
    if (!pad?.connected) return null;

    // Standard mapping: buttons[7] = right trigger, [6] = left trigger,
    // axes[0] = left stick X. Triggers report an analogue `value`.
    const throttle = pad.buttons[7]?.value ?? 0;
    const brake = pad.buttons[6]?.value ?? 0;
    const steer = applyDeadZone(pad.axes[0] ?? 0);
    const active = throttle > 0.02 || brake > 0.02 || Math.abs(steer) > 0;

    const pressed = index => !!pad.buttons[index]?.pressed;
    const rising = index => pressed(index) && !lastGamepadButtons[index];
    const result = {
      throttle, brake, steer,
      handbrake: pressed(0),
      drs: pressed(2),
      shiftUp: rising(5),
      shiftDown: rising(4),
      respawn: rising(3),
      camera: rising(1),
      pause: rising(9),
      active,
    };
    lastGamepadButtons = pad.buttons.map(b => b.pressed);
    return result;
  }

  /* ---------------------------------------------------------------- read */

  /** Sample every device. Call once per frame, before stepping the sim. */
  function sample() {
    if (!enabled) {
      state.throttle = state.brake = state.steer = 0;
      state.handbrake = state.drs = state.shiftUp = state.shiftDown = false;
      return state;
    }

    const pad = readGamepad();
    if (pad?.active) state.device = 'gamepad';

    const keyThrottle = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
    const keyBrake = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;
    const keyLeft = keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0;
    const keyRight = keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0;

    const touchThrottle = touches.throttle.size ? 1 : 0;
    const touchBrake = touches.brake.size ? 1 : 0;
    const touchSteer = (touches.right.size ? 1 : 0) - (touches.left.size ? 1 : 0);

    // Highest demand from any device wins, so a gamepad and keyboard can be
    // used interchangeably without one zeroing the other.
    state.throttle = Math.max(keyThrottle, touchThrottle, pad?.throttle ?? 0);
    state.brake = Math.max(keyBrake, touchBrake, pad?.brake ?? 0);

    const digitalSteer = keyRight - keyLeft + touchSteer;
    state.steer = Math.abs(pad?.steer ?? 0) > Math.abs(digitalSteer)
      ? pad.steer
      : Math.max(-1, Math.min(1, digitalSteer));

    state.handbrake = keys.has('Space') || !!pad?.handbrake;
    state.drs = keys.has('KeyE') || !!pad?.drs;

    // Edge-triggered actions are latched on press and cleared once consumed,
    // so a shift can never be missed between frames.
    state.shiftUp = edges.shiftUp || !!pad?.shiftUp;
    state.shiftDown = edges.shiftDown || !!pad?.shiftDown;
    edges.shiftUp = edges.shiftDown = false;
    if (pad?.respawn) edges.respawn = true;
    if (pad?.camera) edges.camera = true;
    if (pad?.pause) edges.pause = true;

    return state;
  }

  /** Consume a one-shot action. Returns true at most once per press. */
  function consume(name) {
    if (!edges[name]) return false;
    edges[name] = false;
    return true;
  }

  function clear() {
    keys.clear();
    for (const set of Object.values(touches)) set.clear();
    for (const node of padNodes) node.classList.remove('pressed');
    for (const key of Object.keys(edges)) edges[key] = false;
    state.throttle = state.brake = state.steer = 0;
    state.handbrake = state.drs = state.shiftUp = state.shiftDown = false;
  }

  const onBlur = () => clear();
  window.addEventListener('blur', onBlur);

  return {
    sample,
    consume,
    clear,
    state,
    setEnabled(value) { enabled = value; if (!value) clear(); },
    get device() { return state.device; },
    get hasGamepad() { return gamepadIndex !== null; },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      for (const { node, press, release } of touchHandlers) {
        node.removeEventListener('pointerdown', press);
        node.removeEventListener('pointerup', release);
        node.removeEventListener('pointercancel', release);
        node.removeEventListener('lostpointercapture', release);
      }
    },
  };
}
