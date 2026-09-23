/**
 * build.js — turns the solved circuit into three.js geometry and Rapier colliders.
 *
 * The original road mesh is preserved exactly; everything else (markings, kerbs,
 * barriers, run-off, scenery) is generated from the centreline and laid on top.
 * Draw-call discipline matters here: a 3.87 km circuit is easy to turn into
 * thousands of objects, so ribbons are merged into single meshes and anything
 * repeated is instanced.
 */

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildRacingSurface } from './roadmesh.js';
import { Circuit, fillCarriagewayGaps } from './racingline.js';

const ASSETS = new URL('../../Codex/assets/', import.meta.url);
const REALISM = new URL('realism/', ASSETS);
const DRACO_PATH = new URL('../../Codex/vendor/three/examples/jsm/libs/draco/gltf/', import.meta.url).href;

/* ───────────────────────────── textures ───────────────────────────── */

async function loadSurfaceSet(loader, name, repeat, maxAniso) {
  const [map, normalMap, roughnessMap] = await Promise.all([
    loader.loadAsync(new URL(`${name}-diff.webp`, REALISM).href),
    loader.loadAsync(new URL(`${name}-nor_gl.webp`, REALISM).href),
    loader.loadAsync(new URL(`${name}-rough.webp`, REALISM).href),
  ]);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, normalMap, roughnessMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.setScalar(repeat);
    texture.anisotropy = maxAniso;
  }
  return { map, normalMap, roughnessMap };
}

/**
 * Paint lane markings, the start/finish line and the racing groove into a
 * texture that is addressed in corridor space.
 *
 * The road's UVs are (lateral offset, distance along lap), so a single canvas
 * whose X axis is "across the track" and Y axis is "around the lap" lands every
 * mark exactly where it belongs without decals or a second UV set. The canvas
 * is deliberately tall and narrow — resolution is spent along the lap, which is
 * 380x longer than the track is wide.
 */
function paintRoadOverlay(circuit, { width = 256, height = 4096 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, width, height);

  // The racing groove: a darker, rubbered-in band that follows the racing line.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#0d0f12';
  ctx.lineWidth = width * 0.17;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= circuit.racingLine.length; i++) {
    const point = circuit.racingLine[i % circuit.racingLine.length];
    const sample = circuit.centreline[i % circuit.centreline.length];
    const halfWidth = Math.max(3, sample.width / 2);
    const x = width * (0.5 + (point.offset / (halfWidth * 2)));
    const y = height * (point.distance / circuit.racingLineLength);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // White edge lines just inside both corridor edges.
  ctx.strokeStyle = 'rgba(236,240,244,0.92)';
  ctx.lineWidth = Math.max(2, width * 0.022);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= circuit.centreline.length; i++) {
      const sample = circuit.centreline[i % circuit.centreline.length];
      const halfWidth = Math.max(3, sample.width / 2);
      const inset = halfWidth - 0.35;
      const x = width * (0.5 + side * (inset / (halfWidth * 2)));
      const y = height * (sample.distance / circuit.lapLength);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Dashed centre line.
  ctx.setLineDash([height / 190, height / 190]);
  ctx.strokeStyle = 'rgba(226,232,240,0.55)';
  ctx.lineWidth = Math.max(1.5, width * 0.014);
  ctx.beginPath();
  ctx.moveTo(width * 0.5, 0);
  ctx.lineTo(width * 0.5, height);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start/finish: a band of checks across the full width at lap distance 0.
  const bandHeight = Math.max(6, height * 0.0045);
  const checks = 14;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < checks; col++) {
      ctx.fillStyle = (row + col) % 2 ? '#f2f5f8' : '#14181f';
      ctx.fillRect(col * (width / checks), row * (bandHeight / 2),
                   width / checks, bandHeight / 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/* ───────────────────────────── corners ───────────────────────────── */

/**
 * Group consecutive high-curvature samples into corners.
 * Curvature is noisy on a mesh this coarse, so it is smoothed first and a
 * corner must persist for a minimum arc length before it counts.
 */
function detectCorners(circuit, { minRadius = 260, minLength = 22 } = {}) {
  const line = circuit.centreline;
  const n = line.length;
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -3; k <= 3; k++) sum += line[(i + k + n) % n].curvature;
    smooth[i] = sum / 7;
  }

  const threshold = 1 / minRadius;
  const corners = [];
  let run = null;
  for (let i = 0; i <= n; i++) {
    const index = i % n;
    const curvature = smooth[index];
    const turning = Math.abs(curvature) > threshold;
    const direction = Math.sign(curvature);
    if (turning && (!run || run.direction === direction)) {
      run ??= { start: index, direction, peak: 0, peakIndex: index };
      if (Math.abs(curvature) > run.peak) { run.peak = Math.abs(curvature); run.peakIndex = index; }
      run.end = index;
    } else if (run) {
      const length = circuit.gapAlong(line[run.start].distance, line[run.end].distance);
      if (Math.abs(length) >= minLength) {
        corners.push({
          index: run.peakIndex,
          distance: line[run.peakIndex].distance,
          entry: line[run.start].distance,
          exit: line[run.end].distance,
          radius: 1 / Math.max(run.peak, 1e-6),
          direction: run.direction,        // +1 = left-hand, -1 = right-hand
          length: Math.abs(length),
        });
      }
      run = turning ? { start: index, direction, peak: Math.abs(curvature), peakIndex: index, end: index } : null;
    }
  }
  corners.sort((a, b) => a.distance - b.distance);
  corners.forEach((corner, i) => { corner.number = i + 1; });
  return corners;
}

