/**
 * vehicle.js — the car.
 *
 * Rapier ships a raycast vehicle controller, and Codex's build uses it. It is
 * rejected here for one reason: it exposes a single isotropic friction-slip
 * scalar per wheel. A real tyre's grip depends on slip angle, slip ratio,
 * vertical load and the direction the force is being asked for, and those
 * interactions are what make a car feel like a car — understeer on entry,
 * power oversteer on exit, a front that washes out as load transfers off it.
 * One number cannot express any of that.
 *
 * So: a plain dynamic rigid body, four raycasts for suspension, and a
 * simplified Pacejka magic formula per tyre with a friction ellipse for
 * combined slip.
 *
 * Coordinate convention matches the model: +Z is forward, +X is right, +Y up.
 */

import * as THREE from 'three';

/* ───────────────────────────── constants ───────────────────────────── */

const MASS = 798;                       // kg, F1 minimum with driver
const WHEELBASE = 3.54;
const TRACK_WIDTH = 1.60;
const CG_HEIGHT = 0.28;
const TYRE_RADIUS = 0.375;

export const WHEEL_POSITIONS = [
  { x:  0.80, y: -0.22, z:  1.77, front: true },
  { x: -0.80, y: -0.22, z:  1.77, front: true },
  { x:  0.80, y: -0.22, z: -1.77, front: false },
  { x: -0.80, y: -0.22, z: -1.77, front: false },
];

// Suspension. F1 springs are extremely stiff; these are softened enough that
// the car does not skitter on a 669-triangle road that has no real surface
// detail, while still giving visible load transfer.
const SPRING_RATE = 135000;             // N/m
const DAMP_BUMP = 7800;                 // Ns/m
const DAMP_REBOUND = 11500;
const REST_LENGTH = 0.32;
const MAX_TRAVEL = 0.16;
const ANTIROLL_FRONT = 42000;
const ANTIROLL_REAR = 31000;

// Tyre. Pacejka-style coefficients for a slick.
const TYRE = {
  lateral:      { B: 11.5, C: 1.55, D: 2.65, E: 0.96 },
  longitudinal: { B: 13.0, C: 1.65, D: 2.70, E: 0.94 },
  // Grip falls off as vertical load rises — the reason a heavily loaded outside
  // tyre cannot simply carry twice the force of the unloaded inside one.
  loadSensitivity: 0.00006,
  referenceLoad: 3400,                  // N, roughly a quarter of static weight + downforce
  relaxationLength: 0.30,               // m, how quickly slip angle builds
};

// Aerodynamics. Tuned so the car pulls roughly 4 g at 250 km/h and reaches
// ~330 km/h on the long straight with DRS.
const AERO = {
  downforceCoefficient: 5.20,           // total, N per (m/s)^2
  dragCoefficient: 0.92,
  balance: 0.46,                        // fraction of downforce on the front axle
  drsDragReduction: 0.24,
  drsDownforceLoss: 0.30,
  frontalArea: 1.0,
  airDensity: 1.225,
};

// Powertrain: 1.6 L V6 turbo hybrid, ~750 kW combined.
const ENGINE = {
  idleRpm: 4000,
  peakTorqueRpm: 10500,
  limiterRpm: 15000,
  peakTorque: 590,                      // Nm at the crank
  brakingTorque: 130,
  inertia: 0.22,
};
const GEAR_RATIOS = [0, 2.95, 2.20, 1.76, 1.48, 1.28, 1.12, 1.00, 0.90];
const REVERSE_RATIO = -2.60;
const FINAL_DRIVE = 6.50;
const DRIVETRAIN_EFFICIENCY = 0.94;

const BRAKE_TORQUE = 9200;              // Nm total, biased front/rear
const ERS_DEPLOY_POWER = 120000;        // W
const ERS_CAPACITY = 4.0e6;             // J

