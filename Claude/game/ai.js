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

/**
 * The opponents. Each is a real 2023 car by Redgrund, the modeller of the
 * player's RB19, processed identically (see render/car.js). Red Bull is the
 * player's car and is never given to an opponent.
 *
 * Mercedes is deliberately absent: that model is licensed CC BY-NC-ND, which
 * forbids publishing the modified copy this game would need. Every car here is
 * CC BY 4.0. See CREDITS.md.
 */
const TEAMS = [
  { name: 'Ferrari',      colour: '#e8002d', hue: 0.52, model: 'ferrari-sf23.glb' },
  { name: 'McLaren',      colour: '#ff8000', hue: 0.13, model: 'mclaren-mcl60.glb' },
  { name: 'Aston Martin', colour: '#00594f', hue: 0.42, model: 'aston-martin-amr23.glb' },
  { name: 'Alpine',       colour: '#0093cc', hue: 0.62, model: 'alpine-a523.glb' },
  { name: 'AlphaTauri',   colour: '#2b4562', hue: 0.75, model: 'alphatauri-at04.glb' },
];

/**
 * Deal team cars to the grid so no brand repeats until every brand has been
 * used. Six opponents get six different cars; the seventh starts a fresh
 * shuffle, so twelve opponents are two of each.
 */
function dealTeams(count, seed = Math.random()) {
  const order = [];
  let pool = [];
  let salt = seed;
  for (let i = 0; i < count; i++) {
    if (!pool.length) {
      pool = TEAMS.map((_, k) => k);
      for (let k = pool.length - 1; k > 0; k--) {          // Fisher-Yates
        salt = (salt * 9301 + 49297) % 233280;
        const j = Math.floor((salt / 233280) * (k + 1));
        [pool[k], pool[j]] = [pool[j], pool[k]];
      }
    }
    order.push(pool.shift());
  }
  return order;
}


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
const RIDE_HEIGHT = 0.585;
// km/h at the top of each of the 8 gears, for a believable engine note.
const GEAR_TOPS = [95, 135, 170, 205, 240, 270, 295, 340];
// Car footprint for contact resolution: an F1 car is ~5.6 m long, ~2.0 m wide.
const HALF_LENGTH = 2.8;
const HALF_WIDTH = 1.0;
const CONTACT_LONG = HALF_LENGTH * 2 + 0.3;   // nose-to-tail clearance kept between cars
const CONTACT_LAT = HALF_WIDTH * 2 + 0.2;     // side-by-side clearance
const FOLLOW_GAP = 8;                          // metres a car sits behind one it cannot pass
// Being hit. A knocked car keeps the speed it was given until its tyres scrub
// it off, and slews about its own axis until they arrest that too.
const KNOCK_FRICTION = 8;      // m/s^2 bled off a sideways shove
const KNOCK_SPIN_DAMP = 1.8;   // per second, how quickly a slew is caught
const KNOCK_MAX = 8;           // m/s, the most one step of an impact may add
const KNOCK_SPIN_MAX = 2.6;    // rad/s

/**
 * How much of the car's limit a driver uses, by grid position. The field is
 * lined up fastest-first like a qualifying order, and the spread is wide
 * enough (~8.5% from pole to the back) that the cars string out over the first
 * half-lap instead of running as one pack for the whole race.
 */
