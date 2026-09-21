/**
 * camera.js — the camera rigs and how they follow the car.
 *
 * The chase cameras deliberately do NOT rigidly parent to the car's yaw. A
 * hard-parented chase camera rotates instantly with the chassis, so a snap of
 * oversteer whips the whole world sideways and you lose all sense of where the
 * track went. Instead the rig tracks a smoothed heading that lags the car, so
 * the chassis visibly rotates *within* the frame when it steps out — which is
 * what actually communicates a slide to the driver.
 */

import * as THREE from 'three';

/**
 * Rig definitions in car-local metres.
 * `offset` is the eye position, `look` the point it aims at.
 * `rigid` rigs are bolted to the chassis (cockpit, nose) and do use its exact
 * orientation, because that is the physical truth of a mounted camera.
 */
export const RIGS = {
  chase:   { offset: new THREE.Vector3(0, 2.05, -7.5), look: new THREE.Vector3(0, 0.55, 5.5), rigid: false, fovScale: 1.00 },
  close:   { offset: new THREE.Vector3(0, 1.55, -5.0), look: new THREE.Vector3(0, 0.45, 4.5), rigid: false, fovScale: 1.02 },
  tv:      { offset: new THREE.Vector3(0, 1.28, -0.85), look: new THREE.Vector3(0, 0.62, 16.0), rigid: true,  fovScale: 0.98 },
  // Cockpit and halo are placed from the model's own geometry, not guessed.
  // Scanning max height near the centreline gives the car's profile: the roll
  // hoop peaks at z=-0.1/y=0.60, the cockpit opening is the dip at z=0.1..0.3
  // where height falls to 0.16, and the halo arcs forward over z=0.4..0.8.
  //
  // So the driver's eye belongs just above that dip, BEHIND the halo's forward
  // strut and level with the hoop — which is what puts the halo in frame.
  // Previously both sat at y=0.74..0.80, well above the hoop, looking straight
  // over the top of it; that is why the halo view never showed a halo.
  cockpit: { offset: new THREE.Vector3(0, 0.40, 0.06), look: new THREE.Vector3(0, 0.30, 20.0), rigid: true, fovScale: 1.08 },
  halo:    { offset: new THREE.Vector3(0, 0.345, 0.02), look: new THREE.Vector3(0, 0.28, 20.0), rigid: true, fovScale: 1.15 },
  nose:    { offset: new THREE.Vector3(0, 0.30, 2.55), look: new THREE.Vector3(0, 0.22, 18.0), rigid: true,  fovScale: 1.00 },
};

export const RIG_NAMES = Object.keys(RIGS);
export const RIG_LABELS = {
  chase: 'CHASE', close: 'CLOSE', tv: 'TV POD',
  cockpit: 'COCKPIT', halo: 'HALO', nose: 'NOSE',
};

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

/** How far a pitched free-look raises a chase camera, per rig. */
const pullbackRise = rig => Math.abs(rig.offset.z) * 0.55;

