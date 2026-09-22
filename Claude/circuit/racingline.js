import { recomputeFrames } from './roadmesh.js';

/**
 * racingline.js — corridor queries and a minimum-curvature racing line.
 *
 * Everything here works in "corridor space": a point is described by how far it
 * is around the lap (`distance`) and how far it sits left of the centreline
 * (`offset`). That turns a 3.8 km closed 3D loop into a 1D problem, which is
 * what makes lap timing, AI pursuit, track-limit checks and the racing line all
 * cheap enough to run per wheel at 120 Hz.
 */

/* ------------------------------------------------------- spatial index */

/**
 * Uniform grid over the centreline so a world position can be mapped back to
 * corridor space without scanning all 643 samples. Cells are sized to the
 * widest corridor so a query only ever inspects a 3x3 neighbourhood.
 */
class CentrelineIndex {
  constructor(samples, cellSize = 40) {
    this.samples = samples;
    this.cell = cellSize;
    this.grid = new Map();
    // Register each sample in every cell its corridor could reach, so a car
    // near the outside edge still finds its centreline sample.
    samples.forEach((s, i) => {
      const reach = Math.ceil((s.width / 2 + 6) / cellSize);
      const gx = Math.floor(s.x / cellSize), gz = Math.floor(s.z / cellSize);
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        const k = `${gx + dx},${gz + dz}`;
        let bucket = this.grid.get(k);
        if (!bucket) this.grid.set(k, bucket = []);
        bucket.push(i);
      }
    });
  }

  /** Index of the centreline sample nearest to (x, z), or -1. */
  nearest(x, z) {
    const gx = Math.floor(x / this.cell), gz = Math.floor(z / this.cell);
    let best = -1, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of this.grid.get(`${gx + dx},${gz + dz}`) ?? []) {
        const s = this.samples[i];
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best >= 0) return best;
    // Off the registered corridor entirely (deep in the infield or run-off).
    this.samples.forEach((s, i) => {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
}

/* ------------------------------------------------------ triangle lookup */

/**
 * Uniform grid over the road triangles for exact height and on-track tests.
 * The surface is only 973 triangles, so a coarse grid makes each query a
 * handful of point-in-triangle tests.
 */
class SurfaceIndex {
  constructor(positions, indices, cellSize = 20) {
    this.positions = positions;
    this.indices = indices;
    this.cell = cellSize;
    this.grid = new Map();
    const triangleCount = indices.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const minX = Math.min(positions[a], positions[b], positions[c]);
      const maxX = Math.max(positions[a], positions[b], positions[c]);
      const minZ = Math.min(positions[a + 2], positions[b + 2], positions[c + 2]);
      const maxZ = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]);
      for (let gx = Math.floor(minX / cellSize); gx <= Math.floor(maxX / cellSize); gx++) {
        for (let gz = Math.floor(minZ / cellSize); gz <= Math.floor(maxZ / cellSize); gz++) {
          const k = `${gx},${gz}`;
          let bucket = this.grid.get(k);
          if (!bucket) this.grid.set(k, bucket = []);
          bucket.push(t);
        }
      }
    }
  }

  /**
   * Height of the road at (x, z), or null when off the surface.
   * `nearY` disambiguates overlapping geometry by preferring the closest
   * surface vertically — the circuit has no real overpass, but the junction
   * areas do overlap in plan view.
   */
  heightAt(x, z, nearY = null) {
    const bucket = this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!bucket) return null;
    const p = this.positions, idx = this.indices;
    let best = null, bestDelta = Infinity;
    for (const t of bucket) {
      const ia = idx[t * 3] * 3, ib = idx[t * 3 + 1] * 3, ic = idx[t * 3 + 2] * 3;
      const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
      const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
      const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
      if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
      const y = u * ay + v * by + (1 - u - v) * cy;
      const delta = nearY === null ? -y : Math.abs(y - nearY);
      if (delta < bestDelta) { bestDelta = delta; best = y; }
    }
    return best;
  }
}