function paceFor(rank, skill, seed) {
  const jitter = (Math.sin(seed * 12.9898) * 0.5 + 0.5) * 0.012 - 0.006;
  return clamp((0.93 + 0.07 * skill) * (1 - 0.085 * rank) + jitter, 0.75, 1.0);
}

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
  // Field size is limited by grid slots, not by how many teams exist: with
  // more opponents than teams the extra cars reuse a brand (see dealTeams).
  const count = Math.round(clamp(options.count ?? 9, 0, Math.max(1, (options.gridSlots?.length ?? 20) - 1)));
  const baseSkill = clamp(options.skill ?? 0.7, 0, 1);
  const gridSlots = options.gridSlots ?? [];
  const playerSlot = options.playerSlot ?? 0;
  const template = options.carAsset;
  // One loaded model per team, keyed by file name. Missing ones fall back to a
  // recoloured copy of the player's car so a failed download cannot empty the grid.
  const models = options.rivalAssets ?? new Map();
  const teamOrder = dealTeams(count, options.teamSeed);
  // With more opponents than teams a brand appears twice; number them so the
  // timing screen never shows two identical entries.
  const teamCount = {}, teamSeen = {};
  for (const t of teamOrder) { const n = TEAMS[t].name; teamCount[n] = (teamCount[n] ?? 0) + 1; teamSeen[n] = 0; }

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
  // Wheel steer/spin animation can be switched off on low-power devices.
  let animateWheels = options.animateWheels !== false;
  // Car-to-car contact. Off: cars may pass through each other (the original
  // behaviour). On: nobody can occupy another car's space — AI cars are
  // resolved against each other here, and each gets a kinematic physics body
  // so the player's car hits them instead of driving through.
  let contact = !!options.collisions;

  for (let i = 0; i < count; i++) {
    const team = TEAMS[teamOrder[i] ?? (i % TEAMS.length)];
    const slot = slots[i] ?? gridSlots[0];
    const located = slot ? circuit.locate(slot.position.x, slot.position.z) : { distance: 0, offset: 0 };

    // Per-driver character. Skill sets the fraction of the car's limit they
    // use; aggression governs how willingly they take a gap and how late they
    // brake. Both are spread around the requested skill so a field has variety.
    const rank = i / Math.max(1, count - 1);          // 0 = front of the grid
    const skill = clamp(baseSkill, 0.30, 1.0);
    const aggression = clamp(0.45 + (Math.sin(i * 78.233) * 0.5 + 0.5) * 0.5, 0.25, 0.98);

    const visual = buildCarVisual(models.get(team.model) ?? template, team, options.renderer);
    if (visual.disposable) disposables.push(...visual.disposable);
    root.add(visual.root);

    // Where on the racing line this grid slot sits, and how far off the line.
    const lineDistance = located.distance / circuit.lapLength * circuit.racingLineLength;
    const onLine = circuit.lineAt(lineDistance);
    const startOffset = located.offset - onLine.offset;

    cars.push({
      id: i,
      name: teamCount[team.name] > 1 ? `${team.name} ${++teamSeen[team.name]}` : team.name,
      colour: team.colour,
      livery: team.hue,
      root: visual.root,
      wheels: visual.wheels,
      sharedGeometry: !!visual.shared,
      skill,
      rank,
      aggression,
      // How close to the car's measured limit this driver commits. The front
      // of the grid at skill 1 drives at the player's car's full measured pace.
      commit: paceFor(rank, skill, i),
      // Slower cars also pull away a little more gently, so the gaps open on
      // the straights as well as in the corners.
      power: 1 - 0.12 * rank,
      launchDelay: 0,
      lineDistance,                 // along the racing line: drives the motion
      lapDistance: located.distance, // along the centreline: comparable with the player
      offset: startOffset,          // metres left of the racing line
      targetOffset: startOffset,
      speed: 0,
      progress: signedStart(located.distance),
      startProgress: signedStart(located.distance),
      gridLane: located.offset ?? 0,  // centreline offset of its grid box
      spinAngle: 0,
      bodyRoll: 0,
      lateralVel: 0,        // m/s sideways from being hit, + = toward its left
      slew: 0,              // radians the car is turned across its path
      slewRate: 0,
      recover: 0,           // seconds spent gathering it up again after a hit
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
  let lastStep = 1 / 120;

  function step(dt, playerState) {
    if (!cars.length) return;
    const h = Math.min(dt, 0.05);
    lastStep = Math.max(h, 1e-3);
    trackPlayer(playerState);

    // Everyone on track, in centreline progress/offset terms.
    const traffic = cars.map(car => ({ car, progress: car.progress, offset: car.centreOffset ?? 0, speed: car.speed }));
    if (playerState && player.progress !== null) {
      traffic.push({ car: null, progress: player.progress, offset: playerState.lateralOffset ?? 0,
        speed: Math.abs(playerState.speed ?? 0) });
    }

    // 1. Plan: speed, lateral position and distance for every car.
    for (const car of cars) {
      car.prevLineDistance = car.lineDistance;
      planCar(car, traffic, h);
    }

    // 2. No car may occupy another's space. With contact on, overlaps are
    //    resolved here before anything is drawn, so nobody drives through
    //    anybody; with it off, cars still follow and pass but may overlap.
    if (contact) resolveContacts(playerState);

    // 3. Place: surface, heading, wheels, progress, engine state.
    for (const car of cars) placeCar(car, h);
  }

  function planCar(car, traffic, h) {
      const here = circuit.lineAt(car.lineDistance);

      // Reaction time off the line.
      if (car.launchDelay > 0) { car.launchDelay -= h; car.speed = 0; car.state.throttle = 1; return; }

      // --- speed: the measured pace a quarter-second ahead, so braking starts in time ---
      let target = paceAt(car.lineDistance + car.speed * 0.25) * car.commit;

      // --- traffic ---
      const myOffset = here.offset + car.offset;             // centreline-relative
      let closingOn = null, closest = Infinity;
      for (const other of traffic) {
        if (other.car === car) continue;
        const gap = other.progress - car.progress;
        if (gap <= 0 || gap > 45) continue;
        if (Math.abs(other.offset - myOffset) >= CONTACT_LAT + 0.2) continue;
        if (gap < closest) { closest = gap; closingOn = other; }
      }
      if (closingOn) {
        // Match the car ahead's speed at FOLLOW_GAP, slower if closer, and
        // only close up as fast as there is room to brake. This is what stops
        // them driving into the back of each other; passing is done by
        // stepping out of line below, which frees this limit.
        const room = Math.max(0, closest - FOLLOW_GAP);
        const brake = table(BRAKE, car.speed) * 0.7;
        let follow = Math.sqrt(closingOn.speed * closingOn.speed + 2 * brake * room) - (closest < FOLLOW_GAP ? (FOLLOW_GAP - closest) : 0);
        // Stuck behind something slow or stopped: creep so there is motion to
        // steer round it with. The contact solver still keeps the noses apart.
        if (closingOn.speed < 4 && (closest > CONTACT_LONG + 0.6 || crawl(car) > 0)) follow = Math.max(follow, 3);
        target = Math.min(target, Math.max(0, follow));
      }

      // --- longitudinal: the player's measured acceleration and braking ---
      // Sideways and sideways-on, a car has no traction to use: after contact
      // it runs down to a slower speed before picking the pace back up.
      if (car.recover > 0 || Math.abs(car.slew) > 0.08) {
        target = Math.min(target, car.speed * (1 - Math.min(0.9, Math.abs(car.slew)) * 0.35));
      }
      const drs = Math.abs(here.curvature) < DRS_CURVATURE;
      if (target > car.speed) {
        car.speed = Math.min(target, car.speed + table(drs ? ACCEL_DRS : ACCEL, car.speed) * car.power * h);
        car.state.throttle = 1;
      } else {
        car.state.throttle = target < car.speed - 0.5 ? 0 : 0.35;
        car.speed = Math.max(target, car.speed - table(BRAKE, car.speed) * h);
      }
      car.speed = clamp(car.speed, 0, drs ? TOP_SPEED_DRS : TOP_SPEED);

      // --- lateral: stay on the line, step aside to pass ---
      // Off the start, hold the grid lane and drive straight; drift across to
      // the racing line only once the field is rolling (from ~150 m to ~650 m),
      // the way a real start funnels in rather than everyone diving at once.
      const travelled = car.progress - car.startProgress;
      const keepLane = clamp(1 - (travelled - 150) / 500, 0, 1);
      let desired = keepLane * (car.gridLane - here.offset);
      if (closingOn && closest < 30 && (car.speed > 0.5 || closingOn.speed < 0.5)) {
        // Go round on whichever side has more road.
        const room = here.halfWidth - 1.2;
        const spaceLeft = room - closingOn.offset, spaceRight = room + closingOn.offset;
        // Commit to a side per car being passed; re-deciding every step made
        // cars dither left-right behind a stopped car.
        const who = closingOn.car ?? 'player';
        if (car.passing !== who || !car.passSide) {
          car.passing = who;
          car.passSide = spaceLeft >= spaceRight ? 1 : -1;
        }
        const side = car.passSide;
        // Aim fully clear of it — a half-committed move just ends up stuck
        // alongside its rear wheel.
        const wantCentre = closingOn.offset + side * (CONTACT_LAT + 0.8);
        desired = wantCentre - here.offset;
        if (keepLane > 0 && closingOn.speed > 0.5) desired = keepLane * (car.gridLane - here.offset);  // no lane changes in the launch
      }
      // A car that has been hit is not driving for a moment: it is sliding
      // where the impact put it and catching the slide. Only once that has
      // settled does it go back to chasing the line.
      if (car.recover > 0) {
        car.recover = Math.max(0, car.recover - h);
        desired = car.targetOffset;                 // stop asking for a new line mid-slide
      }
      if (car.lateralVel) {
        car.offset += car.lateralVel * h;
        car.targetOffset += car.lateralVel * h * 0.5;
        const scrub = KNOCK_FRICTION * h;
        car.lateralVel = Math.abs(car.lateralVel) <= scrub ? 0
          : car.lateralVel - Math.sign(car.lateralVel) * scrub;
      }
      if (car.slewRate || car.slew) {
        car.slew = clamp(car.slew + car.slewRate * h, -1.4, 1.4);
        car.slewRate *= Math.max(0, 1 - KNOCK_SPIN_DAMP * h);
        // The driver catches it: opposite lock brings the car straight again.
        car.slew -= car.slew * Math.min(1, h * (1.4 + car.speed * 0.05));
        if (Math.abs(car.slew) < 0.004 && Math.abs(car.slewRate) < 0.02) { car.slew = 0; car.slewRate = 0; }
      }

      car.targetOffset += (desired - car.targetOffset) * Math.min(1, h * 3.0);
      // Sideways speed is limited by forward speed — a real car cannot move
      // across the track without driving along it.
      const lateralStep = (car.targetOffset - car.offset) * Math.min(1, h * 2.4);
      // Sideways speed is a fraction of forward speed — up to ~25 degrees of
      // heading at a crawl (full lock), ~11 degrees at racing speed. Standing
      // still, a car cannot move sideways at all.
      const maxLateral = car.speed * (0.2 + 0.25 / (1 + car.speed / 8)) * h;
      car.offset += clamp(lateralStep, -maxLateral, maxLateral);
      // Never leave the tarmac under power — but a car that has just been hit
      // can be pushed wide onto the edge of the road, as it would be.
      const limit = Math.max(0, here.halfWidth - 1.1) + (car.recover > 0 ? 1.6 : 0);
      car.offset = clamp(here.offset + car.offset, -limit, limit) - here.offset;
      if (!Number.isFinite(car.offset)) car.offset = 0;
      if (!Number.isFinite(car.targetOffset)) car.targetOffset = 0;

      // --- advance ---
      car.lineDistance = (car.lineDistance + car.speed * h) % circuit.racingLineLength;
  }

  /* ------------------------------------------------------------ contact */

  // Planned world position and heading frame of a car, from its line state.
  function pose(car) {
    const p = circuit.lineAt(car.lineDistance);
    car.px = p.x - p.tz * car.offset;
    car.pz = p.z + p.tx * car.offset;
    // The car's real heading once it has one: a car pulling out to pass is
    // angled across the track and its footprint must be measured that way.
    const facing = car.facing ?? car.yaw;
    if (facing !== undefined) { car.fx = Math.sin(facing); car.fz = Math.cos(facing); }
    else { car.fx = p.tx; car.fz = p.tz; }
    car.halfWidthHere = p.halfWidth;
    car.lineOffsetHere = p.offset;
  }

  const L = () => circuit.racingLineLength;
  const wrap = d => ((d % L()) + L()) % L();

  /** Clamp a car's lateral offset back inside the road after a push. */
  function keepOnRoad(car) {
    const limit = Math.max(0, (car.halfWidthHere ?? 5) - 1.1) + (car.recover > 0 ? 1.6 : 0);
    const base = car.lineOffsetHere ?? 0;
    car.offset = clamp(base + car.offset, -limit, limit) - base;
    car.targetOffset = car.offset;
  }

  /**
   * Separate overlapping cars. Each pair is measured in the rear car's frame:
   * mostly side-by-side contact pushes them apart sideways (both cars share
   * it, or only the AI when the other is the player); nose-to-tail contact
   * holds the car behind back and takes away its excess speed — it has to
   * brake, it cannot go through.
   */
  // How far a contact correction may move a car in one step. A car that is
  // teleported out of an overlap looks, to the physics engine, like one moving
  // at hundreds of km/h, and hitting the player with that launched them across
  // the circuit. Corrections are fed in at walking pace instead, so the worst
  // case is a car easing out of an overlap over a few frames.
  const MAX_CORRECTION = 1.5;            // metres per second
  let correctionLimit = 0.05;
  let exchange = false;                  // momentum is traded on the first pass only

  function resolveContacts(playerState) {
    correctionLimit = Math.max(0.002, MAX_CORRECTION * lastStep);
    let hasPlayer = false;
    const p3 = { x: 0, z: 0, vx: 0, vz: 0 };
    if (playerState?.position && player.progress !== null) {
      p3.x = playerState.position.x; p3.z = playerState.position.z;
      p3.vx = playerState.velocity?.x ?? 0; p3.vz = playerState.velocity?.z ?? 0;
      hasPlayer = true;
    }
    // Momentum is exchanged once per physics step; the later passes only tidy
    // up overlaps. Trading it on every pass would treat one bump as three.
    for (let iteration = 0; iteration < 3; iteration++) {
      exchange = iteration === 0;
      for (const car of cars) pose(car);
      for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) separate(cars[i], cars[j]);
      }
      if (hasPlayer) for (const car of cars) separateFromPlayer(car, p3);
    }
  }

  // A car part-way out of line to get round a stopped one keeps crawling, so
  // it can finish steering out rather than freezing nose-to-tail. It is still
  // held back positionally, so it never goes through.
  const crawl = car => (Math.abs(car.targetOffset - car.offset) > 0.3 ? 2.5 : 0);

  /**
   * Transfer momentum into a car that has been hit.
   *
   * The cars are the same mass, so a shunt splits the closing speed between
   * them. Along the car it changes its speed; across the car it shoves it
   * sideways; and because a hit lands at one end rather than the middle, it
   * also slews the car — catch a rival's rear corner and its back end steps
   * out, which is what makes contact look like contact.
   */
  function applyImpact(car, dvAlong, dvLateral, contactAlong) {
    const scale = Math.min(1, KNOCK_MAX / Math.max(1e-3, Math.hypot(dvAlong, dvLateral)));
    const along = dvAlong * scale, lateral = dvLateral * scale;
    car.speed = Math.max(0, car.speed + along);
    car.lateralVel = clamp((car.lateralVel ?? 0) + lateral, -KNOCK_MAX, KNOCK_MAX);
    // Hit at the back: the tail swings the way it was pushed and the nose goes
    // the other way. Hit at the front: the reverse.
    const arm = contactAlong < 0 ? 1 : -1;
    car.slewRate = clamp((car.slewRate ?? 0) + arm * lateral * 0.42, -KNOCK_SPIN_MAX, KNOCK_SPIN_MAX);
    car.recover = Math.max(car.recover ?? 0, clamp(Math.hypot(along, lateral) * 0.3, 0.3, 2.5));
    car.passing = null;                         // whatever it was doing, it is not doing it now
  }

  /** Push a car by a world-space velocity change. */
  function hit(car, dvx, dvz, contactAlong) {
    // Speed and sideways shove are both measured along the car's path, which
    // is where they act — the slew is only how far the car is turned in it.
    const fx = Math.sin(car.yaw ?? 0), fz = Math.cos(car.yaw ?? 0);
    applyImpact(car, dvx * fx + dvz * fz, -dvx * fz + dvz * fx, contactAlong);
  }

  /** Velocity of an AI car in world space, including any shove it is carrying. */
  function velocityOf(car) {
    const fx = Math.sin(car.yaw ?? 0), fz = Math.cos(car.yaw ?? 0);
    const lx = -fz, lz = fx;
    const lat = car.lateralVel ?? 0;
    return { x: fx * car.speed + lx * lat, z: fz * car.speed + lz * lat };
  }

  function separate(a, b) {
    const dx = b.px - a.px, dz = b.pz - a.pz;
    if (dx * dx + dz * dz > 49) return;
    const along = dx * a.fx + dz * a.fz;
    const lateral = -dx * a.fz + dz * a.fx;                 // + = b is to a's left
    const penLong = CONTACT_LONG - Math.abs(along);
    const penLat = CONTACT_LAT - Math.abs(lateral);
    if (penLong <= 0 || penLat <= 0) return;

    // Momentum first: equal masses, so each car takes half of whatever they
    // were closing at. This is what makes one car knock another aside instead
    // of the pair sliding apart like magnets.
    const va = velocityOf(a), vb = velocityOf(b);
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist, nz = dz / dist;                    // a -> b
    const closing = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
    if (exchange && closing > 0.5) {
      const share = closing * 0.5;
      hit(a, -share * nx, -share * nz, along);
      hit(b, share * nx, share * nz, -along);
    }

    if (penLat < penLong && penLat < 1.2) {
      const side = lateral >= 0 ? 1 : -1;
      const push = Math.min(penLat / 2, correctionLimit);
      a.offset -= side * push; b.offset += side * push;
      keepOnRoad(a); keepOnRoad(b);
    } else {
      const [behind, ahead] = along >= 0 ? [a, b] : [b, a];
      behind.lineDistance = wrap(behind.lineDistance - Math.min(penLong, correctionLimit));
      behind.speed = Math.min(behind.speed, Math.max(ahead.speed, crawl(behind)));
    }
    pose(a); pose(b);
  }

  function separateFromPlayer(car, player3) {
    const dx = player3.x - car.px, dz = player3.z - car.pz;
    if (dx * dx + dz * dz > 49) return;
    const along = dx * car.fx + dz * car.fz;
    const lateral = -dx * car.fz + dz * car.fx;
    const penLong = CONTACT_LONG - Math.abs(along);
    const penLat = CONTACT_LAT - Math.abs(lateral);
    if (penLong <= 0 || penLat <= 0) return;

    // The player is a real, heavy car: a rival hit by one takes most of the
    // closing speed rather than brushing it off. Run into the back of one and
    // it is fired forward; catch its rear corner and it slews out of your way.
    const mine = velocityOf(car);
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist, nz = dz / dist;                    // rival -> player
    const closing = (player3.vx - mine.x) * nx + (player3.vz - mine.z) * nz;
    if (exchange && closing < -0.5) {                        // player driving into the rival
      const share = -closing * 0.75;
      hit(car, -share * nx, -share * nz, along);
    }

    // Then just enough positional correction that the two never sit inside
    // each other; the engine handles the player's own half of the contact.
    if (penLat < penLong && penLat < 1.2) {
      car.offset -= (lateral >= 0 ? 1 : -1) * Math.min(penLat, correctionLimit);
      keepOnRoad(car);
    } else if (along > 0) {
      car.lineDistance = wrap(car.lineDistance - Math.min(penLong, correctionLimit));
    }
    pose(car);
  }

  function placeCar(car, h) {
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

      // Heading follows the direction the car is ACTUALLY moving, not the
      // racing line's tangent. Before, a car stepping aside to pass kept
      // pointing straight down the line and slid sideways like a crab; now it
      // turns toward where it is going, exactly as a real car has to.
      const moveX = x - car.lastX, moveZ = z - car.lastZ;
      const moved = Math.hypot(moveX, moveZ);
      let yaw = car.yaw ?? Math.atan2(point.tx, point.tz);
      // Only forward motion steers the heading: being held back by the car in
      // front moves a car slightly backwards, which is not a U-turn.
      const forwardMove = moveX * point.tx + moveZ * point.tz;
      if (Number.isFinite(car.lastX) && moved > 0.02 && forwardMove > 0.01) {
        const target = Math.atan2(moveX, moveZ);
        let dy = target - yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        // A car turns only by rolling forward on steered wheels: its yaw rate
        // is capped at speed x tan(full lock) / wheelbase, so at a crawl it
        // can barely rotate at all.
        const maxTurn = Math.max(car.speed, forwardMove / Math.max(h, 1e-3)) * Math.tan(0.44) / 3.54 * h;
        yaw += clamp(dy * Math.min(1, h * 14), -maxTurn, maxTurn);
      } else if (!Number.isFinite(car.lastX)) {
        yaw = Math.atan2(point.tx, point.tz);
      }
      let yawRate = 0;
      if (car.yaw !== undefined) {
        let dy = yaw - car.yaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        yawRate = dy / Math.max(h, 1e-3);
      }
      car.vx = moved > 0 && h > 0 ? moveX / h : 0;
      car.vz = moved > 0 && h > 0 ? moveZ / h : 0;
      car.lastX = x; car.lastZ = z;
      car.yaw = yaw;                    // the direction it is travelling
      // What it points at: its direction of travel, plus however far a knock
      // has it turned across that path. Kept separate so a slide cannot feed
      // back into the heading and spiral.
      car.facing = yaw + (car.slew ?? 0);

      // Roll outward in proportion to lateral acceleration (speed x yaw rate).
      const lateralG = car.speed * (car.yawRateSmooth ?? yawRate) / 9.81;
      const roll = clamp(lateralG * 0.012, -0.06, 0.06);
      car.bodyRoll += (roll - car.bodyRoll) * Math.min(1, h * 4);
      yawQuat.setFromAxisAngle(up, yaw + (car.slew ?? 0));
      pitchQuat.setFromAxisAngle(across, -pitch);
      rollQuat.setFromAxisAngle(forwardAxis, car.bodyRoll);
      car.root.quaternion.copy(yawQuat).multiply(pitchQuat).multiply(rollQuat);

      // Front-wheel angle from the turn actually being made: the geometric
      // (Ackermann) angle for this yaw rate and speed, atan(wheelbase * r / v),
      // with the extra lock a driver adds to generate tyre slip. Sharp corners
      // get a lot, fast sweepers a little, lane changes a flick either way.
      // Rate-limited like the player's steering so it never snaps.
      // The yaw rate is low-passed first: a one-frame nudge back onto the
      // tarmac is not a steering input and must not flick the wheels.
      car.yawRateSmooth = (car.yawRateSmooth ?? 0) + (yawRate - (car.yawRateSmooth ?? 0)) * Math.min(1, h * 22);
      const maxLock = 0.44 / (1 + car.speed * 0.016);          // the player's own speed-dependent lock limit
      const wanted = clamp(Math.atan(3.54 * car.yawRateSmooth / Math.max(car.speed, 4)) * 2.0, -maxLock, maxLock);
      car.steer = (car.steer ?? 0) + clamp(wanted - (car.steer ?? 0), -9 * h, 9 * h);

      // --- progress, from where the car actually is ---
      const located = circuit.locate(x, z);
      let delta = located.distance - car.lapDistance;
      if (delta < -circuit.lapLength / 2) delta += circuit.lapLength;
      if (delta > circuit.lapLength / 2) delta -= circuit.lapLength;
      if (Math.abs(delta) < 80) car.progress += delta;
      car.lapDistance = located.distance;
      car.centreOffset = located.offset;

      // --- wheels ---
      if (animateWheels) {
        car.spinAngle = (car.spinAngle + (car.speed / 0.375) * h) % (Math.PI * 2);
        for (const wheel of car.wheels) {
          wheel.spin.rotation.x = car.spinAngle;
          // Same convention as the car's yaw: a positive Y rotation turns the
          // wheel the way a positive yaw rate turns the car.
          // Catching a slide means opposite lock, so the front wheels point
          // against the way the car is slewed.
          if (wheel.front) wheel.steer.rotation.y = clamp(car.steer - (car.slew ?? 0) * 0.8, -0.5, 0.5);
        }
      }

      car.state.speedKmh = car.speed * 3.6;
      // Revs climb through each gear and drop on the upshift, like the player's
      // 8-speed box, so the engine note sounds like it is changing gear.
      const kmh = car.speed * 3.6;
      let gear = GEAR_TOPS.findIndex(t => kmh < t);
      if (gear < 0) gear = GEAR_TOPS.length - 1;
      const low = gear === 0 ? 0 : GEAR_TOPS[gear - 1] * 0.62, high = GEAR_TOPS[gear];
      car.state.rpm = 6500 + clamp((kmh - low) / Math.max(1, high - low), 0, 1) * 8200;
      car.state.gear = gear + 1;
      car.state.velocity = { x: car.vx ?? 0, z: car.vz ?? 0 };
      syncBody(car);
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

  /* ---- physics bodies for contact with the player ---- */
  const canCollide = !!(RAPIER && world);
  function addBody(car) {
    if (!canCollide || car.body) return;
    const p = car.root.position, q = car.root.quaternion;
    car.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      // Continuous collision detection: at 300 km/h the player covers 0.75 m
      // per step and would otherwise end up deep inside a rival before the
      // solver ever saw a contact.
      .setCcdEnabled(true));
    // Same footprint the contact solver uses, sitting at wheel/floor height.
    world.createCollider(RAPIER.ColliderDesc.cuboid(HALF_WIDTH, 0.34, HALF_LENGTH)
      .setTranslation(0, -0.12, 0.05).setFriction(0.5).setRestitution(0), car.body);
  }
  function removeBody(car) {
    if (!car.body) return;
    world.removeRigidBody(car.body);
    car.body = null;
  }
  function syncBody(car) {
    if (!car.body) return;
    const p = car.root.position, q = car.root.quaternion;
    const at = car.body.translation();
    const jump = Math.hypot(p.x - at.x, p.z - at.z);
    // A respawn, a lap wrap or a big correction: place the car outright. Asking
    // the engine to sweep it there would have it arrive at an absurd speed and
    // launch whatever it touched.
    if (jump > Math.max(0.5, (car.speed + 5) * lastStep * 2)) {
      car.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      car.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      return;
    }
    car.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    car.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }
  function setCollisions(on) {
    contact = !!on;
    for (const car of cars) {
      if (contact) { addBody(car); if (car.body) { const p = car.root.position; car.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true); } }
      else removeBody(car);
    }
  }

  /** Put every car on its grid slot without moving it (before the start). */
  function place(playerState) {
    trackPlayer(playerState);
    for (const car of cars) placeCar(car, 0);
    if (contact) for (const car of cars) addBody(car);
  }

  /** Lights out: every driver reacts after their own short delay. */
  function go() {
    cars.forEach((car, i) => {
      car.launchDelay = 0.16 + (Math.sin(i * 91.7 + 3.1) * 0.5 + 0.5) * 0.22 + car.rank * 0.25;
    });
  }
  function setWheelAnimation(on) {
    animateWheels = !!on;
    if (!animateWheels) {
      for (const car of cars) for (const wheel of car.wheels) {
        wheel.spin.rotation.x = 0;
        if (wheel.front) wheel.steer.rotation.y = 0;
      }
    }
  }

  function setSkill(value) {
    const skill = clamp(value, 0.3, 1);
    cars.forEach((car, i) => { car.skill = skill; car.commit = paceFor(car.rank, skill, i); });
  }

  function dispose() {
    for (const car of cars) {
      removeBody(car);
      // Cars built from a shared team model own neither geometry nor material.
      if (!car.sharedGeometry) {
        car.root.traverse(object => { if (object.isMesh) object.geometry?.dispose?.(); });
      }
    }
    for (const item of disposables) item?.dispose?.();
    scene.remove(root);
    cars.length = 0;
  }

  return { cars, root, step, place, go, classification, setCount, setSkill, setWheelAnimation, setCollisions, dispose,
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
/**
 * Copy a real team's car for one opponent.
 *
 * Geometry AND materials are shared with the loaded model — a Ferrari already
 * has Ferrari paint baked in, so nothing is cloned or recoloured and ten cars
 * cost one car's worth of GPU memory. Only the node hierarchy is rebuilt, so
 * each car can steer and spin its own wheels.
 */
function cloneCar(template, team) {
  const root = new THREE.Group();
  root.name = `AI ${team.name}`;
  const wheels = [];
  const chassis = new THREE.Group();
  root.add(chassis);

  for (const child of template.chassis.children) {
    if (!child.isMesh) continue;
    const mesh = new THREE.Mesh(child.geometry, child.material);
    mesh.castShadow = mesh.receiveShadow = true;
    chassis.add(mesh);
  }
  for (const wheel of template.wheels) {
    const steer = new THREE.Group();
    const spin = new THREE.Group();
    const fairing = new THREE.Group();
    steer.position.copy(wheel.steer.position);
    steer.add(spin, fairing);
    chassis.add(steer);
    for (const [from, to] of [[wheel.spin, spin], [wheel.fairing, fairing]]) {
      for (const child of from?.children ?? []) {
        if (!child.isMesh) continue;
        const mesh = new THREE.Mesh(child.geometry, child.material);
        mesh.castShadow = true;
        to.add(mesh);
      }
    }
    wheels.push({ steer, spin, fairing, front: wheel.index < 2 });
  }
  // Geometry and materials belong to the shared model, not to this car.
  return { root, wheels, disposable: [], shared: true };
}

function buildCarVisual(template, team, renderer) {
  // A real team car is used as-is; only a stand-in built from the player's
  // Red Bull needs its livery hue-shifted to tell the cars apart.
  if (template?.realLivery) return cloneCar(template, team);
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
