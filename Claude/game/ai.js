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

    cars.push({
      id: i,
      name: team.name,
      colour: team.colour,
      livery: team.hue,
      root: visual.root,
      wheels: visual.wheels,
      skill,
      aggression,
      lapDistance: located.distance,
      offset: located.offset,
      targetOffset: located.offset,
      speed: 0,
      lap: 0,
      totalDistance: 0,
      spinAngle: 0,
      bodyRoll: 0,
      lastDistance: located.distance,
      state: { speedKmh: 0, rpm: 6000 },
    });
  }

  const forwardVector = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  /**
   * One AI step. Everything is in corridor space until the final transform.
   */
  function step(dt, playerState) {
    if (!cars.length) return;
    const step = Math.min(dt, 0.05);

    // Where is everyone, including the player, so cars can react to each other.
    const traffic = cars.map(car => ({ car, distance: car.lapDistance, offset: car.offset }));
    if (playerState) {
      traffic.push({ car: null, distance: playerState.lapDistance ?? 0, offset: playerState.lateralOffset ?? 0 });
    }

    for (const car of cars) {
      // --- target speed from the solved racing line, scaled by skill ---
      const lookaheadDistance = 12 + car.speed * 1.35;
      const here = circuit.lineAt(car.lapDistance);
      const ahead = circuit.lineAt(car.lapDistance + lookaheadDistance);
      const farther = circuit.lineAt(car.lapDistance + lookaheadDistance * 2.1);

      // Brake for the slowest thing within the lookahead, not just the point
      // directly ahead — that is what produces a realistic braking point.
      const limit = Math.min(here.targetSpeed, ahead.targetSpeed, farther.targetSpeed);
      let target = limit * (0.80 + car.skill * 0.22);

      // --- traffic ---
      let blocked = false;
      let closingOn = null;
      for (const other of traffic) {
        if (other.car === car) continue;
        const gap = circuit.gapAlong(car.lapDistance, other.distance);
        if (gap < 0 || gap > 42) continue;
        const lateral = Math.abs(other.offset - car.offset);
        if (lateral < 2.6) {
          blocked = true;
          closingOn = other;
          // Slow to match if we are right behind, unless we can get alongside.
          const urgency = clamp(1 - gap / 42, 0, 1);
          const otherSpeed = other.car ? other.car.speed : Math.abs(playerState?.speed ?? target);
          target = Math.min(target, otherSpeed + (1 - urgency) * 9 + car.aggression * 4);
        }
      }

      // --- longitudinal dynamics ---
      // Real limits: an F1 car brakes far harder than it accelerates, and
      // acceleration falls away with speed as drag builds.
      const accelerationLimit = (11.5 - Math.min(car.speed * 0.028, 7.5)) * (0.85 + car.skill * 0.2);
      const brakingLimit = 38 * (0.8 + car.skill * 0.25);
      const error = target - car.speed;
      const acceleration = error > 0
        ? Math.min(error / Math.max(step, 1e-3), accelerationLimit)
        : Math.max(error / Math.max(step, 1e-3), -brakingLimit);
      car.speed = Math.max(0, car.speed + acceleration * step);

      // --- lateral: follow the racing line, move off it to pass or defend ---
      let desiredOffset = ahead.offset ?? 0;
      if (blocked && closingOn) {
        const gap = circuit.gapAlong(car.lapDistance, closingOn.distance);
        if (gap < 26 && car.speed > 12) {
          // Pick whichever side has more room and commit proportionally to
          // aggression. Timid drivers just sit behind.
          const sample = circuit.centreline[circuit.locate(here.x, here.z).index];
          const room = Math.max(3, (sample?.width ?? 10) / 2 - 1.4);
          const side = closingOn.offset >= 0 ? -1 : 1;
          desiredOffset = clamp(closingOn.offset + side * 2.9, -room, room);
          desiredOffset = ahead.offset + (desiredOffset - ahead.offset) * car.aggression;
        }
      }
      car.targetOffset += (desiredOffset - car.targetOffset) * Math.min(1, step * 3.2);
      car.offset += (car.targetOffset - car.offset) * Math.min(1, step * 2.6);

      // --- advance around the lap ---
      const travelled = car.speed * step;
      const previous = car.lapDistance;
      car.lapDistance = (car.lapDistance + travelled) % circuit.lapLength;
      car.totalDistance += travelled;
      if (car.lapDistance < previous - circuit.lapLength * 0.5) car.lap++;

      // --- place the visual ---
      const point = circuit.lineAt(car.lapDistance);
      const located = circuit.locate(point.x, point.z);
      const sample = circuit.centreline[located.index];
      const lateral = car.offset - (point.offset ?? 0);
      const x = point.x + (sample?.nx ?? 0) * lateral;
      const z = point.z + (sample?.nz ?? 0) * lateral;
      const ground = circuit.heightAt(x, z, point.y);
      car.root.position.set(x, (ground ?? point.y) + 0.12, z);

      const yaw = Math.atan2(point.tx, point.tz);
      // Lean into the corner a little; it reads as load even without physics.
      const roll = clamp(-point.curvature * car.speed * car.speed * 0.0009, -0.09, 0.09);
      car.bodyRoll += (roll - car.bodyRoll) * Math.min(1, step * 4);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const rollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), car.bodyRoll);
      car.root.quaternion.copy(quaternion).multiply(rollQuat);

      // Wheels.
      car.spinAngle = (car.spinAngle + (car.speed / 0.375) * step) % (Math.PI * 2);
      const steer = clamp(point.curvature * 90, -0.35, 0.35);
      for (const wheel of car.wheels) {
        wheel.spin.rotation.x = car.spinAngle;
        if (wheel.front) wheel.steer.rotation.y = steer;
      }

      car.state.speedKmh = car.speed * 3.6;
      car.state.rpm = 5000 + Math.min(1, car.speed / 90) * 9000;
      car.lastDistance = previous;
    }
  }

  /**
   * Race order. Distance covered is the only honest measure — lap count plus
   * position within the lap — and gaps are expressed in seconds at the
   * player's current pace, which is how a real timing screen reads.
   */
  function classification(playerState, playerLap = 0) {
    const entries = cars.map(car => ({
      name: car.name,
      isPlayer: false,
      lap: car.lap,
      progress: car.lap * circuit.lapLength + car.lapDistance,
      speed: car.speed,
      best: car.bestLap ?? null,
      colour: car.colour,
    }));
    if (playerState) {
      entries.push({
        name: 'You',
        isPlayer: true,
        lap: playerLap,
        progress: playerLap * circuit.lapLength + (playerState.lapDistance ?? 0),
        speed: Math.abs(playerState.speed ?? 0),
        best: null,
        colour: '#ffffff',
      });
    }
    entries.sort((a, b) => b.progress - a.progress);
    const leader = entries[0];
    for (const entry of entries) {
      const gapMetres = leader.progress - entry.progress;
      const pace = Math.max(entry.speed, 20);
      entry.gapToLeader = gapMetres / pace;
    }
    const player = entries.find(e => e.isPlayer);
    for (const entry of entries) {
      entry.gapToPlayer = player
        ? Math.abs(entry.progress - player.progress) / Math.max(entry.speed, 20)
        : null;
    }
    return entries;
  }

  function setCount() { /* field size is fixed for a session */ }
  function setSkill(value) {
    const skill = clamp(value, 0, 1);
    cars.forEach((car, i) => {
      const spread = (i / Math.max(1, cars.length - 1)) - 0.5;
      car.skill = clamp(skill - spread * 0.18, 0.3, 1);
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

  return { cars, root, step, classification, setCount, setSkill, dispose };
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
    steer.position.copy(wheel.steer.position);
    steer.add(spin);
    chassis.add(steer);
    for (const child of wheel.spin.children) {
      if (!child.isMesh) continue;
      const mesh = new THREE.Mesh(child.geometry, material);
      mesh.castShadow = true;
      spin.add(mesh);
    }
    wheels.push({ steer, spin, front: wheel.index < 2 });
  }

  return { root, wheels, disposable };
}
