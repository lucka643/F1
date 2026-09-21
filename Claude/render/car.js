/**
 * car.js — loads the RB19 and makes it drivable.
 *
 * The asset is one mesh with one baked material, so the wheels are not
 * separate objects and cannot be rotated. To animate them we split the
 * geometry by triangle: any triangle whose vertices all fall inside a wheel's
 * bounding box is moved into that wheel's group, everything else stays on the
 * chassis. That is the same trick Codex used and it is the right one — but
 * this version keeps the material as a single shared instance rather than
 * cloning it five times, and upgrades it to a physical material with real
 * clearcoat, which is most of the difference between "flat plastic" and
 * "wet carbon and paint".
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Wheel centres in car-local metres, matching the physics model. */
export const WHEEL_CENTRES = [
  new THREE.Vector3( 0.80, -0.22,  1.77),   // front right
  new THREE.Vector3(-0.80, -0.22,  1.77),   // front left
  new THREE.Vector3( 0.80, -0.22, -1.77),   // rear right
  new THREE.Vector3(-0.80, -0.22, -1.77),   // rear left
];

export const CAR_LENGTH = 5.53;
export const TYRE_RADIUS = 0.375;

const ASSETS = new URL('../../Codex/assets/', import.meta.url);
const DRACO_PATH = new URL('../../Codex/vendor/three/examples/jsm/libs/draco/gltf/', import.meta.url).href;

/**
 * Half-extents of the box used to claim geometry for each wheel corner.
 * Wider than the tyre so it also captures the aero furniture around it —
 * wheel covers, brake ducts and the over-tyre winglets.
 */
const WHEEL_BOX = { x: 0.40, y: 0.66, z: 0.62 };

/**
 * Radius about the wheel's spin axis inside which geometry counts as rotating.
 *
 * The tyre and rim are a solid of revolution about that axis, so everything
 * belonging to them lies within roughly the tyre radius of it. The covers,
 * ducts and winglets sit outside that envelope. Splitting on this distance
 * separates what spins from what does not, without the model needing to have
 * been authored with named parts.
 */
const SPIN_RADIUS = TYRE_RADIUS + 0.02;

/**
 * Half-width of the rotating assembly, per axle.
 *
 * A radial test alone is not enough, which is what the first attempt got wrong.
 * Wheel covers and brake ducts lie flat against the rim face, so they are
 * WITHIN the tyre radius and a radial test happily calls them part of the
 * wheel. What distinguishes them is that they sit outboard of the tyre's
 * width: measured, the rotating group spanned 0.60 m across when a tyre is
 * only about 0.38 m wide. Real front and rear tyres differ (305 mm vs 405 mm),
 * so the limit is per-axle.
 */
const SPIN_HALF_WIDTH = { front: 0.175, rear: 0.225 };


/**
 * Convert quantized attributes to plain float32.
 *
 * rb19.glb ships KHR_mesh_quantization, so its positions arrive as NORMALIZED
 * INTEGERS — the real value is the stored integer scaled by the type's range,
 * and the node transform denormalizes it. Calling geometry.applyMatrix4() on
 * such an attribute writes float results straight back into the integer buffer,
 * which silently destroys the mesh: the car came out 2 m long instead of 5.53,
 * and the wheel-extraction boxes then matched nothing, so it lost all four
 * wheels. Reading through getX/getY/getZ honours the normalization, so we
 * rebuild each attribute as float32 before any transform touches it.
 */
function dequantize(geometry) {
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const needsConversion = attribute.normalized || !(attribute.array instanceof Float32Array);
    if (!needsConversion || attribute.itemSize > 4) continue;
    const size = attribute.itemSize;
    const values = new Float32Array(attribute.count * size);
    for (let i = 0; i < attribute.count; i++) {
      const o = i * size;
      values[o] = attribute.getX(i);
      if (size > 1) values[o + 1] = attribute.getY(i);
      if (size > 2) values[o + 2] = attribute.getZ(i);
      if (size > 3) values[o + 3] = attribute.getW(i);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, size));
  }
  return geometry;
}

/**
 * Rebuild a geometry from a subset of its triangles, compacting the vertex
 * arrays so each wheel does not carry a copy of the whole car's attributes.
 */