/* ───────────────────────── ribbon construction ───────────────────────── */

/**
 * Build a strip of geometry that follows the corridor edge over a span of the
 * lap. Returns positions/normals/uvs/indices for merging into a larger mesh.
 *
 * @param profile  cross-section as [{ across, up, u }] in metres, left to right
 */
function ribbon(circuit, fromDistance, toDistance, side, inset, profile, step = 3,
                { anchor = 'centre', faceUp = true } = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const span = ((toDistance - fromDistance) % circuit.lapLength + circuit.lapLength) % circuit.lapLength;
  const rings = Math.max(2, Math.ceil(span / step));

  for (let r = 0; r <= rings; r++) {
    const distance = fromDistance + (span * r) / rings;
    const sample = sampleCorridor(circuit, distance);
    const edge = side * (sample.width / 2 - inset);
    // Heights from the road's actual edge, not the centreline: the road leans
    // and climbs across its width, and hanging the verge and kerbs off the
    // centre height left them up to 1.8 m above or below the tarmac.
    const base = anchor === 'edge' ? edgeHeight(circuit, sample, side) : sample.y;
    for (const point of profile) {
      const across = edge + side * point.across;
      positions.push(
        sample.x + sample.nx * across,
        base + point.up,
        sample.z + sample.nz * across);
      normals.push(0, 1, 0);
      uvs.push(point.u, distance * 0.35);
    }
  }
  const stride = profile.length;
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < stride - 1; c++) {
      const a = r * stride + c, b = a + 1, d = a + stride, e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  if (faceUp) orientUp(positions, indices);
  return { positions, normals, uvs, indices };
}

/**
 * Wind every triangle to face up. A ribbon mirrored to the other side of the
 * road comes out wound the other way, and a single-sided material culls those:
 * one side's grass and kerbs were invisible — you saw the ground plane a metre
 * below instead, while the (double-sided) collider was still there, so the car
 * drove on thin air until the strip ended and it fell through.
 */
function orientUp(positions, indices) {
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ny = (positions[b + 2] - positions[a + 2]) * (positions[c] - positions[a])
             - (positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]);
    if (ny < 0) { const swap = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = swap; }
  }
}

/** Height of the tarmac at the corridor edge on one side (probing inward if the edge is just off it). */
function edgeHeight(circuit, sample, side) {
  const edge = sample.width / 2;
  for (let t = 0; t <= 1.5; t += 0.1) {
    const across = side * (edge - t);
    const y = circuit.heightAt(sample.x + sample.nx * across, sample.z + sample.nz * across, sample.y);
    if (y !== null) return y;
  }
  return sample.y;
}

/**
 * The ground beside the road, as a height at a distance from the road edge:
 * level with the tarmac out past the barriers, then an embankment down to the
 * surrounding ground. Used for the verge mesh and to stand the trees on it.
 */
const GROUND_LEVEL = -1.2;
function terrainHeight(edgeY, fromEdge) {
  const level = edgeY - 0.10;
  const floor = GROUND_LEVEL + 0.02;
  if (fromEdge <= 0) return edgeY - 0.03;
  if (fromEdge <= 3) return edgeY - 0.03 - (0.02 * fromEdge) / 3;
  if (fromEdge <= 13) return edgeY - 0.05 - (0.05 * (fromEdge - 3)) / 10;
  if (level <= floor) return Math.max(floor, level);
  if (fromEdge >= 30) return floor;
  const t = (fromEdge - 13) / 17;
  return level + (floor - level) * (t * t * (3 - 2 * t));    // eased embankment
}