/* --------------------------------------------------- corridor refinement */

/**
 * Re-measure the corridor against the actual road surface.
 *
 * Pairing the outer rim with the nearest inner rim gives a good centreline
 * wherever the two carriageways run together, but the circuit has junction
 * areas where they splay apart (measured up to 74 m). There the midpoint
 * between the rims lands on grass, not road — which put ~19% of the seeded
 * racing line off the surface.
 *
 * The fix is to stop inferring the corridor and simply measure it: probe the
 * real triangle mesh along the centreline's own perpendicular and take the
 * run of consecutive on-road samples that spans the current centre. Where the
 * carriageways have split, that run is one carriageway (~5 m) rather than a
 * bogus 18 m spanning the gap, so the racing line stays on tarmac.
 *
 * The probe axis is the sample's left normal, NOT the outer-rim-to-inner-rim
 * chord. The chord is only perpendicular to the road where the two rims run
 * parallel; through the junctions it goes oblique and under-measures the road
 * (it reported a 2.7 m corridor across a 457 m stretch that is really 10 m).
 * The normal is perpendicular to the direction of travel by construction.
 *
 * Runs once per pass; two passes let the frames re-derive from the corrected
 * centres so the normals themselves improve.
 */
function refineCentreline(samples, surfaceIndex, { probeStep = 0.25, probeReach = 14 } = {}) {
  let moved = 0;
  // Walk the loop in order and carry the previous sample's corrected height
  // forward as the seed. Samples are ~6 m apart, so the road can only rise or
  // fall a little between them — whereas the rim-paired seed height can be
  // several metres out through the elevated interchange section (the mesh
  // spans -2.5 m to +5.0 m there), which made the height filter below reject
  // the real road surface and stranded 240 m of centreline in mid-air.
  let carriedY = null;
  for (const s of samples) {
    const seedY = carriedY ?? s.y;
    const steps = Math.ceil((probeReach * 2) / probeStep);
    const onRoad = new Array(steps + 1);
    const heights = new Array(steps + 1);
    for (let k = 0; k <= steps; k++) {
      const t = -probeReach + k * probeStep;
      const h = surfaceIndex.heightAt(s.x + s.nx * t, s.z + s.nz * t, seedY);
      onRoad[k] = h !== null && Math.abs(h - seedY) < 3.5;
      heights[k] = h;
    }
    // Take the run straddling t = 0 (index `centre`) — that is the road the
    // car is actually on. Falling back to the widest run would let the corridor
    // jump across a median gap onto the opposite carriageway.
    let centre = Math.round(probeReach / probeStep);
    if (!onRoad[centre]) {
      // The seed sits just off the tarmac. Re-centre the search on the nearest
      // on-road probe — marking the seed as on-road instead would fold an
      // off-road cell into the run and leave the final centre off the surface.
      let nearest = -1;
      for (let d = 1; d <= steps; d++) {
        if (centre - d >= 0 && onRoad[centre - d]) { nearest = centre - d; break; }
        if (centre + d <= steps && onRoad[centre + d]) { nearest = centre + d; break; }
      }
      if (nearest < 0) continue;                    // no road anywhere on this section
      centre = nearest;
    }
    let lo = centre, hi = centre;
    while (lo > 0 && onRoad[lo - 1]) lo--;
    while (hi < steps && onRoad[hi + 1]) hi++;

    const width = (hi - lo) * probeStep;
    if (width < 2) continue;                        // implausible; keep the seed
    const centreT = -probeReach + ((lo + hi) / 2) * probeStep;
    let ySum = 0, yCount = 0;
    for (let k = lo; k <= hi; k++) if (heights[k] !== null) { ySum += heights[k]; yCount++; }

    const nx = s.x + s.nx * centreT, nz = s.z + s.nz * centreT;
    if (Math.abs(centreT) > 0.5) moved++;
    s.x = nx;
    s.z = nz;
    if (yCount) s.y = ySum / yCount;
    s.width = width;
    carriedY = s.y;
  }
  // The walk starts with no carried height, so the first samples were seeded
  // from the rim pairing. Re-run just those now that a height is known.
  for (const s of samples.slice(0, 12)) {
    const h = surfaceIndex.heightAt(s.x, s.z, carriedY);
    if (h !== null) s.y = h;
  }
  return moved;
}