export function createCameraRig(camera, options = {}) {
  let rigName = options.rig ?? 'chase';
  let baseFov = options.fov ?? 72;
  let chaseDistance = options.chaseDistance ?? 7.5;
  let shakeEnabled = options.cameraShake !== false;

  // Smoothed follow state, in world space.
  const eye = new THREE.Vector3();
  const focus = new THREE.Vector3();
  let heading = 0;              // smoothed yaw the chase rigs orbit around
  let initialised = false;

  const carPosition = new THREE.Vector3();
  const carQuaternion = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const desiredEye = new THREE.Vector3();
  const desiredFocus = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const shake = new THREE.Vector3();

  let shakeSeed = 0;
  let shakeLevel = 0;
  let smoothedHeight = NaN;   // only the camera's height is eased; distance is rigid
  let teleport = false;      // set by snap(): this frame ignores all smoothing

  /* ---------------------------------------------------------- free look */
  // Hold right mouse (or two fingers) and drag to look around. Releasing holds
  // the view briefly — so a glance at a mirror is not snatched away mid-look —
  // then eases it back to the rig's default.
  const look = { yaw: 0, pitch: 0, dragging: false, idle: 0 };
  const LOOK_SENSITIVITY = 0.0042;
  const LOOK_YAW_LIMIT = Math.PI * 0.92;     // just short of fully backwards
  const LOOK_PITCH_LIMIT = 0.62;
  const LOOK_HOLD = 1.6;                     // seconds before it recentres
  const LOOK_RETURN = 2.6;                   // how briskly it comes back

  const dom = options.domElement ?? null;
  let activePointer = null;

  const onPointerDown = event => {
    // Right button, or middle, or a two-finger touch drag.
    if (event.button !== 2 && event.button !== 1 && event.pointerType !== 'touch') return;
    activePointer = event.pointerId;
    look.dragging = true;
    look.idle = 0;
    try { dom.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    event.preventDefault();
  };
  const onPointerMove = event => {
    if (!look.dragging || event.pointerId !== activePointer) return;
    const invert = options.invertLook ? -1 : 1;
    look.yaw = clampAngle(look.yaw - event.movementX * LOOK_SENSITIVITY, LOOK_YAW_LIMIT);
    look.pitch = clampAngle(look.pitch - event.movementY * LOOK_SENSITIVITY * invert, LOOK_PITCH_LIMIT);
    look.idle = 0;
    event.preventDefault();
  };
  const onPointerUp = event => {
    if (event.pointerId !== activePointer) return;
    look.dragging = false;
    activePointer = null;
    look.idle = 0;
  };
  const onContextMenu = event => event.preventDefault();

  if (dom) {
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerUp);
    dom.addEventListener('lostpointercapture', onPointerUp);
    dom.addEventListener('contextmenu', onContextMenu);
  }

  const clampAngle = (value, limit) => Math.max(-limit, Math.min(limit, value));

  /** Advance the free-look state: hold while dragging, then ease home. */
  function updateLook(dt) {
    if (look.dragging) return;
    look.idle += dt;
    if (look.idle < LOOK_HOLD) return;
    const k = 1 - Math.exp(-LOOK_RETURN * dt);
    look.yaw += (0 - look.yaw) * k;
    look.pitch += (0 - look.pitch) * k;
    if (Math.abs(look.yaw) < 1e-4) look.yaw = 0;
    if (Math.abs(look.pitch) < 1e-4) look.pitch = 0;
  }

  /** Exponential smoothing that is correct for a variable timestep. */
  const damp = (current, target, lambda, dt) =>
    current + (target - current) * (1 - Math.exp(-lambda * dt));

  function shortestAngle(from, to) {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  /**
   * @param state    vehicle state (position, quaternion, speed, wheels…)
   * @param dt       seconds since the last frame
   * @param context  { world, RAPIER, body } for camera-collision, optional
   */
  function update(state, dt, context) {
    const rig = RIGS[rigName] ?? RIGS.chase;
    updateLook(dt);
    carPosition.set(state.position.x, state.position.y, state.position.z);
    carQuaternion.set(state.quaternion.x, state.quaternion.y,
                      state.quaternion.z, state.quaternion.w);

    const speed = Math.abs(state.speed ?? 0);
    const carYaw = Math.atan2(
      2 * (carQuaternion.w * carQuaternion.y + carQuaternion.x * carQuaternion.z),
      1 - 2 * (carQuaternion.y ** 2 + carQuaternion.z ** 2));

    if (!initialised) { heading = carYaw; initialised = true; }

    if (rig.rigid) {
      // Bolted to the chassis: use its exact orientation, and let free look
      // swing the gaze from a fixed head position — as a driver actually does.
      desiredEye.copy(rig.offset).applyQuaternion(carQuaternion).add(carPosition);
      desiredFocus.copy(rig.look);
      if (look.yaw || look.pitch) {
        desiredFocus.applyAxisAngle(UP, look.yaw);
        desiredFocus.y += look.pitch * rig.look.z * 0.9;
      }
      desiredFocus.applyQuaternion(carQuaternion).add(carPosition);
      eye.copy(desiredEye);
      focus.copy(desiredFocus);
      heading = carYaw;
    } else {
      // Chase: orbit a heading that lags the chassis. The lag shortens with
      // speed so the camera stays responsive on a straight but lets the car
      // rotate freely inside the frame during a slide.
      const lag = 3.2 + Math.min(speed * 0.10, 5.5);
      heading += shortestAngle(heading, carYaw) * (teleport ? 1 : (1 - Math.exp(-lag * dt)));

      const distance = rigName === 'chase' ? chaseDistance : Math.abs(rig.offset.z);
      // Pull back and drop slightly as speed rises: the classic sense of the
      // car "getting away" from you down a straight.
      // Fixed distance. Scaling it with speed made the car recede exactly when
      // you most need to see it.
      const pullback = distance;
      const rise = rig.offset.y + look.pitch * pullbackRise(rig);

      // Free look orbits the chase camera around the car.
      const viewHeading = heading + look.yaw;
      const sin = Math.sin(viewHeading), cos = Math.cos(viewHeading);
      desiredEye.set(
        carPosition.x - sin * pullback,
        carPosition.y + rise,
        carPosition.z - cos * pullback);
      desiredFocus.set(
        carPosition.x + sin * rig.look.z,
        carPosition.y + rig.look.y,
        carPosition.z + cos * rig.look.z);

      // Position is damped harder than the aim point, which keeps the horizon
      // steady while the car moves under it.
      // The camera is LOCKED to the car in translation. It used to be damped
      // toward the target position, which looks fine standing still but has a
      // steady-state lag proportional to speed: damping with lambda = 9 while
      // the car does 90 m/s settles ~10 m further back than intended, so the
      // car appeared to drift away the faster you went. Exponential smoothing
      // simply cannot track a moving target without lag.
      //
      // Only `heading` is smoothed now (above). That keeps the reason the
      // chase rig is smoothed at all — the chassis rotating within the frame
      // during a slide — while the distance stays exactly what was asked for.
      eye.copy(desiredEye);

      // Vertical is still eased, because ride height and kerb strikes are
      // high-frequency and the horizon should not jitter with them. Height
      // does not accumulate lag the way the follow distance did.
      if (teleport || !Number.isFinite(smoothedHeight)) {
        smoothedHeight = desiredEye.y;
      } else {
        smoothedHeight = damp(smoothedHeight, desiredEye.y, 11, dt);
      }
      eye.y = smoothedHeight;

      focus.copy(desiredFocus);
    }

    // Keep a static wall from ending up between the camera and the car.
    if (!rig.rigid && context?.world && context?.RAPIER) {
      scratch.copy(eye).sub(focus);
      const distance = scratch.length();
      if (distance > 1.2) {
        scratch.divideScalar(distance);
        const ray = new context.RAPIER.Ray(focus, scratch);
        const hit = context.world.castRay(
          ray, distance, true,
          context.RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
          undefined, undefined, context.body);
        if (hit && hit.timeOfImpact > 0.4 && hit.timeOfImpact < distance) {
          eye.copy(focus).addScaledVector(scratch, Math.max(0.5, hit.timeOfImpact - 0.25));
        }
      }
    }

    // Speed-driven field of view: a few degrees is enough to read as speed
    // without making the car look like it is being stretched.
    const speedFov = baseFov * rig.fovScale + Math.min(speed * 0.030, 3.5);
    if (Math.abs(camera.fov - speedFov) > 0.01) {
      camera.fov = speedFov;
      camera.updateProjectionMatrix();
    }

    camera.position.copy(eye);

    if (shakeEnabled) {
      // Shake comes from two sources: raw speed, and whatever the wheels are
      // doing. Rumbling over a kerb should be felt far more than a smooth
      // 300 km/h straight, so kerb contact dominates the mix.
      // Amplitudes here are roughly a fifth of what they were. The previous
      // values peaked at 0.22 m of camera displacement, which is most of a car
      // width and read as a constant judder rather than texture.
      shakeSeed += dt * 32;
      const speedShake = Math.min(speed / 95, 1) * 0.0012;
      let surfaceShake = 0;
      for (const wheel of state.wheels ?? []) {
        if (!wheel.contact) continue;
        if (wheel.surface === 'kerb') surfaceShake += 0.004;
        else if (wheel.surface === 'grass' || wheel.surface === 'runoff') surfaceShake += 0.002;
        surfaceShake += (wheel.skidding ?? 0) * 0.0015;
      }
      // Ease the level itself so shake fades in and out instead of switching.
      shakeLevel += (Math.min(speedShake + surfaceShake, 0.012) - shakeLevel)
        * (1 - Math.exp(-6 * dt));
      const amount = shakeLevel;
      if (amount > 0.0005) {
        shake.set(
          Math.sin(shakeSeed * 1.7) * Math.sin(shakeSeed * 0.9),
          Math.sin(shakeSeed * 2.3 + 1.1) * Math.cos(shakeSeed * 1.3),
          Math.sin(shakeSeed * 1.1 + 2.7) * 0.4);
        camera.position.addScaledVector(shake, amount);
      }
    }

    camera.up.set(0, 1, 0);
    camera.lookAt(focus);
  }

  /**
   * Jump the rig to the car with no smoothing — respawns, camera changes.
   * This must bypass the damping entirely: calling update() would only move the
   * camera a fraction of the way, so after a respawn it crawled toward the car
   * from wherever it happened to be.
   */
  function snap(state) {
    initialised = false;
    teleport = true;
    update(state, 1 / 60, null);
    teleport = false;
  }

  return {
    update,
    snap,
    get rig() { return rigName; },
    get label() { return RIG_LABELS[rigName]; },
    setRig(name) { if (RIGS[name]) { rigName = name; initialised = false; } },
    cycleRig() {
      const next = (RIG_NAMES.indexOf(rigName) + 1) % RIG_NAMES.length;
      rigName = RIG_NAMES[next];
      initialised = false;
      return rigName;
    },
    setFov(value) { baseFov = value; },
    setChaseDistance(value) { chaseDistance = value; },
    setShake(value) { shakeEnabled = value; },
    setInvertLook(value) { options.invertLook = value; },
    get lookOffset() { return { yaw: look.yaw, pitch: look.pitch, dragging: look.dragging }; },
    recentreLook() { look.yaw = 0; look.pitch = 0; look.idle = 0; },
    get focusPoint() { return focus; },
    dispose() {
      if (!dom) return;
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('lostpointercapture', onPointerUp);
      dom.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
