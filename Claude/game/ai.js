/**
 * ai.js — the opponents.
 *
 * Design decision: AI cars do NOT run the full vehicle model. Fifteen cars at
 * 120 Hz with four raycasts and a Pacejka solve each is ~7,200 raycasts per
 * second of pure overhead, and it buys nothing the player can see — nobody is
 * inspecting a rival's slip angle at 200 m. Instead each car is a
 * longitudinal-dynamics model constrained to the corridor: it has real speed,
 * acceleration, braking and grip limits taken from the circuit's own solved
 * speed profile, and it chooses a lateral offset. That gives correct-looking
 * braking points, cornering speeds and battles at about 2% of the cost.
 *
 * What it deliberately keeps: no rubber-banding. A slow AI stays slow and a
 * fast one drives away. Skill changes the car's actual limits, not a hidden
 * multiplier that tracks the player.
 */

import * as THREE from 'three';
import { makeLiveryTexture } from '../render/car.js';

const TEAMS = [
  { name: 'Verhoeven',  hue: 0.00, colour: '#1e3a8a' },
  { name: 'Marchetti',  hue: 0.52, colour: '#d81e32' },
  { name: 'Okonkwo',    hue: 0.28, colour: '#00a19c' },
  { name: 'Lindqvist',  hue: 0.13, colour: '#ff8000' },
  { name: 'Duval',      hue: 0.75, colour: '#6c4ad0' },
  { name: 'Tanaka',     hue: 0.42, colour: '#00b34a' },
  { name: 'Salvatierra',hue: 0.88, colour: '#e0218a' },
  { name: 'Brennan',    hue: 0.62, colour: '#2f6fd0' },
  { name: 'Novak',      hue: 0.18, colour: '#c9a227' },
  { name: 'Ferreira',   hue: 0.34, colour: '#0f766e' },
  { name: 'Haugen',     hue: 0.70, colour: '#7c3aed' },
  { name: 'Costa',      hue: 0.06, colour: '#b91c1c' },
  { name: 'Weiss',      hue: 0.46, colour: '#0ea5e9' },
  { name: 'Aldridge',   hue: 0.94, colour: '#db2777' },
  { name: 'Petrov',     hue: 0.22, colour: '#ca8a04' },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ───────────────────────── performance model ─────────────────────────
 * Measured from the player's own car (sim/vehicle.js) on flat asphalt, so the
 * AI accelerates, brakes, corners and tops out exactly as the player's car
 * does. Re-measure if the vehicle model changes.
 *
 *   top speed 311 km/h (336 with DRS) · 0-100 5.3 s · 0-200 9.0 s
 */
const ACCEL = [[0, 4.0], [5, 4.35], [15, 5.56], [25, 6.67], [35, 7.14], [45, 7.14], [55, 8.33], [65, 6.67], [75, 3.45], [86.4, 0]];
const ACCEL_DRS = [[0, 4.0], [5, 4.35], [15, 5.56], [25, 6.67], [35, 6.25], [45, 7.14], [55, 7.14], [65, 7.69], [75, 5.0], [85, 2.08], [93.3, 0]];
const BRAKE = [[0, 10], [15, 11.76], [25, 15.38], [35, 18.18], [45, 25], [55, 28.57], [65, 33.33], [75, 40], [95, 45]];
// Steady-state lateral grip in g at grip 1.0: mechanical grip plus downforce
// rising with v^2. Fits the measured 0.95/1.68/3.63/6.39 g at 54/108/180/252 km/h.
const GRIP_G0 = 0.71;
const GRIP_K = 0.00108;
const TOP_SPEED = 86.4;
const TOP_SPEED_DRS = 93.3;
const DRS_CURVATURE = 0.0035;           // same threshold the player's DRS uses
const RIDE_HEIGHT = 0.585;              // car origin above the road, as the player's car rests

function table(t, v) {
  if (v <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (v <= t[i][0]) {
      const [v0, a0] = t[i - 1], [v1, a1] = t[i];
      return a0 + (a1 - a0) * (v - v0) / (v1 - v0);
    }
  }
  return t[t.length - 1][1];
}

/**
 * The fastest speed the player's car could carry at every point of the racing
 * line: cornering limit from the measured grip curve, then a backward pass for
 * braking and a forward pass for acceleration, both from the measured tables.
 * Scaled by the player's grip setting so the field keeps pace with it.
 */
function buildPace(circuit, gripLevel) {
  const line = circuit.racingLine;
  const n = line.length;
  const gripScale = 0.5 + 0.5 * gripLevel;
  const g = 9.81;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = line[i].radius;
    const drs = Math.abs(line[i].curvature) < DRS_CURVATURE;
    const cap = drs ? TOP_SPEED_DRS : TOP_SPEED;
    if (!Number.isFinite(r)) { v[i] = cap; continue; }
    const denom = 1 - gripScale * GRIP_K * g * r;
    v[i] = denom <= 0.02 ? cap : Math.min(cap, Math.sqrt(gripScale * GRIP_G0 * g * r / denom));
  }
  const seg = i => Math.hypot(line[(i + 1) % n].x - line[i].x, line[(i + 1) % n].z - line[i].z);
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 2 * n; k > 0; k--) {                     // braking: be slow enough in time
      const i = k % n, j = (k - 1 + n) % n;
      const limit = Math.sqrt(v[i] * v[i] + 2 * table(BRAKE, v[i]) * seg(j));
      if (v[j] > limit) v[j] = limit;
    }
    for (let k = 0; k < 2 * n; k++) {                     // traction/power: cannot out-accelerate the car
      const i = k % n, j = (k + 1) % n;
      const drs = Math.abs(line[i].curvature) < DRS_CURVATURE;
      const limit = Math.sqrt(v[i] * v[i] + 2 * table(drs ? ACCEL_DRS : ACCEL, v[i]) * seg(i));
      if (v[j] > limit) v[j] = limit;
    }
  }
  return v;
}