/**
 * Last-resort repair: pull any sample that is still off the tarmac onto the
 * nearest road surface.
 *
 * The perpendicular probe assumes the seed is on, or very near, the road it
 * belongs to. That holds everywhere except the two-level interchange around
 * (83..282, 374..508), where one carriageway drops to Y = -2.5 and its
 * opposite rim belongs to a different boundary loop entirely — so the rim
 * pairing has no same-level partner to work with and the seed ends up between
 * the two decks. Rather than special-case that geometry, any sample that is
 * still in mid-air simply searches outward for real road and moves there.
 *
 * @returns number of samples repaired
 */
function snapToSurface(samples, surfaceIndex, { maxRadius = 16, rings = 32, spokes = 24 } = {}) {
  let repaired = 0;
  for (const s of samples) {
    if (surfaceIndex.heightAt(s.x, s.z, s.y) !== null) continue;
    let best = null, bestD = Infinity;
    for (let r = 1; r <= rings; r++) {
      const radius = (r / rings) * maxRadius;
      for (let a = 0; a < spokes; a++) {
        const theta = (a / spokes) * Math.PI * 2;
        const px = s.x + Math.cos(theta) * radius;
        const pz = s.z + Math.sin(theta) * radius;
        const h = surfaceIndex.heightAt(px, pz, s.y);
        if (h === null) continue;
        const d = radius + Math.abs(h - s.y) * 2;   // prefer same-level road
        if (d < bestD) { bestD = d; best = { x: px, z: pz, y: h }; }
      }
      if (best) break;                              // nearest ring wins
    }
    if (!best) continue;
    s.x = best.x; s.z = best.z; s.y = best.y;
    repaired++;
  }
  return repaired;
}

/**
 * Corridor width is a measurement, so it is noisy where the probe clips a
 * triangle edge. A short closed box filter keeps the racing line's lateral
 * limits from snapping in and out between adjacent samples.
 */
function smoothWidths(samples, passes = 1) {
  const n = samples.length;
  for (let pass = 0; pass < passes; pass++) {
    const copy = samples.map(s => s.width);
    for (let i = 0; i < n; i++) {
      samples[i].width = (copy[(i - 1 + n) % n] + 2 * copy[i] + copy[(i + 1) % n]) / 4;
    }
  }
}

/* -------------------------------------------------------- racing line */

/**
 * Minimum-curvature line through the corridor.
 *
 * Each centreline sample gets a lateral offset. Relaxation repeatedly moves
 * every offset toward the one that would put the point on the straight line
 * between its neighbours — the zero-curvature position — then clamps it back
 * inside the drivable corridor. Corners therefore pull the line outward on
 * entry, to the apex at the middle and outward again on exit, which is exactly
 * the geometric racing line, without needing a full optimiser.
 *
 * @param samples   centreline samples from roadmesh.js
 * @param halfWidth usable half-corridor at each sample (car width + margin already removed)
 * @param passes    relaxation iterations; ~600 converges on a 3.8 km lap
 */
