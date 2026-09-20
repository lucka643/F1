/**
 * roadmesh.js — turns the original NFS Undercover DS "Highway Battle" road mesh
 * into a single continuous racing surface, then derives a centreline from it.
 *
 * The source asset (Codex/assets/highway-road.b64) is a gzipped JSON triangle
 * soup: 694 vertices / 669 triangles of DS-era geometry, stored as integers at
 * 64 units per metre. It is NOT a racetrack as shipped. Three things are wrong
 * with it for racing, and this module fixes each one:
 *
 *   1. DUPLICATE VERTICES. Consecutive road segments meet at coincident-but-
 *      distinct vertices 0.02-0.06 m apart, so the ribbon reads as 12 disjoint
 *      components instead of a loop. welding at 0.15 m merges them into two
 *      continuous rings (one per carriageway).
 *
 *   2. A SPLIT CARRIAGEWAY. It is a dual carriageway: two ~5.0 m ribbons with a
 *      ~0.7 m median seam between them. Codex's track.js walls every boundary
 *      edge that has road on one side only, which puts a barrier down that
 *      median and leaves you driving a 5 m lane. Stitching the seam instead
 *      merges the two ribbons into one ~10.7 m surface — real F1 circuit width.
 *
 *   3. NO CENTRELINE. Racing needs lap distance, sectors, a racing line and AI
 *      paths. After stitching, the surface has exactly two long boundary loops
 *      (outer 3857 m, inner 3822 m); pairing them gives a 3.83 km centreline.
 *
 * Every number quoted above was measured from the real asset, and the module
 * re-derives them at load time rather than trusting a baked table.
 */

const WELD_EPS = 0.15;       // m — merges the 0.02-0.06 m duplicate-vertex seams
const MEDIAN_MAX_GAP = 2.2;  // m — real median measures 0.57-0.75 m
const MEDIAN_MAX_RISE = 1.2; // m — reject pairs at different elevations (over/underpass)

/* ------------------------------------------------------------------ decode */