function extractTriangles(source, triangleIndices) {
  const lookup = new Map();
  const order = [];
  const remapped = [];
  for (const originalIndex of triangleIndices) {
    let mapped = lookup.get(originalIndex);
    if (mapped === undefined) {
      mapped = order.length;
      lookup.set(originalIndex, mapped);
      order.push(originalIndex);
    }
    remapped.push(mapped);
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (attribute.itemSize > 4) continue;
    const values = new Float32Array(order.length * attribute.itemSize);
    for (let i = 0; i < order.length; i++) {
      const from = order[i];
      const to = i * attribute.itemSize;
      values[to] = attribute.getX(from);
      if (attribute.itemSize > 1) values[to + 1] = attribute.getY(from);
      if (attribute.itemSize > 2) values[to + 2] = attribute.getZ(from);
      if (attribute.itemSize > 3) values[to + 3] = attribute.getW(from);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  geometry.setIndex(remapped);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Promote the baked GLTF material to MeshPhysicalMaterial.
 *
 * The source ships roughness 0.95 / metalness 0.46 as flat factors over a
 * single baked texture, which is why the car reads matte and dead in Codex's
 * build. There is no roughness map to separate paint from carbon from rubber,
 * so we synthesise one from the base colour: saturated, bright pixels are
 * painted bodywork and become smooth; dark desaturated pixels are carbon and
 * tyre and stay rough. Combined with a real clearcoat lobe that is enough to
 * read as a modern F1 car under an HDR sky.
 */
function upgradeMaterial(material, renderer, quality) {
  // metalness must stay LOW. The supplied texture is a baked albedo that
  // already contains its lighting, and a metal has no diffuse response — so
  // dialling metalness up does not make the car look metallic, it makes it go
  // black, which is exactly what it did at 0.35. The gloss comes from the
  // clearcoat lobe instead, which is what a real clearcoated paint is anyway.
  const upgraded = new THREE.MeshPhysicalMaterial({
    map: material.map ?? null,
    normalMap: material.normalMap ?? null,
    color: 0xffffff,
    metalness: 0.06,
    roughness: 0.45,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
    sheen: 0,
  });
  upgraded.name = 'RB19_Body';

  // Deliberately no derived roughness map. It was built by drawing the GLB's
  // WebP onto a canvas, which races against texture decode — when it lost, the
  // readback was blank and the whole car rendered wrong. That was the
  // intermittent breakage. A fixed roughness with clearcoat is always correct.
  if (material.map) {
    material.map.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    material.map.needsUpdate = true;
  }
  return upgraded;
}

/** Build a roughness map from a base-colour texture by saturation/luminance. */
function deriveRoughnessMap(sourceTexture) {
  const image = sourceTexture.image;
  const width = image.width, height = image.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  const size = Math.min(1024, width);              // a rough map does not need 4K
  canvas.width = size;
  canvas.height = Math.round(size * (height / width));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;                                    // tainted or undecoded image
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  // If the source had not decoded, the readback is uniformly blank. Using it
  // would flatten the whole car, so fall back to the plain material instead.
  let nonBlank = 0;
  for (let i = 3; i < data.length; i += 4000) if (data[i] > 0 && data[i - 1] > 0) nonBlank++;
  if (nonBlank < 4) return null;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max <= 0 ? 0 : (max - min) / max;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Painted panels: saturated or bright -> smooth. Carbon and rubber: dark
    // and grey -> rough. Clamped so nothing becomes a perfect mirror.
    const gloss = Math.min(1, saturation * 1.35 + luminance * 0.55);
    const roughness = Math.round(255 * Math.max(0.12, Math.min(0.92, 0.92 - gloss * 0.7)));
    data[i] = data[i + 1] = data[i + 2] = roughness;
    data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = sourceTexture.wrapS;
  texture.wrapT = sourceTexture.wrapT;
  texture.flipY = sourceTexture.flipY;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Recolour a livery by hue-rotating only the saturated pixels of the baked
 * texture. Tyres, carbon and the driver are near-greyscale and are left alone,
 * so AI cars read as different teams without a second asset.
 */
export function makeLiveryTexture(sourceTexture, hueShift, saturationBoost = 1) {
  const image = sourceTexture.image;
  if (!image?.width) return sourceTexture;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(2048, image.width);
  canvas.height = Math.round(canvas.width * (image.height / image.width));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } catch {
    return sourceTexture;
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max <= 0 ? 0 : (max - min) / max;
    if (saturation < 0.22) continue;               // carbon, rubber, glass — leave it
    const [h, s, l] = rgbToHsl(r, g, b);
    const [nr, ng, nb] = hslToRgb((h + hueShift) % 1, Math.min(1, s * saturationBoost), l);
    data[i] = nr * 255; data[i + 1] = ng * 255; data[i + 2] = nb * 255;
  }
  context.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = sourceTexture.flipY;
  texture.needsUpdate = true;
  return texture;
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/**
 * Load the RB19 and split it into a chassis plus four steerable, spinning
 * wheel groups.
 *
 * @param quality 'standard' (1.8 MB, 157k tris) or 'ultra' (22 MB, 675k tris)
 * @returns { root, wheels, material, sync, dispose }
 */
export async function loadCar(renderer, { quality = 'standard', onProgress } = {}) {
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  const file = quality === 'ultra' ? 'rb19-ultra.glb' : 'rb19.glb';

  let gltf;
  try {
    gltf = await loader.loadAsync(new URL(file, ASSETS).href, event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
  } finally {
    draco.dispose();
  }

  // De-quantize every mesh before anything measures or transforms it.
  gltf.scene.traverse(object => { if (object.isMesh && object.geometry) dequantize(object.geometry); });
  gltf.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const size = bounds.getSize(new THREE.Vector3());
  if (size.z <= 0) throw new Error('RB19 model has no measurable length');

  // Normalise to the physics model's dimensions and put the origin at the
  // centre of mass rather than the mesh's own arbitrary pivot.
  const scale = CAR_LENGTH / size.z;
  const origin = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    bounds.min.y + TYRE_RADIUS / scale,
    bounds.min.z + size.z * 0.44765);

  const root = new THREE.Group();
  root.name = 'RB19';
  const chassis = new THREE.Group();
  root.add(chassis);

  const wheels = WHEEL_CENTRES.map((centre, i) => {
    const steer = new THREE.Group();          // yaw: front wheels only
    const spin = new THREE.Group();           // pitch: rolling tyre and rim
    const fairing = new THREE.Group();        // steers with the wheel, never spins
    steer.position.copy(centre);
    steer.add(spin, fairing);
    chassis.add(steer);
    return { steer, spin, fairing, index: i, centre };
  });

  let sharedMaterial = null;

  gltf.scene.traverse(object => {
    if (!object.isMesh || !object.geometry?.attributes.position) return;

    const geometry = dequantize(object.geometry.clone());
    geometry.applyMatrix4(object.matrixWorld);
    geometry.translate(-origin.x, -origin.y, -origin.z);
    geometry.scale(scale, scale, scale);
    geometry.translate(0, -0.22, 0);

    const position = geometry.attributes.position;
    const index = geometry.index?.array
      ?? Uint32Array.from({ length: position.count }, (_, i) => i);

    // Bucket 0 is the chassis, 1..4 the rotating wheels, 5..8 the aero
    // furniture at each corner: it steers with the wheel but never spins.
    const buckets = [[], [], [], [], [], [], [], [], []];
    for (let t = 0; t + 2 < index.length; t += 3) {
      const tri = [index[t], index[t + 1], index[t + 2]];
      let bucket = 0;
      for (let w = 0; w < 4; w++) {
        const c = WHEEL_CENTRES[w];
        const inside = tri.every(id =>
          Math.abs(position.getX(id) - c.x) < WHEEL_BOX.x &&
          Math.abs(position.getY(id) - c.y) < WHEEL_BOX.y &&
          Math.abs(position.getZ(id) - c.z) < WHEEL_BOX.z);
        if (!inside) continue;
        // Both measured from the hub and averaged over the triangle, so a
        // face straddling a boundary is assigned whole rather than torn.
        let radial = 0, axial = 0;
        for (const id of tri) {
          const dy = position.getY(id) - c.y;
          const dz = position.getZ(id) - c.z;
          radial += Math.hypot(dy, dz);
          axial += Math.abs(position.getX(id) - c.x);
        }
        radial /= 3;
        axial /= 3;
        const halfWidth = w < 2 ? SPIN_HALF_WIDTH.front : SPIN_HALF_WIDTH.rear;
        bucket = (radial <= SPIN_RADIUS && axial <= halfWidth) ? w + 1 : w + 5;
        break;
      }
      buckets[bucket].push(...tri);
    }

    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    sharedMaterial ??= upgradeMaterial(source, renderer, quality === 'ultra' ? 'high' : 'mid');

    buckets.forEach((triangles, bucket) => {
      if (!triangles.length) return;
      const part = extractTriangles(geometry, triangles);
      const wheelIndex = bucket === 0 ? -1 : (bucket <= 4 ? bucket - 1 : bucket - 5);
      if (wheelIndex >= 0) {
        // Re-origin on the hub so the group rotates about the axle.
        const c = WHEEL_CENTRES[wheelIndex];
        part.translate(-c.x, -c.y, -c.z);
      }
      const mesh = new THREE.Mesh(part, sharedMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // the car is always relevant
      const parent = wheelIndex < 0 ? chassis
        : bucket <= 4 ? wheels[wheelIndex].spin     // tyre and rim: spins
        : wheels[wheelIndex].fairing;               // covers/winglets: steers only
      parent.add(mesh);
    });

    geometry.dispose();
  });

  // Release the loader's copy; ours is rebuilt.
  gltf.scene.traverse(object => object.geometry?.dispose());

  // Sanity-check the result instead of silently shipping a broken car.
  const measured = new THREE.Box3().setFromObject(root);
  const measuredSize = measured.getSize(new THREE.Vector3());
  const emptyWheels = wheels.filter(w => w.spin.children.length === 0).length;
  // If the split is right the rotating group is about a tyre wide. Report it,
  // because a silently over-wide group means aero is being spun again.
  for (const wheel of wheels) {
    const extent = new THREE.Box3();
    wheel.spin.children.forEach(o => extent.expandByObject(o));
    if (extent.isEmpty()) continue;
    const size = extent.getSize(new THREE.Vector3());
    console.info(`Wheel ${wheel.index}: rotating group ${size.x.toFixed(2)} m wide, ` +
      `${wheel.fairing.children.length} fairing mesh(es)`);
    if (size.x > 0.52) {
      console.warn(`Wheel ${wheel.index} rotating group is too wide — aero may still be spinning.`);
    }
  }
  if (Math.abs(measuredSize.z - CAR_LENGTH) > 0.6 || emptyWheels > 0) {
    console.warn(`RB19 assembly looks wrong: length ${measuredSize.z.toFixed(2)} m ` +
      `(expected ${CAR_LENGTH}), ${emptyWheels} wheel group(s) empty.`);
  }

  /**
   * Push one physics frame into the visual model.
   * @param state the vehicle state object from sim/vehicle.js
   */
  function sync(state) {
    root.position.set(state.position.x, state.position.y, state.position.z);
    root.quaternion.set(state.quaternion.x, state.quaternion.y,
                        state.quaternion.z, state.quaternion.w);
    for (let i = 0; i < 4; i++) {
      const wheel = wheels[i];
      const data = state.wheels?.[i];
      if (!data) continue;
      // Suspension travel moves the hub up and down in car space.
      wheel.steer.position.y = wheel.centre.y + (data.suspensionOffset ?? 0);
      // Negated: physics measures steer about the car's true right (-X),
      // while a Y rotation in model space turns the opposite way. Applied
      // directly with no extra smoothing — the shaping already happened in the
      // sim, and damping it twice is what makes wheels look slow to react.
      wheel.steer.rotation.y = -(data.steerAngle ?? 0);
      wheel.spin.rotation.x = data.spinAngle ?? 0;
    }
  }

  function dispose() {
    root.traverse(object => {
      object.geometry?.dispose();
    });
    sharedMaterial?.map?.dispose();
    sharedMaterial?.roughnessMap?.dispose();
    sharedMaterial?.dispose();
  }

  return { root, chassis, wheels, material: sharedMaterial, sync, dispose };
}