export function solveRacingLine(samples, { carHalfWidth = 1.1, margin = 0.5, passes = 600, rate = 0.35 } = {}) {
  const n = samples.length;
  const limit = samples.map(s => Math.max(0, s.width / 2 - carHalfWidth - margin));
  const offset = new Float64Array(n);

  for (let pass = 0; pass < passes; pass++) {
    const next = Float64Array.from(offset);
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n, following = (i + 1) % n;
      // World positions of the current line at the three samples.
      const a = pointAt(samples[prev], offset[prev]);
      const b = pointAt(samples[i], offset[i]);
      const c = pointAt(samples[following], offset[following]);
      // Where would b have to be for a-b-c to be straight? The midpoint of a,c.
      const midX = (a.x + c.x) / 2, midZ = (a.z + c.z) / 2;
      // Project that correction onto this sample's lateral axis.
      const want = offset[i] + (midX - b.x) * samples[i].nx + (midZ - b.z) * samples[i].nz;
      const clamped = Math.max(-limit[i], Math.min(limit[i], want));
      next[i] = offset[i] + (clamped - offset[i]) * rate;
    }
    offset.set(next);
  }

  // Re-derive geometry along the solved line: curvature drives the AI's speed
  // target and the braking-point search, so it must come from the line itself,
  // not from the centreline it was seeded with.
  const line = [];
  for (let i = 0; i < n; i++) {
    const p = pointAt(samples[i], offset[i]);
    line.push({ x: p.x, y: samples[i].y, z: p.z, offset: offset[i], distance: samples[i].distance });
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    line[i].distance = total;
    total += Math.hypot(line[(i + 1) % n].x - line[i].x, line[(i + 1) % n].z - line[i].z);
  }
  for (let i = 0; i < n; i++) {
    const a = line[(i - 1 + n) % n], b = line[i], c = line[(i + 1) % n];
    const t1x = b.x - a.x, t1z = b.z - a.z;
    const t2x = c.x - b.x, t2z = c.z - b.z;
    const l1 = Math.hypot(t1x, t1z) || 1, l2 = Math.hypot(t2x, t2z) || 1;
    b.tx = (t1x / l1 + t2x / l2) / 2;
    b.tz = (t1z / l1 + t2z / l2) / 2;
    const tl = Math.hypot(b.tx, b.tz) || 1;
    b.tx /= tl; b.tz /= tl;
    const cross = (t1x / l1) * (t2z / l2) - (t1z / l1) * (t2x / l2);
    const ds = (l1 + l2) / 2;
    b.curvature = ds > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, cross))) / ds : 0;
    b.radius = Math.abs(b.curvature) > 1e-6 ? 1 / Math.abs(b.curvature) : Infinity;
  }
  return { line, lineLength: total };
}

const pointAt = (sample, offset) => ({
  x: sample.x + sample.nx * offset,
  z: sample.z + sample.nz * offset,
});

/**
 * Guarantee the solved line sits on tarmac.
 *
 * The relaxation clamps each point to the *measured* corridor half-width, but
 * that width is a sampled quantity and is smoothed across neighbours, so at a
 * boundary between a wide section and a narrow one it can over-report by a
 * metre or two. Rather than make the width estimate more conservative
 * everywhere — which would cost apex on every corner — each solved point is
 * verified against the real surface and walked back toward the centreline only
 * where it actually left the road.
 *
 * @returns number of points pulled back in
 */
function clampLineToSurface(line, samples, surfaceIndex) {
  let clamped = 0;
  for (let i = 0; i < line.length; i++) {
    const p = line[i], s = samples[i];
    if (surfaceIndex.heightAt(p.x, p.z, s.y) !== null) continue;
    // Bisect the offset toward the centreline until the point is back on road.
    let lo = 0, hi = p.offset;
    for (let step = 0; step < 12; step++) {
      const mid = (lo + hi) / 2;
      const x = s.x + s.nx * mid, z = s.z + s.nz * mid;
      if (surfaceIndex.heightAt(x, z, s.y) !== null) lo = mid; else hi = mid;
    }
    p.offset = lo;
    p.x = s.x + s.nx * lo;
    p.z = s.z + s.nz * lo;
    p.y = surfaceIndex.heightAt(p.x, p.z, s.y) ?? s.y;
    clamped++;
  }
  return clamped;
}