/** Decode the base64 + gzip + JSON road asset into metre-scale triangle soup. */
export async function loadRoadSoup(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Road asset missing (HTTP ${response.status})`);
  const b64 = (await response.text()).trim();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const data = await new Response(stream).json();
  // Integer coordinates are stored at 64 units per metre.
  const vertices = data.v.map(v => [v[0] / 64, v[1] / 64, v[2] / 64]);
  const triangles = [];
  for (let i = 0; i < data.i.length; i += 3) {
    triangles.push([data.i[i], data.i[i + 1], data.i[i + 2]]);
  }
  return { vertices, triangles };
}

/* -------------------------------------------------------------------- weld */

/**
 * Merge vertices closer than `eps`. A hashed grid keyed at cell size `eps`
 * keeps this linear: any two points within eps share or neighbour a cell.
 */
function weld(vertices, triangles, eps = WELD_EPS) {
  const cells = new Map();
  const out = [];
  const remap = new Int32Array(vertices.length);
  const key = (x, y, z) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;

  for (let i = 0; i < vertices.length; i++) {
    const [x, y, z] = vertices[i];
    const cx = Math.round(x / eps), cy = Math.round(y / eps), cz = Math.round(z / eps);
    let found = -1;
    outer:
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            const p = out[j];
            if ((p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2 < eps * eps) { found = j; break outer; }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length;
      out.push([x, y, z]);
      const k = key(x, y, z);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(found);
    }
    remap[i] = found;
  }

  // Re-index, dropping triangles that collapsed to a line or point.
  const tris = [];
  for (const [a, b, c] of triangles) {
    const A = remap[a], B = remap[b], C = remap[c];
    if (A !== B && B !== C && A !== C) tris.push([A, B, C]);
  }
  return { vertices: out, triangles: tris };
}

/* ---------------------------------------------------------- boundary edges */

/** Edges used by exactly one triangle — the open rim of the surface. */
function boundaryEdges(triangles) {
  const uses = new Map();
  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t];
    for (let j = 0; j < 3; j++) {
      const a = tri[j], b = tri[(j + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const entry = uses.get(k);
      if (entry) entry.push(t); else uses.set(k, [t]);
    }
  }
  const edges = [];
  for (const [k, owners] of uses) {
    if (owners.length !== 1) continue;
    const [a, b] = k.split('_').map(Number);
    edges.push({ a, b, tri: owners[0] });
  }
  return edges;
}

/**
 * Describe a boundary edge: midpoint, length, and the outward XZ normal —
 * the perpendicular pointing away from the triangle that owns the edge.
 */
function describeEdge(edge, vertices, triangles) {
  const A = vertices[edge.a], B = vertices[edge.b];
  const tri = triangles[edge.tri];
  const third = tri.find(v => v !== edge.a && v !== edge.b);
  if (third === undefined) return null;
  const C = vertices[third];
  const dx = B[0] - A[0], dz = B[2] - A[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return null;
  let nx = -dz / len, nz = dx / len;
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, mz = (A[2] + B[2]) / 2;
  // Flip so the normal points away from the surface interior.
  if ((C[0] - mx) * nx + (C[2] - mz) * nz > 0) { nx = -nx; nz = -nz; }
  return { ...edge, A, B, mx, my, mz, nx, nz, len, dx: dx / len, dz: dz / len };
}

/* ---------------------------------------------------------- median stitch */

/**
 * Two boundary edges face each other across the median when they are close,
 * roughly anti-parallel, and each lies along the other's outward normal.
 * Only mutual best matches are stitched, so a true outer edge can never pair
 * with something across the infield.
 */
function facesAcrossMedian(p, q) {
  const dx = q.mx - p.mx, dz = q.mz - p.mz;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6 || dist > MEDIAN_MAX_GAP) return -1;
  const along = dx * p.nx + dz * p.nz;
  if (along < 0.05 || along / dist < 0.82) return -1;        // must be straight out, not sideways
  if (p.nx * q.nx + p.nz * q.nz > -0.7) return -1;            // normals must oppose
  if (Math.abs(p.dx * q.dx + p.dz * q.dz) < 0.86) return -1;  // edges must be parallel
  if (Math.abs(q.my - p.my) > MEDIAN_MAX_RISE) return -1;     // not an over/underpass
  return dist;
}

/** Bridge the median seam, returning the added triangles. */
function stitchMedian(vertices, triangles) {
  const edges = boundaryEdges(triangles)
    .map(e => describeEdge(e, vertices, triangles))
    .filter(Boolean);

  // Bucket by a coarse grid so each edge only tests nearby candidates.
  const CELL = MEDIAN_MAX_GAP * 2;
  const grid = new Map();
  edges.forEach((e, i) => {
    const k = `${Math.floor(e.mx / CELL)},${Math.floor(e.mz / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  const best = new Int32Array(edges.length).fill(-1);
  const bestDist = new Float64Array(edges.length).fill(Infinity);
  edges.forEach((p, i) => {
    const gx = Math.floor(p.mx / CELL), gz = Math.floor(p.mz / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
        if (i === j) continue;
        const d = facesAcrossMedian(p, edges[j]);
        if (d >= 0 && d < bestDist[i]) { bestDist[i] = d; best[i] = j; }
      }
    }
  });

  const added = [];
  const seam = [];
  for (let i = 0; i < edges.length; i++) {
    const j = best[i];
    if (j < 0 || j < i || best[j] !== i) continue;  // mutual best only, once per pair
    const p = edges[i], q = edges[j];
    let c = q.a, d = q.b;
    // Choose the winding that does not produce a bow-tie quad.
    const straight = dist3(vertices[p.b], vertices[c]) + dist3(vertices[p.a], vertices[d]);
    const crossed = dist3(vertices[p.b], vertices[d]) + dist3(vertices[p.a], vertices[c]);
    if (straight > crossed) { const t = c; c = d; d = t; }
    added.push([p.a, p.b, c], [p.a, c, d]);
    seam.push({ ax: p.mx, az: p.mz, bx: q.mx, bz: q.mz });
  }
  return { added, seam, edgeCount: edges.length, pairCount: added.length / 2 };
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/* ---------------------------------------------------------- boundary loops */

/** Split a triangle list into connected components, largest first. */
function components(vertices, triangles) {
  const parent = new Int32Array(vertices.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const ra = find(t[k]), rb = find(t[(k + 1) % 3]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map();
  for (const t of triangles) {
    const root = find(t[0]);
    let list = groups.get(root);
    if (!list) groups.set(root, list = []);
    list.push(t);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Chain the post-stitch boundary edges into ordered loops, longest first. */
function traceLoops(vertices, triangles) {
  const edges = boundaryEdges(triangles);
  const adjacency = new Map();
  for (const { a, b } of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  const visited = new Set();
  const loops = [];
  // Start from a vertex with exactly two boundary edges so the walk begins on a
  // clean stretch rather than inside a junction.
  const starts = [...adjacency.keys()].sort(
    (a, b) => adjacency.get(a).length - adjacency.get(b).length);

  for (const start of starts) {
    if (visited.has(start)) continue;
    const loop = [start];
    visited.add(start);
    let current = start, previous = -1;
    for (;;) {
      const options = (adjacency.get(current) ?? []).filter(v => v !== previous && !visited.has(v));
      if (options.length === 0) break;
      // At a junction a rim vertex can carry three or four boundary edges. Taking
      // an arbitrary one makes the traced rim jump to a distant part of the
      // circuit, which corrupts the centreline. Always continue as straight as
      // possible instead.
      let next = options[0];
      if (options.length > 1 && previous >= 0) {
        const inX = vertices[current][0] - vertices[previous][0];
        const inZ = vertices[current][2] - vertices[previous][2];
        const inLen = Math.hypot(inX, inZ) || 1;
        let bestDot = -Infinity;
        for (const candidate of options) {
          const ox = vertices[candidate][0] - vertices[current][0];
          const oz = vertices[candidate][2] - vertices[current][2];
          const oLen = Math.hypot(ox, oz) || 1;
          const dot = (inX / inLen) * (ox / oLen) + (inZ / inLen) * (oz / oLen);
          if (dot > bestDot) { bestDot = dot; next = candidate; }
        }
      }
      previous = current;
      current = next;
      visited.add(current);
      loop.push(current);
    }
    if (loop.length > 8) loops.push(loop);
  }
  const length = loop => loop.reduce(
    (sum, v, i) => sum + dist3(vertices[v], vertices[loop[(i + 1) % loop.length]]), 0);
  return loops
    .map(loop => ({ indices: loop, length: length(loop) }))
    .sort((a, b) => b.length - a.length);
}

/** Walk a closed polyline at a fixed arc-length step. */
function resample(points, step) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const seg = dist2(a[0], a[2], b[0], b[2]);
    if (seg < 1e-9) continue;
    let travelled = 0;
    while (carry + (seg - travelled) >= step) {
      travelled += step - carry;
      const f = travelled / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      carry = 0;
    }
    carry += seg - travelled;
  }
  return out;
}

/* -------------------------------------------------------------- centreline */

/**
 * Pair the outer rim against the inner rim: for each outer sample, the nearest
 * inner sample gives one cross-section. The midpoints form the centreline and
 * the separations give the corridor width.
 *
 * Widths are clamped because the two carriageways splay apart at the junction
 * areas (measured up to 74 m); beyond `maxWidth` the corridor stops being a
 * racing surface and the racing line should not wander into it.
 */
function buildCentreline(outer, inner, { step = 6, maxWidth = 9 } = {}) {
  const O = resample(outer, step);
  const I = resample(inner, step);
  const cellSize = 24;
  const grid = new Map();
  I.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cellSize)},${Math.floor(p[2] / cellSize)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  // The circuit contains a two-level interchange: around (83..282, 374..508)
  // one carriageway drops to Y = -2.5 while the other stays at Y = +0.19.
  // Without a height test the nearest inner-rim point to a sample on the lower
  // road is a point on the road *above* it, 21 m away in plan, and the paired
  // midpoint lands in mid-air between the two decks. Rims may only pair with
  // rims on their own level.
  const MAX_LEVEL_DIFFERENCE = 1.5;
  const nearestInner = p => {
    const gx = Math.floor(p[0] / cellSize), gz = Math.floor(p[2] / cellSize);
    let best = -1, bestD = Infinity;
    const consider = i => {
      const q = I[i];
      if (Math.abs(q[1] - p[1]) > MAX_LEVEL_DIFFERENCE) return;
      const d = (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    };
    for (let ring = 1; ring <= 6 && best < 0; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
        if (ring > 1 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        for (const i of grid.get(`${gx + dx},${gz + dz}`) ?? []) consider(i);
      }
    }
    if (best < 0) I.forEach((_, i) => consider(i));       // fall back to a full scan
    if (best < 0) {                                       // no same-level partner at all
      I.forEach((q, i) => {
        const d = (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
    }
    return { point: I[best], distance: Math.sqrt(bestD) };
  };

  const samples = O.map(p => {
    const { point: q, distance } = nearestInner(p);
    const width = Math.min(distance, maxWidth);
    // Keep the centre on the measured mid-point, but pull it toward the outer
    // rim where the corridor is over-wide so it stays on real road. The final
    // centre and width are re-measured against the actual road surface in
    // refineCentreline() — this is only the seed.
    const t = distance > 0 ? Math.min(0.5, width / (2 * distance)) : 0.5;
    return {
      x: p[0] + (q[0] - p[0]) * t,
      y: p[1] + (q[1] - p[1]) * t,
      z: p[2] + (q[2] - p[2]) * t,
      width,
      // Keep the cross-section endpoints so the corridor can be re-measured.
      outer: [p[0], p[1], p[2]],
      inner: [q[0], q[1], q[2]],
      rimGap: distance,
    };
  });

  smoothClosed(samples, 2);
  const lapLength = recomputeFrames(samples);
  return { samples, lapLength };
}

/**
 * (Re)derive arc length, tangents, left normals and signed curvature for a
 * closed ring of samples. Called once when the centreline is first built, and
 * again after the corridor is re-measured against the real road surface.
 *
 * @returns total loop length in metres
 */
export function recomputeFrames(samples) {
  const n = samples.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    samples[i].distance = total;
    total += dist2(samples[i].x, samples[i].z, samples[(i + 1) % n].x, samples[(i + 1) % n].z);
  }
  for (let i = 0; i < n; i++) {
    const prev = samples[(i - 1 + n) % n];
    const next = samples[(i + 1) % n];
    const tx = next.x - prev.x, tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    samples[i].tx = tx / len;
    samples[i].tz = tz / len;
    samples[i].nx = -samples[i].tz;   // left-hand normal in XZ
    samples[i].nz = samples[i].tx;
  }
  // Signed curvature from the turn angle between consecutive tangents.
  for (let i = 0; i < n; i++) {
    const a = samples[(i - 1 + n) % n], b = samples[i], c = samples[(i + 1) % n];
    const cross = b.tx * c.tz - b.tz * c.tx;
    const ds = (dist2(a.x, a.z, b.x, b.z) + dist2(b.x, b.z, c.x, c.z)) / 2;
    b.curvature = ds > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, cross))) / ds : 0;
  }
  return total;
}

/** In-place box smoothing of a closed sample ring (position only). */
function smoothClosed(samples, passes = 1) {
  for (let pass = 0; pass < passes; pass++) {
    const copy = samples.map(s => ({ x: s.x, y: s.y, z: s.z }));
    for (let i = 0; i < samples.length; i++) {
      const a = copy[(i - 1 + copy.length) % copy.length];
      const b = copy[i];
      const c = copy[(i + 1) % copy.length];
      samples[i].x = (a.x + 2 * b.x + c.x) / 4;
      samples[i].y = (a.y + 2 * b.y + c.y) / 4;
      samples[i].z = (a.z + 2 * b.z + c.z) / 4;
    }
  }
}

/* ------------------------------------------------------------------ public */

/**
 * Build the racing surface and its centreline from the original road asset.
 *
 * @returns {{
 *   positions: Float32Array, indices: Uint32Array,
 *   centreline: Array, lapLength: number,
 *   outerRim: Array, innerRim: Array, seam: Array, stats: object
 * }}
 */
export async function buildRacingSurface(url, options = {}) {
  const soup = await loadRoadSoup(url);
  const welded = weld(soup.vertices, soup.triangles);
  const { added, seam, pairCount } = stitchMedian(welded.vertices, welded.triangles);
  const triangles = welded.triangles.concat(added);

  // The centreline is seeded from ONE carriageway, not from the stitched
  // surface. After welding, each carriageway is a single closed ribbon whose
  // two rims are parallel and ~5 m apart along the whole lap (measured:
  // 3857 m vs 3856 m, and 3822 m vs 3817 m), so pairing them is unambiguous.
  // Seeding from the stitched surface instead pairs the outer rim against
  // whichever inner rim happens to be nearest, which goes badly wrong through
  // the junctions where the carriageways splay apart.
  const carriageways = components(welded.vertices, welded.triangles);
  if (carriageways.length < 1) throw new Error('Road mesh has no surface');
  const primary = carriageways[0];
  const rims = traceLoops(welded.vertices, primary);
  if (rims.length < 2) {
    throw new Error(`Expected two rims on the primary carriageway, found ${rims.length}`);
  }
  const outer = rims[0].indices.map(i => welded.vertices[i]);
  const inner = rims[1].indices.map(i => welded.vertices[i]);
  const { samples, lapLength } = buildCentreline(outer, inner, options);

  const positions = new Float32Array(welded.vertices.length * 3);
  welded.vertices.forEach((v, i) => {
    positions[i * 3] = v[0]; positions[i * 3 + 1] = v[1]; positions[i * 3 + 2] = v[2];
  });
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => {
    indices[i * 3] = t[0]; indices[i * 3 + 1] = t[1]; indices[i * 3 + 2] = t[2];
  });

  return {
    positions,
    indices,
    centreline: samples,
    lapLength,
    outerRim: outer,
    innerRim: inner,
    seam,
    stats: {
      sourceVertices: soup.vertices.length,
      sourceTriangles: soup.triangles.length,
      weldedVertices: welded.vertices.length,
      carriageways: carriageways.filter(c => c.length > 20).length,
      stitchedPairs: pairCount,
      triangles: triangles.length,
      outerRim: Math.round(rims[0].length),
      innerRim: Math.round(rims[1].length),
      lapLength: Math.round(lapLength),
      medianWidth: median(samples.map(s => s.width)),
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[sorted.length >> 1] * 10) / 10;
}