// How much grip each surface offers relative to dry asphalt.
const SURFACE_GRIP = { asphalt: 1.0, kerb: 0.86, runoff: 0.72, grass: 0.42 };
const SURFACE_ROLL = { asphalt: 1.0, kerb: 2.4, runoff: 3.0, grass: 5.5 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Pacejka magic formula: slip -> normalised force. */
function magicFormula(slip, { B, C, D, E }) {
  const Bs = B * slip;
  return D * Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}

/* ───────────────────────────── the vehicle ───────────────────────────── */

export function createVehicle(world, RAPIER, circuit, options = {}) {
  const setup = {
    frontWing: 6, rearWing: 6, brakeBias: 58,
    ...options.setup,
  };

  /* ---- rigid body ---- */
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 2, 0)
      .setCcdEnabled(true)
      .setLinearDamping(0.02)
      .setAngularDamping(0.35)
      .setCanSleep(false));
  body.setAdditionalSolverIterations(6);

  // A low, flat chassis collider. The wheels are raycast, so this shape only
  // has to handle contact with walls and other cars.
  const chassis = RAPIER.ColliderDesc.cuboid(0.62, 0.20, 2.35)
    .setTranslation(0, -0.12, 0)
    .setMass(MASS)
    .setFriction(0.22)
    .setRestitution(0.05);
  world.createCollider(chassis, body);
  // Nose and rear-wing bumpers so the car does not bury itself in a barrier.
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.95, 0.06, 0.28)
    .setTranslation(0, -0.34, 2.72).setMass(6).setFriction(0.2), body);
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.72, 0.16, 0.22)
    .setTranslation(0, 0.18, -2.22).setMass(6).setFriction(0.2), body);

  /* ---- live state ---- */
  const wheels = WHEEL_POSITIONS.map((w, index) => ({
    index,
    front: w.front,
    local: new THREE.Vector3(w.x, w.y, w.z),
    contact: false,
    surface: 'asphalt',
    suspensionLength: REST_LENGTH,
    suspensionOffset: 0,
    previousLength: REST_LENGTH,
    load: 0,
    slipRatio: 0,
    slipAngle: 0,
    lateralForce: 0,
    longitudinalForce: 0,
    angularVelocity: 0,
    spinAngle: 0,
    steerAngle: 0,
    skidding: 0,
    temperature: 80,
    contactPoint: new THREE.Vector3(),
    contactNormal: new THREE.Vector3(0, 1, 0),
  }));

  const state = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speed: 0, speedKmh: 0,
    rpm: ENGINE.idleRpm, gear: 1, gearRatio: GEAR_RATIOS[1],
    revLimit: ENGINE.limiterRpm,
    throttle: 0, brake: 0, steerAngle: 0,
    drsOpen: false, drsAvailable: false,
    ersCharge: 0.7, ersDeploying: false,
    wheels,
    gLateral: 0, gLongitudinal: 0,
    understeer: 0, oversteer: 0,
    airborne: false, offTrack: false,
    lapDistance: 0, lateralOffset: 0,
    tractionControlActive: false, absActive: false,
    engineLoad: 0, shiftFlash: 0,
  };

  /* ---- scratch vectors (allocation-free stepping) ---- */
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  const pointVelocity = new THREE.Vector3();
  const rayDirection = new THREE.Vector3();
  const forceVector = new THREE.Vector3();
  const tempA = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  /* ---- input shaping ---- */
  // A keyboard key is a step function; a tyre is not. Ramping the pedals and
  // rate-limiting steering is what makes the same physics feel good on a
  // keyboard and stay transparent on an analogue trigger.
  const shaped = { throttle: 0, brake: 0, steer: 0 };
  let shiftCooldown = 0;
  let gearChangeTimer = 0;
  let engineRpm = ENGINE.idleRpm;
  let invertedTimer = 0;
  let gripLevel = 1;
  let suspensionOn = true;

  function shapeInput(input, dt, settings) {
    const speed = Math.abs(state.speed);

    // Pedals: fast to apply, slower to release, so lifting is not instant.
    const throttleRate = input.throttle > shaped.throttle ? 5.5 : 8.0;
    const brakeRate = input.brake > shaped.brake ? 9.0 : 11.0;
    shaped.throttle += clamp(input.throttle - shaped.throttle, -brakeRate * dt, throttleRate * dt);
    shaped.brake += clamp(input.brake - shaped.brake, -brakeRate * dt, brakeRate * dt);
    shaped.throttle = clamp(shaped.throttle, 0, 1);
    shaped.brake = clamp(shaped.brake, 0, 1);

    // Steering is rate-limited, not target-limited. How far the wheels end up
    // turned depends on how long you hold the key; how FAST they get there is
    // near-constant. Previously the target was scaled by speed as well as the
    // geometric lock limit in the physics below — two limiters compounding,
    // which made the wheels feel dead exactly when you needed them.
    //
    // Only the rate tapers with speed now, and gently: a tap gives a small but
    // immediate movement, a held key keeps winding on lock.
    const sensitivity = settings?.steeringSensitivity ?? 1;
    const speedFactor = 1 / (1 + speed * 0.012);
    const target = clamp(input.steer, -1, 1) * sensitivity;

    // Centring is faster than turning, so releasing snaps the wheels straight
    // rather than letting the car wander on after you let go.
    const turning = Math.abs(target) > 0.01 && Math.sign(target) === Math.sign(shaped.steer || target);
    const rate = (turning ? 9.0 : 14.0) * (0.55 + 0.45 * speedFactor) * sensitivity;

    shaped.steer += clamp(target - shaped.steer, -rate * dt, rate * dt);
    shaped.steer = clamp(shaped.steer, -1, 1);
    return shaped;
  }

  /* ---- powertrain ---- */

  /**
   * Crank torque available to DRIVE the car. Never negative.
   *
   * Engine braking is deliberately not folded in here. Returning a negative
   * torque at closed throttle means the drivetrain actively pushes the car
   * backwards when it is stationary — the car crept away in reverse at idle.
   * Overrun drag is a resistive effect and is applied as brake torque against
   * the wheel's actual direction of rotation instead (see engineBraking).
   */
  function engineTorque(rpm, throttle) {
    if (rpm > ENGINE.limiterRpm) return 0;           // limiter: fuel cut
    const normalised = rpm / ENGINE.peakTorqueRpm;
    const shape = normalised < 1
      ? 0.42 + 0.58 * Math.sin(Math.min(1, normalised) * Math.PI / 2)
      : Math.max(0.35, 1 - (normalised - 1) * 0.72);
    return ENGINE.peakTorque * shape * Math.max(0, throttle);
  }

  /** Overrun drag at the driven wheels, as a positive brake-style magnitude. */
  function engineBraking(rpm, throttle, gearRatio) {
    if (Math.abs(gearRatio) < 1e-3) return 0;
    return ENGINE.brakingTorque * (1 - Math.max(0, throttle))
      * Math.min(1, rpm / 6000) * Math.abs(gearRatio) * FINAL_DRIVE * 0.5;
  }

  function updateGearbox(dt, input, settings) {
    shiftCooldown = Math.max(0, shiftCooldown - dt);
    gearChangeTimer = Math.max(0, gearChangeTimer - dt);
    state.shiftFlash = Math.max(0, state.shiftFlash - dt * 4);

    const auto = settings?.autoGears !== false;
    const canShift = shiftCooldown <= 0 && state.gear > 0;

    if (!auto) {
      if (input.shiftUp && canShift && state.gear < GEAR_RATIOS.length - 1) shift(state.gear + 1);
      if (input.shiftDown && canShift && state.gear > 1) shift(state.gear - 1);
    } else if (canShift) {
      if (engineRpm > ENGINE.limiterRpm * 0.965 && state.gear < GEAR_RATIOS.length - 1) {
        shift(state.gear + 1);
      } else if (state.gear > 1) {
        // Downshift when the lower gear would still sit below the limiter.
        const lowerRatio = GEAR_RATIOS[state.gear - 1];
        const projected = wheelRpm() * lowerRatio * FINAL_DRIVE;
        if (projected < ENGINE.limiterRpm * 0.86 && engineRpm < ENGINE.peakTorqueRpm * 0.66) {
          shift(state.gear - 1);
        }
      }
    }

    // Reverse: only from a near stop, holding brake with no throttle.
    if (state.speed < 0.4 && shaped.brake > 0.5 && shaped.throttle < 0.05 && state.gear === 1) {
      if (shiftCooldown <= 0) { state.gear = -1; shiftCooldown = 0.35; }
    } else if (state.gear === -1 && shaped.throttle > 0.5 && state.speed > -0.4) {
      state.gear = 1; shiftCooldown = 0.35;
    }
  }

  function shift(gear) {
    state.gear = gear;
    shiftCooldown = 0.16;
    gearChangeTimer = 0.055;        // torque is cut briefly, as in a real seamless box
    state.shiftFlash = 1;
  }

  const wheelRpm = () => {
    const driven = (wheels[2].angularVelocity + wheels[3].angularVelocity) / 2;
    return Math.abs(driven) * 60 / (Math.PI * 2);
  };

  /* ---- the step ---- */

  function step(dt, input, settings = {}) {
    const assists = resolveAssists(settings);
    // How hard the tyres bite, as a player-facing dial. 1.0 is the tuned
    // baseline; below that the car slides earlier, above it the car is planted.
    gripLevel = Number.isFinite(settings.gripLevel) ? clamp(settings.gripLevel, 0.5, 1.8) : 1;
    // Suspension off keeps the car flat WITHOUT stiffening the springs.
    //
    // The previous version stiffened springs 2.2x. Tyre grip is proportional
    // to how hard the tyre is pressed into the road, and on this coarse mesh a
    // stiff spring makes that load spike and drop as the car crosses triangle
    // seams at speed: wheels went light or left the road entirely, so there
    // was nothing for the grip setting to multiply and the car slid out on
    // every corner. Now the springs are exactly the suspension-on springs, and
    // flatness comes from a separate stabiliser torque (see levelBody below).
    suspensionOn = settings.suspension !== false;
    shapeInput(input, dt, settings);
    readBody();

    // Recover from a flip rather than leaving the player stuck upside down.
    invertedTimer = up.y < 0.2 ? invertedTimer + dt : 0;
    if (invertedTimer > 2.5) { recover(); return; }

    const speed = state.speed;
    const absSpeed = Math.abs(speed);

    /* --- aerodynamics --- */
    const wingScale = (setup.frontWing + setup.rearWing) / 12;
    const drsOpen = state.drsAvailable && input.drs && absSpeed > 30;
    state.drsOpen = drsOpen;
    const downforce = AERO.downforceCoefficient * wingScale * absSpeed * absSpeed
      * (drsOpen ? 1 - AERO.drsDownforceLoss : 1);
    const drag = AERO.dragCoefficient * wingScale * absSpeed * absSpeed
      * (drsOpen ? 1 - AERO.drsDragReduction : 1);

    body.resetForces(true);
    body.resetTorques(true);
    // Downforce acts down the car's own up-axis, so it keeps pressing the tyres
    // into the road through a corner rather than only when level.
    forceVector.copy(up).multiplyScalar(-downforce);
    forceVector.addScaledVector(state.velocity, -drag / Math.max(absSpeed, 0.001));
    body.addForce(forceVector, true);

    const frontDownforce = downforce * AERO.balance;
    const rearDownforce = downforce * (1 - AERO.balance);

    /* --- suspension and tyres --- */
    let contacts = 0;
    let totalLateral = 0, totalLongitudinal = 0;
    const suspensionForces = [0, 0, 0, 0];

    for (const wheel of wheels) {
      // Ray from the suspension's fixed attachment point, which sits one rest
      // length above the hub. The hub itself travels, so it cannot be the origin.
      tempA.set(wheel.local.x, wheel.local.y + REST_LENGTH, wheel.local.z);
      worldPoint.copy(tempA).applyQuaternion(state.quaternion).add(state.position);
      rayDirection.copy(up).multiplyScalar(-1);

      const ray = new RAPIER.Ray(worldPoint, rayDirection);
      const maxDistance = REST_LENGTH + MAX_TRAVEL + TYRE_RADIUS;
      const hit = world.castRayAndGetNormal(
        ray, maxDistance, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);

      if (!hit) {
        wheel.contact = false;
        wheel.load = 0;
        wheel.suspensionLength = REST_LENGTH + MAX_TRAVEL;
        wheel.suspensionOffset = suspensionOn ? -MAX_TRAVEL : 0;  // droop: wheel hangs below its base
        wheel.slipRatio = 0;
        wheel.slipAngle = 0;
        wheel.skidding *= 0.9;
        // Free-spinning wheel decays toward road speed so it does not look odd.
        wheel.angularVelocity *= 1 - Math.min(1, dt * 1.2);
        wheel.spinAngle += wheel.angularVelocity * dt;
        continue;
      }

      contacts++;
      wheel.contact = true;
      const distance = hit.timeOfImpact;
      wheel.contactPoint.copy(worldPoint).addScaledVector(rayDirection, distance);
      wheel.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);

      const compressedLength = clamp(distance - TYRE_RADIUS, REST_LENGTH - MAX_TRAVEL, REST_LENGTH + MAX_TRAVEL);
      const compression = REST_LENGTH - compressedLength;
      const velocityOfChange = (wheel.previousLength - compressedLength) / dt;
      wheel.previousLength = compressedLength;
      wheel.suspensionLength = compressedLength;
      wheel.suspensionOffset = suspensionOn ? compression : 0;

      const damping = (velocityOfChange > 0 ? DAMP_BUMP : DAMP_REBOUND);
      const aeroLoad = wheel.front ? frontDownforce / 2 : rearDownforce / 2;
      let springForce = SPRING_RATE * compression + damping * velocityOfChange + aeroLoad;
      springForce = Math.max(0, springForce);
      suspensionForces[wheel.index] = springForce;
    }

    // Anti-roll bars couple the two wheels on each axle: the more the car
    // rolls, the more load is pushed back onto the inside wheel.
    const rollScale = 1;
    applyAntiRoll(suspensionForces, 0, 1, ANTIROLL_FRONT * rollScale);
    applyAntiRoll(suspensionForces, 2, 3, ANTIROLL_REAR * rollScale);

    const engineTorqueNow = gearChangeTimer > 0 ? 0 : engineTorque(engineRpm, shaped.throttle);
    const gearRatio = state.gear === -1 ? REVERSE_RATIO : GEAR_RATIOS[state.gear] ?? 0;
    state.gearRatio = gearRatio;
    const driveTorque = engineTorqueNow * gearRatio * FINAL_DRIVE * DRIVETRAIN_EFFICIENCY;

    let ersBoost = 0;
    if (shaped.throttle > 0.8 && state.ersCharge > 0.02 && absSpeed > 20) {
      ersBoost = ERS_DEPLOY_POWER / Math.max(absSpeed, 10);
      state.ersCharge = Math.max(0, state.ersCharge - (ERS_DEPLOY_POWER * dt) / ERS_CAPACITY);
      state.ersDeploying = true;
    } else {
      state.ersDeploying = false;
      if (shaped.brake > 0.2) {
        state.ersCharge = Math.min(1, state.ersCharge + (absSpeed * 900 * dt) / ERS_CAPACITY);
      }
    }

    state.tractionControlActive = false;
    state.absActive = false;

    for (const wheel of wheels) {
      if (!wheel.contact) continue;

      const load = suspensionForces[wheel.index];
      wheel.load = load;
      const driven = !wheel.front;

      // Surface under this specific wheel.
      const surface = circuit.surfaceAt(wheel.contactPoint.x, wheel.contactPoint.z, wheel.contactPoint.y);
      wheel.surface = surface.type;
      const gripScale = SURFACE_GRIP[surface.type] ?? 1;

      // Axes in the contact plane.
      quaternion.copy(state.quaternion);
      forward.set(0, 0, 1).applyQuaternion(quaternion);
      // Right = forward x up = (0,0,1) x (0,1,0) = (-1,0,0) in car space.
      right.set(-1, 0, 0).applyQuaternion(quaternion);
      if (wheel.front) {
        const steer = wheel.steerAngle;
        tempA.copy(forward).multiplyScalar(Math.cos(steer)).addScaledVector(right, Math.sin(steer));
        forward.copy(tempA);
        right.set(-1, 0, 0).applyQuaternion(quaternion)
          .multiplyScalar(Math.cos(steer))
          .addScaledVector(tempA.set(0, 0, -1).applyQuaternion(quaternion), Math.sin(steer));
      }
      // Project onto the contact plane so a banked or bumpy surface behaves.
      forward.addScaledVector(wheel.contactNormal, -forward.dot(wheel.contactNormal)).normalize();
      right.addScaledVector(wheel.contactNormal, -right.dot(wheel.contactNormal)).normalize();

      velocityAt(wheel.contactPoint, pointVelocity);
      const vForward = pointVelocity.dot(forward);
      const vLateral = pointVelocity.dot(right);

      /* --- longitudinal: wheel spin vs road speed --- */
      let wheelTorque = driven ? (driveTorque + ersBoost * TYRE_RADIUS) / 2 : 0;

      const biasFront = setup.brakeBias / 100;
      const brakeShare = wheel.front ? biasFront : 1 - biasFront;
      let brakeTorque = shaped.brake * BRAKE_TORQUE * brakeShare / 2;
      // Overrun drag acts only through the driven axle, and only against motion.
      if (driven) brakeTorque += engineBraking(engineRpm, shaped.throttle, gearRatio) / 2;

      // ABS: release the brake on a wheel that is locking.
      const rollingSpeed = wheel.angularVelocity * TYRE_RADIUS;
      if (assists.abs && brakeTorque > 0 && absSpeed > 3) {
        const lock = 1 - clamp(Math.abs(rollingSpeed) / Math.max(Math.abs(vForward), 0.1), 0, 1);
        if (lock > 0.16) { brakeTorque *= Math.max(0.1, 1 - lock * 2.6); state.absActive = true; }
      }

      const slipReference = Math.max(Math.abs(vForward), 2.2);
      wheel.slipRatio = clamp((rollingSpeed - vForward) / slipReference, -1.6, 1.6);

      // Traction control: cut drive torque when the rear steps into wheelspin.
      if (assists.tractionControl > 0 && driven && wheel.slipRatio > 0) {
        const allowed = assists.tractionControl === 2 ? 0.10 : 0.18;
        if (wheel.slipRatio > allowed) {
          wheelTorque *= Math.max(0, 1 - (wheel.slipRatio - allowed) * 5);
          state.tractionControlActive = true;
        }
      }

      /* --- lateral: slip angle --- */
      // Relaxation length: slip angle cannot appear instantly, which is what
      // stops the car snapping between grip states at high frame rates.
      const targetSlipAngle = Math.atan2(-vLateral, Math.max(Math.abs(vForward), 1.2));
      const relaxation = clamp(Math.abs(vForward) * dt / TYRE.relaxationLength, 0, 1);
      wheel.slipAngle += (targetSlipAngle - wheel.slipAngle) * Math.max(relaxation, 0.12);

      /* --- forces --- */
      const loadFactor = 1 - TYRE.loadSensitivity * Math.max(0, load - TYRE.referenceLoad);
      const gripLimit = load * gripScale * Math.max(0.62, loadFactor) * gripLevel;

      let longitudinal = magicFormula(wheel.slipRatio, TYRE.longitudinal) * gripLimit;
      let lateral = magicFormula(wheel.slipAngle, TYRE.lateral) * gripLimit;

      // Friction ellipse: a tyre has one budget and both axes spend from it.
      const demand = Math.hypot(longitudinal / Math.max(gripLimit, 1), lateral / Math.max(gripLimit, 1));
      if (demand > 1) {
        longitudinal /= demand;
        lateral /= demand;
      }
      wheel.skidding = clamp(demand - 0.92, 0, 1);

      // Wheel rotational dynamics.
      const wheelInertia = 1.35;
      const reaction = -longitudinal * TYRE_RADIUS;
      const brakeApplied = Math.sign(wheel.angularVelocity || vForward) * brakeTorque;
      const angularAcceleration = (wheelTorque + reaction - brakeApplied) / wheelInertia;
      wheel.angularVelocity += angularAcceleration * dt;
      if (brakeTorque > 0 && Math.abs(wheel.angularVelocity) < 0.6 && absSpeed < 1.2) {
        wheel.angularVelocity = 0;
      }
      wheel.spinAngle = (wheel.spinAngle + wheel.angularVelocity * dt) % (Math.PI * 2);

      wheel.longitudinalForce = longitudinal;
      wheel.lateralForce = lateral;
      totalLongitudinal += longitudinal;
      totalLateral += lateral;

      // Rolling resistance, much higher off the racing surface.
      const roll = (SURFACE_ROLL[surface.type] ?? 1) * 24 * Math.sign(vForward);

      forceVector.copy(forward).multiplyScalar(longitudinal - roll)
        .addScaledVector(right, lateral)
        .addScaledVector(wheel.contactNormal, load);
      body.addForceAtPoint(forceVector, wheel.contactPoint, true);

      wheel.temperature += (Math.abs(wheel.skidding) * 140 - (wheel.temperature - 85) * 0.5) * dt;
    }

    /* --- stability control --- */
    if (assists.stability && contacts >= 3 && absSpeed > 8) {
      const angularVelocity = body.angvel();
      const desiredYawRate = -(state.steerAngle * speed) / WHEELBASE;
      const yawError = desiredYawRate - angularVelocity.y;
      const correction = clamp(yawError * 0.35, -0.9, 0.9) * MASS * 2.2;
      body.addTorque({ x: 0, y: correction, z: 0 }, true);
    }

    if (!suspensionOn && contacts >= 2) levelBody(dt);

    state.airborne = contacts === 0;

    // Parking brake: with no pedal input and the car essentially stopped, damp
    // the residual creep the solver leaves behind rather than letting it drift.
    if (contacts >= 3 && shaped.throttle < 0.02 && shaped.brake < 0.02 && absSpeed < 1.2) {
      const linear = body.linvel();
      body.setLinvel({ x: linear.x * 0.75, y: linear.y, z: linear.z * 0.75 }, true);
      for (const wheel of wheels) wheel.angularVelocity *= 0.75;
    }

    /* --- steering --- */
    // Maximum lock falls with speed; this is the geometric limit, on top of the
    // rate limit applied in shapeInput.
    const maxLock = 0.44 / (1 + absSpeed * 0.016);
    state.steerAngle = shaped.steer * maxLock;
    for (const wheel of wheels) {
      if (!wheel.front) continue;
      // Ackermann: the inside wheel turns more than the outside one.
      const inner = Math.sign(state.steerAngle) === -Math.sign(wheel.local.x);
      wheel.steerAngle = state.steerAngle * (inner ? 1.12 : 0.9);
    }

    world.step();
    readBody();

    /* --- engine speed from the driven wheels --- */
    if (state.gear !== 0 && contacts > 0) {
      const drivenSpeed = (wheels[2].angularVelocity + wheels[3].angularVelocity) / 2;
      const target = Math.abs(drivenSpeed) * Math.abs(gearRatio) * FINAL_DRIVE * 60 / (Math.PI * 2);
      engineRpm += (target - engineRpm) * Math.min(1, dt * 12);
    } else {
      const target = ENGINE.idleRpm + shaped.throttle * (ENGINE.limiterRpm - ENGINE.idleRpm) * 0.85;
      engineRpm += (target - engineRpm) * Math.min(1, dt * 3.5);
    }
    engineRpm = clamp(engineRpm, ENGINE.idleRpm, ENGINE.limiterRpm * 1.005);

    updateGearbox(dt, input, settings);

    /* --- expose state --- */
    state.rpm = engineRpm;
    state.throttle = shaped.throttle;
    state.brake = shaped.brake;
    state.gLateral = totalLateral / (MASS * 9.81);
    state.gLongitudinal = totalLongitudinal / (MASS * 9.81);
    state.engineLoad = shaped.throttle;

    const located = circuit.locate(state.position.x, state.position.z);
    state.lapDistance = located.distance;
    state.lateralOffset = located.offset;
    state.offTrack = !located.onTrack;
    // DRS is allowed anywhere the road is straight enough to need it.
    state.drsAvailable = Math.abs(located.curvature) < 0.0035;

    // Understeer / oversteer, for the HUD and the audio.
    const frontSlip = (Math.abs(wheels[0].slipAngle) + Math.abs(wheels[1].slipAngle)) / 2;
    const rearSlip = (Math.abs(wheels[2].slipAngle) + Math.abs(wheels[3].slipAngle)) / 2;
    state.understeer = clamp((frontSlip - rearSlip) * 3.4, 0, 1);
    state.oversteer = clamp((rearSlip - frontSlip) * 3.4, 0, 1);

    // Safety net: if the solver ever produces a non-finite pose, recover rather
    // than propagating NaN into the renderer.
    if (!Number.isFinite(state.position.x + state.position.y + state.position.z)) recover();
    if (state.position.y < -60) recover();
  }


  /**
   * Suspension-off stabiliser: hold the body parallel to the road.
   *
   * A torque pulls the car's up-vector toward the average road normal under
   * the wheels, with damping on the roll and pitch rates. It is measured
   * against the road, not the world, so it follows the circuit's slopes
   * instead of fighting them. Yaw is left completely free — steering is
   * untouched.
   *
   * Because the body no longer leans, cornering load stays more evenly spread
   * across the tyres, so if anything the car grips a little more than with
   * suspension on. The spring model itself is identical in both modes.
   */
  const levelNormal = new THREE.Vector3();
  const bodyForward = new THREE.Vector3();
  const bodyRight = new THREE.Vector3();
  const bodyUp = new THREE.Vector3();
  const tilt = new THREE.Vector3();
  const LEVEL_ROLL = { stiffness: 45000, damping: 4500 };     // ~3.6 Hz, critically damped
  const LEVEL_PITCH = { stiffness: 150000, damping: 15000 };  // pitch inertia is ~13x roll
  function levelBody() {
    levelNormal.set(0, 0, 0);
    for (const wheel of wheels) if (wheel.contact) levelNormal.add(wheel.contactNormal);
    if (levelNormal.lengthSq() < 1e-6) return;
    levelNormal.normalize();
    bodyForward.set(0, 0, 1).applyQuaternion(state.quaternion);
    bodyRight.set(-1, 0, 0).applyQuaternion(state.quaternion);
    bodyUp.set(0, 1, 0).applyQuaternion(state.quaternion);
    tilt.crossVectors(bodyUp, levelNormal);                   // axis * sin(angle) toward level
    const w = body.angvel();
    const rollRate = w.x * bodyForward.x + w.y * bodyForward.y + w.z * bodyForward.z;
    const pitchRate = w.x * bodyRight.x + w.y * bodyRight.y + w.z * bodyRight.z;
    const rollTorque = LEVEL_ROLL.stiffness * tilt.dot(bodyForward) - LEVEL_ROLL.damping * rollRate;
    const pitchTorque = LEVEL_PITCH.stiffness * tilt.dot(bodyRight) - LEVEL_PITCH.damping * pitchRate;
    body.addTorque({
      x: bodyForward.x * rollTorque + bodyRight.x * pitchTorque,
      y: bodyForward.y * rollTorque + bodyRight.y * pitchTorque,
      z: bodyForward.z * rollTorque + bodyRight.z * pitchTorque,
    }, true);
  }

  function applyAntiRoll(forces, leftIndex, rightIndex, rate) {
    const travelLeft = REST_LENGTH - wheels[leftIndex].suspensionLength;
    const travelRight = REST_LENGTH - wheels[rightIndex].suspensionLength;
    // An anti-roll bar pushes UP on the more compressed wheel and eases off the
    // other, resisting the lean. This was inverted: it took force away from the
    // compressed side, so any roll fed on itself. Soft enough to hide under the
    // springs with suspension on; tripled for "suspension off" it rolled the
    // car onto its side.
    const transfer = (travelLeft - travelRight) * rate;
    forces[leftIndex] = Math.max(0, forces[leftIndex] + transfer);
    forces[rightIndex] = Math.max(0, forces[rightIndex] - transfer);
  }

  function readBody() {
    const t = body.translation();
    const r = body.rotation();
    const v = body.linvel();
    state.position.set(t.x, t.y, t.z);
    state.quaternion.set(r.x, r.y, r.z, r.w);
    state.velocity.set(v.x, v.y, v.z);
    forward.set(0, 0, 1).applyQuaternion(state.quaternion);
    up.set(0, 1, 0).applyQuaternion(state.quaternion);
    state.speed = state.velocity.dot(forward);
    state.speedKmh = state.speed * 3.6;
  }

  const angularVelocity = new THREE.Vector3();
  const lever = new THREE.Vector3();
  function velocityAt(point, out) {
    const linear = body.linvel();
    const angular = body.angvel();
    angularVelocity.set(angular.x, angular.y, angular.z);
    lever.copy(point).sub(state.position);
    out.copy(angularVelocity).cross(lever);
    out.x += linear.x; out.y += linear.y; out.z += linear.z;
    return out;
  }

  function resolveAssists(settings) {
    const preset = settings.assistPreset ?? 'SPORT';
    const base = preset === 'ARCADE' ? { tractionControl: 2, abs: true, stability: true }
      : preset === 'PRO' ? { tractionControl: 0, abs: false, stability: false }
      : { tractionControl: 1, abs: true, stability: false };
    return {
      tractionControl: settings.tractionControl ?? base.tractionControl,
      abs: settings.abs ?? base.abs,
      stability: settings.stability ?? base.stability,
    };
  }

  function reset(pose) {
    const position = pose?.position ?? new THREE.Vector3(0, 2, 0);
    const rotation = pose?.quaternion ?? new THREE.Quaternion();
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);
    engineRpm = ENGINE.idleRpm;
    state.gear = 1;
    state.ersCharge = 0.7;
    shaped.throttle = shaped.brake = shaped.steer = 0;
    invertedTimer = 0;
    for (const wheel of wheels) {
      wheel.angularVelocity = 0;
      wheel.slipAngle = 0;
      wheel.slipRatio = 0;
      wheel.skidding = 0;
      wheel.suspensionLength = REST_LENGTH;
      wheel.previousLength = REST_LENGTH;
      wheel.suspensionOffset = 0;
      wheel.temperature = 85;
    }
    readBody();
  }

  /** Put the car back on the racing line after a flip or a fall. */
  function recover() {
    const located = circuit.locate(state.position.x, state.position.z);
    const point = circuit.lineAt(located.distance);
    reset({
      position: new THREE.Vector3(point.x, point.y + 0.62, point.z),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.atan2(point.tx, point.tz)),
    });
  }

  reset(options.pose);

  return {
    body,
    state,
    step,
    reset,
    recover,
    setup(partial) { Object.assign(setup, partial); },
    get setupValues() { return { ...setup }; },
    dispose() { world.removeRigidBody(body); },
  };
}