/**
 * Forward-backward pass turning the racing line's curvature into a speed
 * profile: cornering limit first, then walk backwards applying the braking
 * limit and forwards applying the traction/power limit. This is the standard
 * quasi-steady-state lap simulation, and it gives the AI its braking points
 * for free.
 */
export function solveSpeedProfile(line, { gripG = 3.4, brakeG = 4.6, powerG = 1.5, vMax = 94, downforceGain = 0.022 } = {}) {
  const n = line.length;
  const g = 9.81;
  const speed = new Float64Array(n);

  // 1. Pure cornering limit. Downforce grows with v^2, so grip grows with
  //    speed; solve v^2 = mu(v) * g * r iteratively rather than in closed form.
  for (let i = 0; i < n; i++) {
    const r = line[i].radius;
    if (!Number.isFinite(r)) { speed[i] = vMax; continue; }
    let v = Math.sqrt(gripG * g * r);
    for (let k = 0; k < 8; k++) v = Math.sqrt((gripG + downforceGain * v) * g * r);
    speed[i] = Math.min(v, vMax);
  }
  // 2. Backward pass — you must already be slow enough to make the next corner.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n; k > 0; k--) {
      const i = k % n, j = (k - 1 + n) % n;
      const ds = segmentLength(line, j, i);
      const limit = Math.sqrt(speed[i] ** 2 + 2 * brakeG * g * ds);
      if (speed[j] > limit) speed[j] = limit;
    }
    // 3. Forward pass — and you cannot accelerate harder than the car can.
    for (let k = 0; k < n * 2; k++) {
      const i = k % n, j = (k + 1) % n;
      const ds = segmentLength(line, i, j);
      const limit = Math.sqrt(speed[i] ** 2 + 2 * powerG * g * ds);
      if (speed[j] > limit) speed[j] = limit;
    }
  }
  for (let i = 0; i < n; i++) line[i].targetSpeed = speed[i];
  return line;
}

const segmentLength = (line, i, j) => Math.hypot(line[j].x - line[i].x, line[j].z - line[i].z);

/* ------------------------------------------------------------- circuit */

/**
 * The queryable circuit: corridor space, surface heights and the racing line.
 */
export class Circuit {
  constructor(surface, options = {}) {
    this.positions = surface.positions;
    this.indices = surface.indices;
    this.centreline = surface.centreline;
    this.lapLength = surface.lapLength;
    this.stats = surface.stats;
    this.outerRim = surface.outerRim;
    this.innerRim = surface.innerRim;

    this.surface = new SurfaceIndex(surface.positions, surface.indices);

    // Measure the real corridor before anything depends on it, rebuilding the
    // arc-length/tangent/curvature frames after each pass because the samples
    // move — the second pass probes along the corrected normals.
    this.rescued = refineCentreline(surface.centreline, this.surface, options);
    this.lapLength = recomputeFrames(surface.centreline);
    this.repaired = snapToSurface(surface.centreline, this.surface, options);
    this.lapLength = recomputeFrames(surface.centreline);
    refineCentreline(surface.centreline, this.surface, options);
    snapToSurface(surface.centreline, this.surface, options);
    smoothWidths(surface.centreline, 2);
    this.lapLength = recomputeFrames(surface.centreline);
    this.index = new CentrelineIndex(surface.centreline);

    const solved = solveRacingLine(surface.centreline, options);
    this.clamped = clampLineToSurface(solved.line, surface.centreline, this.surface);
    this.racingLine = solveSpeedProfile(solved.line, options);
    this.racingLineLength = solved.lineLength;
  }

  /** Height of the road at a world position, or null when off-surface. */
  heightAt(x, z, nearY = null) { return this.surface.heightAt(x, z, nearY); }