/**
 * One side's verge: from just under the road edge, level with it out past the
 * barriers, then down an embankment to the ground. It never covers another
 * stretch of road — where the track passes close to itself, grass that would
 * sit on or just above that road is kept underneath it.
 */
function vergeStrip(circuit, side, step = 6) {
  const ACROSS = [-0.6, 0, 3, 8, 13, 17, 21, 25, 30];
  const positions = [], normals = [], uvs = [], indices = [];
  const rings = Math.max(2, Math.ceil(circuit.lapLength / step));
  for (let r = 0; r <= rings; r++) {
    const distance = (circuit.lapLength * r) / rings;
    const sample = sampleCorridor(circuit, distance);
    const edgeY = edgeHeight(circuit, sample, side);
    for (const fromEdge of ACROSS) {
      const across = side * (sample.width / 2 + fromEdge);
      const x = sample.x + sample.nx * across, z = sample.z + sample.nz * across;
      let y = terrainHeight(edgeY, fromEdge);
      if (fromEdge >= 1) {
        const road = circuit.heightAt(x, z, y);
        if (road !== null && road < y + 0.4) y = Math.min(y, road - 0.35);
      }
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      uvs.push(fromEdge * 0.3, distance * 0.35);
    }
  }
  const stride = ACROSS.length;
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < stride - 1; c++) {
      const a = r * stride + c, b = a + 1, d = a + stride, e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  orientUp(positions, indices);
  return { positions, normals, uvs, indices };
}

/** Interpolated centreline sample at an arbitrary lap distance. */
function sampleCorridor(circuit, distance) {
  const line = circuit.centreline;
  const n = line.length;
  const d = ((distance % circuit.lapLength) + circuit.lapLength) % circuit.lapLength;
  let i = Math.min(n - 1, Math.floor((d / circuit.lapLength) * n));
  while (i > 0 && line[i].distance > d) i--;
  while (i + 1 < n && line[i + 1].distance <= d) i++;
  const a = line[i], b = line[(i + 1) % n];
  const segment = (b.distance - a.distance + circuit.lapLength) % circuit.lapLength || 1;
  const t = Math.max(0, Math.min(1, (d - a.distance) / segment));
  const lerp = (p, q) => p + (q - p) * t;
  const nx = lerp(a.nx, b.nx), nz = lerp(a.nz, b.nz);
  const length = Math.hypot(nx, nz) || 1;
  return {
    x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z),
    nx: nx / length, nz: nz / length,
    tx: lerp(a.tx, b.tx), tz: lerp(a.tz, b.tz),
    width: lerp(a.width, b.width),
  };
}