export function createField(circuit, RAPIER, world, scene, options = {}) {
  const count = clamp(options.count ?? 9, 0, TEAMS.length);
  const baseSkill = clamp(options.skill ?? 0.7, 0, 1);
  const gridSlots = options.gridSlots ?? [];
  const playerSlot = options.playerSlot ?? 0;
  const template = options.carAsset;

  const root = new THREE.Group();
  root.name = 'AI field';
  scene.add(root);

  const cars = [];
  const disposables = [];

  // Grid slots are assigned to the AI in order, skipping the player's.
  const slots = gridSlots.filter((_, i) => i !== playerSlot);

  const pace = buildPace(circuit, options.gripLevel ?? 1);
  const paceAt = lineDistance => {
    const n = pace.length;
    const f = (((lineDistance % circuit.racingLineLength) + circuit.racingLineLength) % circuit.racingLineLength)
      / circuit.racingLineLength * n;
    const i = Math.floor(f) % n, t = f - Math.floor(f);
    return pace[i] + (pace[(i + 1) % n] - pace[i]) * t;
  };
  // Race progress in metres along the CENTRELINE, measured the same way for
  // every car and for the player: signed start position (negative = behind
  // the line) plus distance covered since. The old code mixed an AI lap
  // counter with the player's completed-lap count and compared racing-line
  // distance against centreline distance, which is why passing a car could
  // leave you shown behind it.
  const signedStart = d => (d > circuit.lapLength / 2 ? d - circuit.lapLength : d);
  const player = { progress: null, last: null };

  for (let i = 0; i < count; i++) {
    const team = TEAMS[i % TEAMS.length];
    const slot = slots[i] ?? gridSlots[0];
    const located = slot ? circuit.locate(slot.position.x, slot.position.z) : { distance: 0, offset: 0 };

    // Per-driver character. Skill sets the fraction of the car's limit they
    // use; aggression governs how willingly they take a gap and how late they
    // brake. Both are spread around the requested skill so a field has variety.
    const spread = (i / Math.max(1, count - 1)) - 0.5;
    const skill = clamp(baseSkill - spread * 0.18 + (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.06 - 0.03, 0.30, 1.0);
    const aggression = clamp(0.45 + (Math.sin(i * 78.233) * 0.5 + 0.5) * 0.5, 0.25, 0.98);

    const visual = buildCarVisual(template, team, options.renderer);
    if (visual.disposable) disposables.push(...visual.disposable);
    root.add(visual.root);

    // Where on the racing line this grid slot sits, and how far off the line.
    const lineDistance = located.distance / circuit.lapLength * circuit.racingLineLength;
    const onLine = circuit.lineAt(lineDistance);
    const startOffset = located.offset - onLine.offset;

    cars.push({
      id: i,
      name: team.name,
      colour: team.colour,
      livery: team.hue,
      root: visual.root,
      wheels: visual.wheels,
      skill,
      aggression,
      // How close to the car's measured limit this driver commits. At skill 1
      // they drive at the player's car's full measured pace.
      commit: 0.9 + 0.1 * skill,
      lineDistance,                 // along the racing line: drives the motion
      lapDistance: located.distance, // along the centreline: comparable with the player
      offset: startOffset,          // metres left of the racing line
      targetOffset: startOffset,
      speed: 0,
      progress: signedStart(located.distance),
      spinAngle: 0,
      bodyRoll: 0,
      state: { speedKmh: 0, rpm: 6000 },
    });
  }

  const forwardVector = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3(1, 0, 0);
  const forwardAxis = new THREE.Vector3(0, 0, 1);
  const yawQuat = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const rollQuat = new THREE.Quaternion();

  /** Advance the player's progress the same way the AI's is measured. */
  function trackPlayer(playerState) {
    if (!playerState) return;
    const d = playerState.lapDistance ?? 0;
    if (player.progress === null) { player.progress = signedStart(d); player.last = d; return; }
    let delta = d - player.last;
    if (delta < -circuit.lapLength / 2) delta += circuit.lapLength;
    if (delta > circuit.lapLength / 2) delta -= circuit.lapLength;
    if (Math.abs(delta) < 80) player.progress += delta;     // ignore teleports (respawns)
    player.last = d;
  }

  /**
   * One AI step.
   *
   * Motion is along the racing line (`lineDistance`), with a lateral `offset`
   * from it. Race progress is measured separately along the centreline, from
   * where the car actually ends up, so it is directly comparable with the
   * player's. Every value is finite by construction: the previous version read
   * a field the racing-line lookup never returned, produced NaN the moment one
   * car closed on another, and the car vanished from the screen for good.
   */
  function step(dt, playerState) {
    if (!cars.length) return;
    const h = Math.min(dt, 0.05);
    trackPlayer(playerState);

    // Everyone on track, in centreline progress/offset terms.
    const traffic = cars.map(car => ({ car, progress: car.progress, offset: car.centreOffset ?? 0, speed: car.speed }));
    if (playerState && player.progress !== null) {
      traffic.push({ car: null, progress: player.progress, offset: playerState.lateralOffset ?? 0,
        speed: Math.abs(playerState.speed ?? 0) });
    }

    for (const car of cars) {
      const here = circuit.lineAt(car.lineDistance);

      // --- speed: the measured pace a quarter-second ahead, so braking starts in time ---
      let target = paceAt(car.lineDistance + car.speed * 0.25) * car.commit;

      // --- traffic ---
      const myOffset = here.offset + car.offset;             // centreline-relative
      let closingOn = null, closest = Infinity;
      for (const other of traffic) {
        if (other.car === car) continue;
        const gap = other.progress - car.progress;
        if (gap <= 0 || gap > 40) continue;
        if (Math.abs(other.offset - myOffset) >= 2.4) continue;
        if (gap < closest) { closest = gap; closingOn = other; }
      }
      if (closingOn) {
        // Do not drive into the back of whoever is ahead, but only lift if we
        // are genuinely closing — a slower car ahead is a chance to pass.
        const urgency = clamp(1 - closest / 40, 0, 1);
        target = Math.min(target, closingOn.speed + (1 - urgency) * 10 + car.aggression * 3);
      }

      // --- longitudinal: the player's measured acceleration and braking ---
      const drs = Math.abs(here.curvature) < DRS_CURVATURE;
      if (target > car.speed) {
        car.speed = Math.min(target, car.speed + table(drs ? ACCEL_DRS : ACCEL, car.speed) * h);
      } else {
        car.speed = Math.max(target, car.speed - table(BRAKE, car.speed) * h);
      }
      car.speed = clamp(car.speed, 0, drs ? TOP_SPEED_DRS : TOP_SPEED);

      // --- lateral: stay on the line, step aside to pass ---
      let desired = 0;
      if (closingOn && closest < 28 && car.speed > 10) {
        // Go round on whichever side has more road.
        const room = here.halfWidth - 1.2;
        const spaceLeft = room - closingOn.offset, spaceRight = room + closingOn.offset;
        const side = spaceLeft >= spaceRight ? 1 : -1;
        const wantCentre = closingOn.offset + side * 2.8;
        desired = (wantCentre - here.offset) * car.aggression;
      }
      car.targetOffset += (desired - car.targetOffset) * Math.min(1, h * 3.0);
      car.offset += (car.targetOffset - car.offset) * Math.min(1, h * 2.4);
      // Never leave the tarmac: keep the centreline offset inside the corridor.
      const limit = Math.max(0, here.halfWidth - 1.1);
      car.offset = clamp(here.offset + car.offset, -limit, limit) - here.offset;
      if (!Number.isFinite(car.offset)) car.offset = 0;
      if (!Number.isFinite(car.targetOffset)) car.targetOffset = 0;

      // --- advance ---
      car.lineDistance = (car.lineDistance + car.speed * h) % circuit.racingLineLength;

      // --- place the car: on the road, wheels on the surface ---
      const point = circuit.lineAt(car.lineDistance);
      const nx = -point.tz, nz = point.tx;                     // left of the direction of travel
      // The corridor width is smoothed, and through the narrow two-level
      // interchange even the racing line's interpolated path can clip the edge
      // of the single-lane deck. So check the real surface and, if the car would
      // be off it, move to the nearest offset that is actually on tarmac.
      if (circuit.heightAt(point.x + nx * car.offset, point.z + nz * car.offset, point.y) === null) {
        let best = null;
        for (let step = 1; step <= 24 && best === null; step++) {
          for (const sign of [-1, 1]) {
            const candidate = car.offset + sign * step * 0.25;
            if (circuit.heightAt(point.x + nx * candidate, point.z + nz * candidate, point.y) !== null) {
              // Step one notch further in, so the car's width is on the road too.
              best = candidate + sign * 0.25;
              break;
            }
          }
        }
        if (best !== null) { car.offset = best; car.targetOffset = best; }
      }
      const x = point.x + nx * car.offset;
      const z = point.z + nz * car.offset;
      const ground = circuit.heightAt(x, z, point.y) ?? point.y;
      car.root.position.set(x, ground + RIDE_HEIGHT, z);

      // Pitch with the road so the nose and tail do not dig into slopes.
      const behind = circuit.lineAt(car.lineDistance - 3), aheadP = circuit.lineAt(car.lineDistance + 3);
      const pitch = Math.atan2(aheadP.y - behind.y, 6);
      const roll = clamp(-point.curvature * car.speed * car.speed * 0.0009, -0.08, 0.08);
      car.bodyRoll += (roll - car.bodyRoll) * Math.min(1, h * 4);
      yawQuat.setFromAxisAngle(up, Math.atan2(point.tx, point.tz));
      pitchQuat.setFromAxisAngle(across, -pitch);
      rollQuat.setFromAxisAngle(forwardAxis, car.bodyRoll);
      car.root.quaternion.copy(yawQuat).multiply(pitchQuat).multiply(rollQuat);

      // --- progress, from where the car actually is ---
      const located = circuit.locate(x, z);
      let delta = located.distance - car.lapDistance;
      if (delta < -circuit.lapLength / 2) delta += circuit.lapLength;
      if (delta > circuit.lapLength / 2) delta -= circuit.lapLength;
      if (Math.abs(delta) < 80) car.progress += delta;
      car.lapDistance = located.distance;
      car.centreOffset = located.offset;

      // --- wheels ---
      car.spinAngle = (car.spinAngle + (car.speed / 0.375) * h) % (Math.PI * 2);
      // Left turns have negative curvature here, and a positive Y rotation
      // turns the wheel left — so the sign is flipped, as for the player's car.
      const steerAngle = clamp(-point.curvature * 3.54, -0.35, 0.35);
      for (const wheel of car.wheels) {
        wheel.spin.rotation.x = car.spinAngle;
        if (wheel.front) wheel.steer.rotation.y = steerAngle;
      }

      car.state.speedKmh = car.speed * 3.6;
      car.state.rpm = 5000 + Math.min(1, car.speed / TOP_SPEED) * 9000;
    }
  }

  /**
   * Race order. Distance covered is the only honest measure — lap count plus
   * position within the lap — and gaps are expressed in seconds at the
   * player's current pace, which is how a real timing screen reads.
   */
  function classification(playerState) {
    const L = circuit.lapLength;
    const entries = cars.map(car => ({
      name: car.name, isPlayer: false, colour: car.colour,
      progress: car.progress, speed: car.speed, best: null,
      lap: Math.max(1, Math.floor(car.progress / L) + 1),
    }));
    if (playerState && player.progress !== null) {
      entries.push({
        name: 'You', isPlayer: true, colour: '#ffffff',
        progress: player.progress, speed: Math.abs(playerState.speed ?? 0), best: null,
        lap: Math.max(1, Math.floor(player.progress / L) + 1),
      });
    }
    entries.sort((a, b) => b.progress - a.progress);
    const leader = entries[0];
    const me = entries.find(e => e.isPlayer);
    for (const entry of entries) {
      entry.gapToLeader = (leader.progress - entry.progress) / Math.max(entry.speed, 20);
      entry.gapToPlayer = me ? Math.abs(entry.progress - me.progress) / Math.max(entry.speed, 20) : null;
    }
    return entries;
  }

  function setCount() { /* field size is fixed for a session */ }
  function setSkill(value) {
    const skill = clamp(value, 0, 1);
    cars.forEach((car, i) => {
      const spread = (i / Math.max(1, cars.length - 1)) - 0.5;
      car.skill = clamp(skill - spread * 0.18, 0.3, 1);
      car.commit = 0.9 + 0.1 * car.skill;
    });
  }

  function dispose() {
    for (const car of cars) {
      car.root.traverse(object => { if (object.isMesh) object.geometry?.dispose?.(); });
    }
    for (const item of disposables) item?.dispose?.();
    scene.remove(root);
    cars.length = 0;
  }

  return { cars, root, step, classification, setCount, setSkill, dispose,
    get playerProgress() { return player.progress; } };
}

/**
 * Clone the player's car for a rival, with a recoloured livery.
 *
 * The GLB has one baked material covering the whole car, so a livery cannot be
 * a material swap. `makeLiveryTexture` hue-rotates the base-colour texture
 * while masking by saturation, leaving tyres, carbon and the driver alone.
 * Geometry is shared between every car — only the material differs.
 */
function buildCarVisual(template, team, renderer) {
  const root = new THREE.Group();
  root.name = `AI ${team.name}`;
  const wheels = [];
  const disposable = [];

  if (!template) {
    // The car asset failed to load; a coloured block still makes the race legible.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.7, 5.2),
      new THREE.MeshStandardMaterial({ color: team.colour, roughness: 0.45, metalness: 0.3 }));
    body.castShadow = true;
    root.add(body);
    return { root, wheels, disposable };
  }

  const material = template.material.clone();
  if (template.material.map) {
    const livery = makeLiveryTexture(template.material.map, team.hue, 1.05);
    livery.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
    material.map = livery;
    disposable.push(livery);
  }
  material.needsUpdate = true;
  disposable.push(material);

  const chassis = new THREE.Group();
  root.add(chassis);

  // Rebuild the same hierarchy the player's car uses, sharing all geometry.
  for (const child of template.chassis.children) {
    if (child.isMesh) {
      const mesh = new THREE.Mesh(child.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      chassis.add(mesh);
    }
  }
  for (const wheel of template.wheels) {
    const steer = new THREE.Group();
    const spin = new THREE.Group();
    const fairing = new THREE.Group();          // covers and ducts: steer, never spin
    steer.position.copy(wheel.steer.position);
    steer.add(spin, fairing);
    chassis.add(steer);
    for (const [from, to] of [[wheel.spin, spin], [wheel.fairing, fairing]]) {
      for (const child of from?.children ?? []) {
        if (!child.isMesh) continue;
        const mesh = new THREE.Mesh(child.geometry, material);
        mesh.castShadow = true;
        to.add(mesh);
      }
    }
    wheels.push({ steer, spin, fairing, front: wheel.index < 2 });
  }

  return { root, wheels, disposable };
}