  /**
   * Map a world position into corridor space.
   * @returns {{distance:number, offset:number, width:number, onTrack:boolean,
   *            curvature:number, index:number, tx:number, tz:number}}
   */
  locate(x, z) {
    const i = this.index.nearest(x, z);
    const s = this.centreline[i];
    const n = this.centreline.length;
    // Refine against the two adjacent segments so `distance` is continuous
    // rather than quantised to the ~5.9 m sample spacing.
    let best = { index: i, t: 0, distance: s.distance, offset: 0, d2: Infinity };
    for (const j of [(i - 1 + n) % n, i]) {
      const a = this.centreline[j], b = this.centreline[(j + 1) % n];
      const ex = b.x - a.x, ez = b.z - a.z;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / len2));
      const px = a.x + ex * t, pz = a.z + ez * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best.d2) {
        const segment = Math.sqrt(len2);
        best = {
          index: j, t, d2,
          distance: (a.distance + segment * t) % this.lapLength,
          offset: (x - px) * a.nx + (z - pz) * a.nz,
        };
      }
    }
    const sample = this.centreline[best.index];
    const width = sample.width;
    return {
      index: best.index,
      distance: best.distance,
      offset: best.offset,
      width,
      onTrack: Math.abs(best.offset) <= width / 2 + 0.25,
      curvature: sample.curvature,
      tx: sample.tx,
      tz: sample.tz,
    };
  }

  /**
   * Which surface a wheel is standing on. Combines the exact triangle test
   * (authoritative, handles the junction overlaps) with the corridor test
   * (cheap, and tells us *how far* off-track we are for kerb vs grass).
   */
  surfaceAt(x, z, nearY = null) {
    const height = this.heightAt(x, z, nearY);
    const corridor = this.locate(x, z);
    const over = Math.abs(corridor.offset) - corridor.width / 2;
    let type = 'grass';
    if (height !== null) type = over > 0.05 ? 'kerb' : 'asphalt';
    else if (over < 2.5) type = 'kerb';
    else if (over < 9) type = 'runoff';
    return { type, height, ...corridor, overshoot: over };
  }

  /** Racing-line sample at a distance around the lap, interpolated. */
  lineAt(distance) {
    const line = this.racingLine;
    const n = line.length;
    const d = ((distance % this.racingLineLength) + this.racingLineLength) % this.racingLineLength;
    // Samples are near-uniformly spaced, so seed the search by proportion.
    let i = Math.min(n - 1, Math.floor((d / this.racingLineLength) * n));
    while (line[i].distance > d && i > 0) i--;
    while (i + 1 < n && line[i + 1].distance <= d) i++;
    const a = line[i], b = line[(i + 1) % n];
    const span = (b.distance - a.distance + this.racingLineLength) % this.racingLineLength || 1;
    const t = Math.max(0, Math.min(1, (d - a.distance) / span));
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      tx: a.tx, tz: a.tz,
      curvature: a.curvature + (b.curvature - a.curvature) * t,
      targetSpeed: a.targetSpeed + (b.targetSpeed - a.targetSpeed) * t,
      distance: d,
      index: i,
      // The racing line is solved 1:1 against the centreline samples, so the
      // line's lateral offset from the centreline and the corridor width at
      // this point can be read straight off the matching samples. The AI needs
      // both to place a car beside the line without leaving the tarmac.
      offset: (a.offset ?? 0) + ((b.offset ?? 0) - (a.offset ?? 0)) * t,
      halfWidth: (this.centreline[i].width + (this.centreline[(i + 1) % n].width - this.centreline[i].width) * t) / 2,
    };
  }

  /** Signed forward gap from a to b around the lap, in metres (-half..+half). */
  gapAlong(a, b) {
    let d = (b - a) % this.lapLength;
    if (d > this.lapLength / 2) d -= this.lapLength;
    if (d < -this.lapLength / 2) d += this.lapLength;
    return d;
  }
}