function mergeChunks(chunks) {
  const totalVerts = chunks.reduce((n, c) => n + c.positions.length / 3, 0);
  const totalIndices = chunks.reduce((n, c) => n + c.indices.length, 0);
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
  let vertexOffset = 0, indexOffset = 0;
  for (const chunk of chunks) {
    positions.set(chunk.positions, vertexOffset * 3);
    normals.set(chunk.normals, vertexOffset * 3);
    uvs.set(chunk.uvs, vertexOffset * 2);
    for (let i = 0; i < chunk.indices.length; i++) indices[indexOffset + i] = chunk.indices[i] + vertexOffset;
    vertexOffset += chunk.positions.length / 3;
    indexOffset += chunk.indices.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ───────────────────────────── public ───────────────────────────── */

export async function buildCircuit(scene, world, RAPIER, options = {}) {
  const quality = options.quality ?? {};
  const renderer = options.renderer;
  const maxAniso = Math.min(quality.road?.aniso ?? 8,
    renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);

  const surface = await buildRacingSurface(new URL('highway-road.b64', ASSETS).href);
  // Pave the grass between the carriageways before anything measures the road.
  fillCarriagewayGaps(surface);
  // Face every road triangle up. The median stitch and parts of the source mesh
  // come out wound downward, and a single-sided material culls those, so the
  // ground plane showed through as a grass strip down the middle of the road.
  {
    const p = surface.positions, idx = surface.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ny = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      if (ny < 0) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
    }
  }
  const circuit = new Circuit(surface);
  const corners = detectCorners(circuit);

  const root = new THREE.Group();
  root.name = 'Circuit';
  scene.add(root);

  const loader = new THREE.TextureLoader();
  const [asphalt, grass, concrete] = await Promise.all([
    loadSurfaceSet(loader, 'asphalt', 1, maxAniso),
    loadSurfaceSet(loader, 'grass', 1, maxAniso),
    loadSurfaceSet(loader, 'concrete', 1, maxAniso),
  ]);

  /* ---------------------------------------------------- the road itself */

  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  roadGeometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));

  // Corridor UVs: u across the track, v along the lap. Asphalt tiles in world
  // metres; the overlay texture uses the same parameterisation normalised.
  const vertexCount = surface.positions.length / 3;
  const roadUV = new Float32Array(vertexCount * 2);
  const overlayUV = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    const x = surface.positions[i * 3], z = surface.positions[i * 3 + 2];
    const located = circuit.locate(x, z);
    const halfWidth = Math.max(3, located.width / 2);
    roadUV[i * 2] = located.offset / 3.2;
    roadUV[i * 2 + 1] = located.distance / 3.2;
    overlayUV[i * 2] = 0.5 + located.offset / (halfWidth * 2);
    overlayUV[i * 2 + 1] = located.distance / circuit.lapLength;
  }
  roadGeometry.setAttribute('uv', new THREE.BufferAttribute(roadUV, 2));
  roadGeometry.setAttribute('uv1', new THREE.BufferAttribute(overlayUV, 2));
  roadGeometry.computeVertexNormals();
  roadGeometry.computeBoundingSphere();

  const roadMaterial = new THREE.MeshStandardMaterial({
    ...asphalt,
    color: 0x9aa0a7,
    roughness: 1,
    metalness: 0.02,
    envMapIntensity: 0.55,
  });
  roadMaterial.name = 'Asphalt';

  // The markings ride in a second material layer rather than being baked into
  // the asphalt albedo, so wetness can darken the road without smearing paint.
  const overlayTexture = paintRoadOverlay(circuit);
  const overlayMaterial = new THREE.MeshStandardMaterial({
    map: overlayTexture,
    transparent: true,
    roughness: 0.62,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    depthWrite: false,
  });
  overlayMaterial.name = 'RoadMarkings';
  // The overlay is addressed by the second UV set. This used to be done by
  // patching the shader to read `uv1`, but three only declares that attribute
  // when a texture asks for channel 1 — so the patched shader never compiled,
  // and the markings, start line and racing groove silently never drew.
  // Asking for the channel is the supported way and needs no patch.
  overlayTexture.channel = 1;

  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.receiveShadow = true;
  road.name = 'Road';
  root.add(road);

  const markings = new THREE.Mesh(roadGeometry, overlayMaterial);
  markings.receiveShadow = false;
  markings.renderOrder = 1;
  markings.name = 'RoadMarkings';
  // Off, deliberately. The markings never actually drew — their shader failed
  // to compile (fixed above) — so every build Luca has played has bare tarmac.
  // Turning them on is a visual change he has not asked for; flip this to true
  // when he does.
  markings.visible = false;
  root.add(markings);

  world.createCollider(
    RAPIER.ColliderDesc.trimesh(surface.positions, surface.indices)
      .setFriction(1.0).setRestitution(0.01));

  /* ---------------------------------------------------------- kerbs */

  const kerbChunks = [];
  const kerbColliders = [];
  const KERB_PROFILE = [
    { across: 0.00, up: 0.000, u: 0 },
    { across: 0.18, up: 0.055, u: 0.25 },
    { across: 1.35, up: 0.070, u: 0.85 },
    { across: 1.65, up: 0.010, u: 1 },
  ];
  for (const corner of corners) {
    // Kerbs go on the inside of the corner, extended a little past both ends
    // because drivers use the exit kerb well after the apex.
    const side = corner.direction > 0 ? 1 : -1;
    const from = corner.entry - 8;
    const to = corner.exit + 14;
    kerbChunks.push(ribbon(circuit, from, to, side, 0.1, KERB_PROFILE, 2.5, { anchor: 'edge' }));

    const span = ((to - from) % circuit.lapLength + circuit.lapLength) % circuit.lapLength;
    const segments = Math.max(2, Math.round(span / 4));
    for (let s = 0; s < segments; s++) {
      const sample = sampleCorridor(circuit, from + (span * (s + 0.5)) / segments);
      const across = side * (sample.width / 2 + 0.72);
      const yaw = Math.atan2(sample.tx, sample.tz);
      kerbColliders.push(
        RAPIER.ColliderDesc.cuboid(0.85, 0.035, span / segments / 2)
          .setTranslation(sample.x + sample.nx * across, edgeHeight(circuit, sample, side) + 0.035, sample.z + sample.nz * across)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
          .setFriction(0.92));
    }
  }
  const kerbTexture = makeKerbTexture();
  const kerbMaterial = new THREE.MeshStandardMaterial({
    map: kerbTexture, roughness: 0.72, metalness: 0.02, envMapIntensity: 0.6,
  });
  kerbMaterial.name = 'Kerb';
  if (kerbChunks.length) {
    const kerbMesh = new THREE.Mesh(mergeChunks(kerbChunks), kerbMaterial);
    kerbMesh.receiveShadow = true;
    kerbMesh.castShadow = true;
    kerbMesh.name = 'Kerbs';
    root.add(kerbMesh);
  }
  for (const desc of kerbColliders) world.createCollider(desc);

  /* -------------------------------------------------------- barriers */

  const BARRIER_PROFILE = [
    { across: 0.00, up: -0.25, u: 0 },   // sunk in so no gap shows under it
    { across: 0.00, up:  1.20, u: 1 },
  ];
  const barrierChunks = [];
  const BARRIER_SETBACK = -12.0;     // negative = outside the corridor edge
  for (const side of [1, -1]) {
    barrierChunks.push(ribbon(circuit, 0, circuit.lapLength - 0.01, side, BARRIER_SETBACK, BARRIER_PROFILE, 6,
      { anchor: 'edge', faceUp: false }));
  }
  const barrierMaterial = new THREE.MeshStandardMaterial({
    ...concrete, color: 0xcdd2d6, roughness: 0.8, metalness: 0.05,
    side: THREE.DoubleSide, envMapIntensity: 0.7,
  });
  barrierMaterial.name = 'Barrier';
  const barrierMesh = new THREE.Mesh(mergeChunks(barrierChunks), barrierMaterial);
  barrierMesh.castShadow = true;
  barrierMesh.receiveShadow = true;
  barrierMesh.name = 'Barriers';
  root.add(barrierMesh);

  // One collider every 8 m rather than one per mesh edge: smooth enough that a
  // car sliding along it does not catch, cheap enough to be free.
  const barrierStep = 8;
  for (const side of [1, -1]) {
    for (let d = 0; d < circuit.lapLength; d += barrierStep) {
      const sample = sampleCorridor(circuit, d + barrierStep / 2);
      const across = side * (sample.width / 2 + Math.abs(BARRIER_SETBACK));  // matches the ribbon
      const yaw = Math.atan2(sample.tx, sample.tz);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.22, 0.72, barrierStep / 2 + 0.15)
          .setTranslation(sample.x + sample.nx * across, edgeHeight(circuit, sample, side) + 0.62, sample.z + sample.nz * across)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
          .setFriction(0.32).setRestitution(0.08));
    }
  }

  /* ------------------------------------------------- verges and ground */

  const vergeChunks = [];
  for (const side of [1, -1]) vergeChunks.push(vergeStrip(circuit, side));
  const grassMaterial = new THREE.MeshStandardMaterial({
    ...grass, color: 0x7f9163, roughness: 1, metalness: 0, envMapIntensity: 0.5,
  });
  grassMaterial.name = 'Grass';
  const vergeGeometry = mergeChunks(vergeChunks);
  const verge = new THREE.Mesh(vergeGeometry, grassMaterial);
  verge.receiveShadow = true;
  verge.name = 'Verges';
  root.add(verge);

  // Give the verge real physics. Without this the grass is decorative only and
  // a car leaving the track falls through it to the ground plane below.
  {
    const vp = vergeGeometry.attributes.position.array;
    const vi = vergeGeometry.index.array;
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(
        vp instanceof Float32Array ? vp : new Float32Array(vp),
        vi instanceof Uint32Array ? vi : new Uint32Array(vi))
        .setFriction(0.62).setRestitution(0.01));
  }

  // A large ground plane under everything so there is no void at the horizon.
  const groundTextures = {
    map: grass.map.clone(), normalMap: grass.normalMap.clone(), roughnessMap: grass.roughnessMap.clone(),
  };
  for (const texture of Object.values(groundTextures)) {
    texture.repeat.set(420, 420);
    texture.needsUpdate = true;
  }
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000, 1, 1),
    new THREE.MeshStandardMaterial({ ...groundTextures, color: 0x74855b, roughness: 1, envMapIntensity: 0.45 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_LEVEL;
  ground.receiveShadow = true;
  ground.name = 'Ground';
  root.add(ground);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(4500, 0.5, 4500).setTranslation(0, -1.7, 0).setFriction(0.62));

  /* ---------------------------------------------------------- scenery */

  const scenery = new THREE.Group();
  scenery.name = 'Scenery';
  root.add(scenery);

  let treeClusters = [];
  try {
    treeClusters = await buildTrees(circuit, quality.scenery?.trees ?? 800);
    for (const cluster of treeClusters) for (const mesh of cluster.parts) scenery.add(mesh);
  } catch (error) {
    console.warn('Trees unavailable:', error.message);
  }

  const { grandstands, posts } = buildTrackside(circuit, corners, concrete);
  scenery.add(grandstands, posts);

  /* ------------------------------------------------- start and the grid */

  const startSample = sampleCorridor(circuit, 0);
  const startYaw = Math.atan2(startSample.tx, startSample.tz);
  const start = {
    position: new THREE.Vector3(startSample.x, startSample.y + 0.62, startSample.z),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), startYaw),
  };

  // 20 staggered slots behind the line, alternating sides like a real grid.
  const gridSlots = [];
  for (let i = 0; i < 20; i++) {
    const distance = circuit.lapLength - 12 - i * 8;
    const sample = sampleCorridor(circuit, distance);
    const lateral = (i % 2 === 0 ? 1 : -1) * Math.min(2.4, sample.width / 4);
    gridSlots.push({
      position: new THREE.Vector3(
        sample.x + sample.nx * lateral,
        sample.y + 0.62,
        sample.z + sample.nz * lateral),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.atan2(sample.tx, sample.tz)),
      distance,
    });
  }

  // Paint a grid box at every slot: a line across in front of the car's nose
  // and two short legs running back along its sides, like a real F1 grid.
  {
    const positions = [];
    const quad = (distance, lateral, halfAlong, halfAcross) => {
      const sample = sampleCorridor(circuit, distance);
      const cx = sample.x + sample.nx * lateral, cz = sample.z + sample.nz * lateral;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        const x = cx + sample.tx * halfAlong * v + sample.nx * halfAcross * u;
        const z = cz + sample.tz * halfAlong * v + sample.nz * halfAcross * u;
        const y = (circuit.heightAt(x, z, sample.y) ?? sample.y) + 0.012;
        positions.push(x, y, z);
      }
    };
    for (const slot of gridSlots) {
      const located = circuit.locate(slot.position.x, slot.position.z);
      const front = slot.distance + 3.3;
      quad(front, located.offset, 0.1, 1.15);                        // front line
      for (const side of [-1, 1]) quad(front - 0.8, located.offset + side * 1.1, 0.8, 0.07);
    }
    // Keep every triangle facing up whichever way the corridor frame is handed.
    for (let i = 0; i < positions.length; i += 9) {
      const ux = positions[i + 3] - positions[i], uz = positions[i + 5] - positions[i + 2];
      const vx = positions[i + 6] - positions[i], vz = positions[i + 8] - positions[i + 2];
      if (uz * vx - ux * vz < 0) {
        for (let k = 0; k < 3; k++) {
          const t = positions[i + 3 + k]; positions[i + 3 + k] = positions[i + 6 + k]; positions[i + 6 + k] = t;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const paint = new THREE.MeshStandardMaterial({
      color: 0xeef1f4, roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    paint.name = 'GridBoxes';
    const boxes = new THREE.Mesh(geometry, paint);
    boxes.name = 'GridBoxes';
    boxes.receiveShadow = true;
    boxes.renderOrder = 2;
    root.add(boxes);
  }

  /* -------------------------------------------------------- lifecycle */

  const materials = {
    road: roadMaterial, markings: overlayMaterial, kerb: kerbMaterial,
    grass: grassMaterial, barrier: barrierMaterial, ground: ground.material,
  };

  function setQuality(preset) {
    const aniso = Math.min(preset?.road?.aniso ?? 8,
      renderer?.capabilities?.getMaxAnisotropy?.() ?? 8);
    for (const set of [asphalt, grass, concrete]) {
      for (const texture of Object.values(set)) { texture.anisotropy = aniso; texture.needsUpdate = true; }
    }
    // The budget used to be spent per mesh, and every tree is three meshes
    // (branches, leaves, trunk) — so a third of it went on each part, and the
    // cluster where it ran out got, say, all its branches, some leaves and no
    // trunks: canopies floating in mid-air. It is now spent per tree, at the
    // same third, so the forest has exactly the density it always had, whole.
    const trees = Math.floor((preset?.scenery?.trees ?? 800) / 3);
    let used = 0;
    for (const cluster of treeClusters) {
      const allowed = Math.max(0, Math.min(cluster.total, trees - used));
      cluster.count = allowed;
      // A partly-budgeted cluster shows its first `allowed` trees in placement
      // order, as it always did; each piece shows those of its trees that fall
      // in that prefix (its trees are stored in placement order).
      for (const piece of cluster.pieces) {
        let shown = 0;
        while (shown < piece.orders.length && piece.orders[shown] < allowed) shown++;
        for (const mesh of piece.parts) { mesh.count = shown; mesh.visible = shown > 0; }
        piece.shown = shown;
      }
      used += allowed;
    }
    const distance = preset?.scenery?.drawDistance ?? 900;
    scenery.userData.drawDistance = distance;
  }

  const cullVector = new THREE.Vector3();
  function update(dt, cameraPosition) {
    const distance = scenery.userData.drawDistance ?? 900;
    if (!cameraPosition) return;
    // Bucketed distance culling: each tree cluster carries its own centre, so a
    // whole cluster can be skipped without touching its instances.
    for (const cluster of treeClusters) {
      cullVector.copy(cluster.centre).sub(cameraPosition);
      const shown = cluster.count > 0 && cullVector.lengthSq() < (distance + 180) ** 2;
      for (const piece of cluster.pieces) {
        const on = shown && piece.shown > 0;
        for (const mesh of piece.parts) mesh.visible = on;
      }
    }
  }

  function dispose() {
    root.traverse(object => {
      object.geometry?.dispose?.();
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) {
        if (!material) continue;
        for (const value of Object.values(material)) value?.isTexture && value.dispose();
        material.dispose();
      }
    });
    scene.remove(root);
  }

  setQuality(quality);

  return {
    circuit, root, materials, start, gridSlots, corners,
    setQuality, update, dispose,
    stats: { ...surface.stats, corners: corners.length },
  };
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Red/white kerb stripes, generated rather than shipped as an asset. */
function makeKerbTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? '#e8ecef' : '#d21f33';
    ctx.fillRect(0, i * 8, 8, 8);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

/**
 * Instanced trees, bucketed into spatial clusters so whole groups can be culled.
 * Candidate positions are rejected wherever the road query returns a height —
 * that is the cheapest possible "is this on the track" test and it is exact.
 */
async function buildTrees(circuit, budget) {
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  let gltf;
  try {
    gltf = await new GLTFLoader().setDRACOLoader(draco)
      .loadAsync(new URL('tree.glb', REALISM).href);
  } finally {
    draco.dispose();
  }
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const centre = box.getCenter(new THREE.Vector3());
  const height = box.max.y - box.min.y || 1;

  let seed = 20260919;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

  // Place along the lap, outside the barriers, in clusters of ~24.
  const clusters = new Map();
  const wanted = Math.max(budget, 120);
  let attempts = 0;
  let placed = 0;                 // running total; re-summing every cluster per attempt was quadratic
  while (attempts < wanted * 12 && placed < wanted) {
    attempts++;
    const distance = random() * circuit.lapLength;
    const sample = sampleCorridor(circuit, distance);
    const side = random() < 0.5 ? 1 : -1;
    const across = side * (sample.width / 2 + 6 + random() * 78);
    const x = sample.x + sample.nx * across;
    const z = sample.z + sample.nz * across;
    if (circuit.heightAt(x, z) !== null) continue;        // would be on the road
    const key = `${Math.floor(x / 220)},${Math.floor(z / 220)}`;
    if (!clusters.has(key)) clusters.set(key, []);
    // Stand the tree on the ground at that distance from the road edge — the
    // verge, the embankment or the flat beyond — instead of at a fixed height
    // under the centreline, which left trees floating over the embankment.
    const groundY = terrainHeight(edgeHeight(circuit, sample, side), Math.abs(across) - sample.width / 2);
    clusters.get(key).push({ x, y: groundY - 0.15, z, scale: 0.75 + random() * 0.9, yaw: random() * Math.PI * 2 });
    placed++;
  }

  const source = [];
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    geometry.translate(-centre.x, -box.min.y, -centre.z);
    source.push({ geometry, material: object.material });
  });

  // A 220 m cluster decides WHICH trees exist (the budget) and when the group
  // is too far away to draw. But a 220 m block is far bigger than the view:
  // one that is barely on screen used to draw every tree in it, including the
  // ones behind the camera — and the shadow pass drew whole blocks straddling
  // its ±160 m box. Each cluster is therefore drawn as 55 m pieces, which the
  // renderer culls to the view and the shadow box individually. The trees, and
  // which of them are shown, are exactly the same; only unseen ones are skipped.
  const PIECE = 55;
  const result = [];
  const dummy = new THREE.Object3D();
  for (const placements of clusters.values()) {
    const bucketCentre = placements.reduce(
      (v, p) => v.add(new THREE.Vector3(p.x, p.y, p.z)), new THREE.Vector3())
      .divideScalar(placements.length);
    const pieces = new Map();
    placements.forEach((p, order) => {
      const key = `${Math.floor(p.x / PIECE)},${Math.floor(p.z / PIECE)}`;
      if (!pieces.has(key)) pieces.set(key, []);
      pieces.get(key).push({ ...p, order });           // `order` ascending within each piece
    });
    // One cluster = one set of trees; its parts (branches, leaves, trunk) are
    // always shown and budgeted together.
    const cluster = { parts: [], pieces: [], total: placements.length, count: placements.length, centre: bucketCentre };
    for (const members of pieces.values()) {
      const piece = { parts: [], orders: members.map(m => m.order) };
      for (const { geometry, material } of source) {
        const mesh = new THREE.InstancedMesh(geometry, material, members.length);
        members.forEach((p, i) => {
          dummy.position.set(p.x, p.y, p.z);
          dummy.rotation.set(0, p.yaw, 0);
          dummy.scale.setScalar((p.scale * 9) / height);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        piece.parts.push(mesh);
        cluster.parts.push(mesh);
      }
      cluster.pieces.push(piece);
    }
    result.push(cluster);
  }
  return result;
}


/** Grandstands near the start/finish straight and marshal posts around the lap. */
function buildTrackside(circuit, corners, concrete) {
  const dummy = new THREE.Object3D();

  const standMaterial = new THREE.MeshStandardMaterial({
    ...concrete, color: 0xb9c0c6, roughness: 0.85, metalness: 0.04,
  });
  const standGeometry = new THREE.BoxGeometry(1, 1, 1);
  const standPlacements = [];
  for (let i = 0; i < 6; i++) {
    const distance = circuit.lapLength - 260 + i * 46;
    const sample = sampleCorridor(circuit, distance);
    const side = i % 2 === 0 ? 1 : -1;
    const across = side * (sample.width / 2 + 16);
    standPlacements.push({
      x: sample.x + sample.nx * across,
      y: sample.y + 5,
      z: sample.z + sample.nz * across,
      yaw: Math.atan2(sample.tx, sample.tz),
    });
  }
  const grandstands = new THREE.InstancedMesh(standGeometry, standMaterial, standPlacements.length);
  standPlacements.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.yaw, 0);
    dummy.scale.set(9, 10, 40);
    dummy.updateMatrix();
    grandstands.setMatrixAt(i, dummy.matrix);
  });
  grandstands.castShadow = true;
  grandstands.receiveShadow = true;
  grandstands.name = 'Grandstands';

  // A marshal post on the outside of every corner.
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0xe6a93a, roughness: 0.6, metalness: 0.2 });
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 2.2, 1.2), postMaterial, corners.length);
  corners.forEach((corner, i) => {
    const sample = sampleCorridor(circuit, corner.distance);
    const across = -corner.direction * (sample.width / 2 + 5);
    dummy.position.set(sample.x + sample.nx * across, sample.y + 1.1, sample.z + sample.nz * across);
    dummy.rotation.set(0, Math.atan2(sample.tx, sample.tz), 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  });
  posts.castShadow = true;
  posts.name = 'MarshalPosts';

  return { grandstands, posts };
}

export { sampleCorridor, detectCorners };
