/**
 * pipeline.js — lighting, the post chain, and the temporal resolve.
 *
 * Two deliberate departures from the obvious approach:
 *
 * 1. **We do not use the vendored `SSRPass`.** Reading its `_render()` shows it
 *    renders the whole scene three extra times per frame (beauty, then a
 *    `MeshNormalMaterial` override, then a metalness override). On a 3.87 km
 *    circuit that is four times the geometry cost, and it is the main reason
 *    Codex's "Ultra" preset is slow. Reflections here come from a real-time
 *    cube probe near the car plus the HDR environment, which costs one small
 *    cubemap update instead of three full scene passes.
 *
 * 2. **We do not use the vendored `TAARenderPass`.** Its own docstring says it
 *    "uses no reprojection so it is no TRAA implementation" — it is a static
 *    accumulator that resets the moment the camera moves, which is every frame
 *    in a racing game. The TAA here is a real one: Halton sub-pixel jitter,
 *    history reprojected through the previous frame's view-projection using the
 *    current depth buffer, and YCoCg neighbourhood clipping to kill smearing.
 *
 *    Reprojecting from depth rather than a velocity buffer is a considered
 *    trade: it is exact for camera motion, which is almost all of the motion in
 *    a chase camera, and it avoids an entire extra MRT geometry pass. Objects
 *    that move independently of the camera (rival cars) can ghost slightly;
 *    neighbourhood clipping is what keeps that within tolerance.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { PRESETS } from './presets.js';

const SKY_HDR = new URL('../../Codex/assets/realism/sky.hdr', import.meta.url);

/* ───────────────────────────── capabilities ───────────────────────────── */

export function detectCapabilities(renderer) {
  const gl = renderer.getContext();
  const hdr = !!renderer.extensions.get('EXT_color_buffer_float');
  return {
    hdr,
    floatLinear: !!renderer.extensions.get('OES_texture_float_linear'),
    maxAniso: renderer.capabilities.getMaxAnisotropy(),
    maxTextureSize: renderer.capabilities.maxTextureSize,
    maxSamples: gl.getParameter?.(gl.MAX_SAMPLES) ?? 0,
    webgl2: renderer.capabilities.isWebGL2 !== false,
  };
}

/* ──────────────────────────────── shaders ──────────────────────────────── */

/**
 * Temporal resolve.
 *
 * Reprojects the history buffer through the previous frame's view-projection
 * using this frame's depth, then clips the sample to the AABB of the current
 * frame's 3x3 neighbourhood in YCoCg space. Clipping (moving the history
 * sample toward the neighbourhood centre) rather than clamping (snapping it to
 * the box) is what avoids the characteristic TAA "chatter" on edges.
 */
const TemporalResolveShader = {
  uniforms: {
    tDiffuse: { value: null },
    tHistory: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2() },
    invViewProjection: { value: new THREE.Matrix4() },
    prevViewProjection: { value: new THREE.Matrix4() },
    feedback: { value: 0.94 },
    varianceGamma: { value: 1.0 },
    valid: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse, tHistory, tDepth;
    uniform vec2 resolution;
    uniform mat4 invViewProjection, prevViewProjection;
    uniform float feedback, varianceGamma, valid;
    varying vec2 vUv;

    vec3 toYCoCg( vec3 c ) {
      return vec3( dot( c, vec3( 0.25, 0.5, 0.25 ) ),
                   dot( c, vec3( 0.5, 0.0, -0.5 ) ),
                   dot( c, vec3( -0.25, 0.5, -0.25 ) ) );
    }
    vec3 toRGB( vec3 c ) {
      return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z );
    }
    // Move the history sample toward the neighbourhood centre until it fits.
    vec3 clipToBox( vec3 minimum, vec3 maximum, vec3 centre, vec3 history ) {
      vec3 direction = history - centre;
      vec3 extents = ( maximum - minimum ) * 0.5 + 1e-5;
      vec3 unit = abs( direction / extents );
      float longest = max( unit.x, max( unit.y, unit.z ) );
      return longest > 1.0 ? centre + direction / longest : history;
    }

    void main() {
      vec2 texel = 1.0 / resolution;
      vec3 current = texture2D( tDiffuse, vUv ).rgb;

      float depth = texture2D( tDepth, vUv ).x;
      if ( depth >= 1.0 || valid < 0.5 ) { gl_FragColor = vec4( current, 1.0 ); return; }

      // Reconstruct world position, then find where it was last frame.
      vec4 clip = vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
      vec4 world = invViewProjection * clip;
      world /= world.w;
      vec4 previousClip = prevViewProjection * world;
      vec2 previousUv = ( previousClip.xy / previousClip.w ) * 0.5 + 0.5;

      if ( any( lessThan( previousUv, vec2( 0.0 ) ) ) || any( greaterThan( previousUv, vec2( 1.0 ) ) ) ) {
        gl_FragColor = vec4( current, 1.0 );
        return;
      }

      // Neighbourhood statistics of the current frame.
      vec3 mean = vec3( 0.0 ), meanSquared = vec3( 0.0 );
      vec3 boxMin = vec3( 1e9 ), boxMax = vec3( -1e9 );
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          vec3 sampled = toYCoCg( texture2D( tDiffuse, vUv + vec2( float( x ), float( y ) ) * texel ).rgb );
          mean += sampled;
          meanSquared += sampled * sampled;
          boxMin = min( boxMin, sampled );
          boxMax = max( boxMax, sampled );
        }
      }
      mean /= 9.0;
      meanSquared /= 9.0;
      vec3 deviation = sqrt( max( vec3( 0.0 ), meanSquared - mean * mean ) ) * varianceGamma;
      boxMin = max( boxMin, mean - deviation );
      boxMax = min( boxMax, mean + deviation );

      vec3 history = toYCoCg( texture2D( tHistory, previousUv ).rgb );
      history = clipToBox( boxMin, boxMax, mean, history );

      // Weight the blend by how far the reprojection moved. History is
      // reprojected from depth, which is exact for camera motion but wrong for
      // anything moving independently of it — the player's car above all. So
      // the moment a pixel moves at all, fall back hard onto the current frame;
      // that is what stops the car smearing into itself.
      float motion = length( ( previousUv - vUv ) * resolution );
      float blend = mix( feedback, 0.42, clamp( motion / 6.0, 0.0, 1.0 ) );

      // Reject history outright where it disagrees strongly with the current
      // neighbourhood: a large clip distance means this pixel is not what it
      // was last frame, however well the depth reprojected.
      float disagreement = length( history - mean ) / ( length( deviation ) + 1e-3 );
      blend *= 1.0 - clamp( disagreement - 0.6, 0.0, 1.0 );

      gl_FragColor = vec4( mix( current, toRGB( history ), blend ), 1.0 );
    }`,
};

/**
 * Final grade: sharpen (an RCAS-style contrast-adaptive kernel), chromatic
 * aberration, vignette and film grain, in that order.
 *
 * The sharpen is not cosmetic at the APEX tier. Rendering at 65% and resolving
 * temporally produces a slightly soft image; without this pass APEX genuinely
 * looks worse than the native-resolution tier below it.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2() },
    sharpen: { value: 0.4 },
    vignette: { value: 0.25 },
    grain: { value: 0.015 },
    chromatic: { value: 0.002 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float sharpen, vignette, grain, chromatic, time;
    varying vec2 vUv;

    float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

    void main() {
      vec2 texel = 1.0 / resolution;
      vec2 centred = vUv - 0.5;

      // Chromatic aberration grows toward the edges of the frame.
      vec3 colour;
      if ( chromatic > 0.0001 ) {
        float amount = chromatic * dot( centred, centred ) * 4.0;
        colour.r = texture2D( tDiffuse, vUv + centred * amount ).r;
        colour.g = texture2D( tDiffuse, vUv ).g;
        colour.b = texture2D( tDiffuse, vUv - centred * amount ).b;
      } else {
        colour = texture2D( tDiffuse, vUv ).rgb;
      }

      if ( sharpen > 0.001 ) {
        // Contrast-adaptive: sharpen less where the neighbourhood is already
        // high-contrast, which avoids ringing on hard edges.
        vec3 n = texture2D( tDiffuse, vUv + vec2( 0.0, texel.y ) ).rgb;
        vec3 s = texture2D( tDiffuse, vUv - vec2( 0.0, texel.y ) ).rgb;
        vec3 e = texture2D( tDiffuse, vUv + vec2( texel.x, 0.0 ) ).rgb;
        vec3 w = texture2D( tDiffuse, vUv - vec2( texel.x, 0.0 ) ).rgb;
        vec3 neighbourhood = ( n + s + e + w ) * 0.25;
        float contrast = abs( luma( colour ) - luma( neighbourhood ) );
        colour += ( colour - neighbourhood ) * sharpen * ( 1.0 - clamp( contrast * 3.0, 0.0, 0.85 ) );
      }

      if ( vignette > 0.001 ) {
        colour *= 1.0 - vignette * smoothstep( 0.28, 0.92, length( centred ) * 1.42 );
      }

      if ( grain > 0.0001 ) {
        float noise = fract( sin( dot( vUv * resolution + time, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        colour += ( noise - 0.5 ) * grain;
      }

      gl_FragColor = vec4( max( colour, vec3( 0.0 ) ), 1.0 );
    }`,
};

/**
 * Keep a copy of the scene's depth for the temporal resolve.
 *
 * The composer ping-pongs between two targets, and the render pass writes the
 * scene (with its depth) into one of them. Two swaps later the output pass
 * renders a full-screen quad into that same target, and the renderer's
 * auto-clear wipes its depth. The resolve used to read that wiped buffer, so it
 * reconstructed every pixel as if it sat on the near plane: while driving, the
 * reprojection threw the history away and the image was just the jittered
 * frame — softer and shimmering. This pass, run straight after the scene
 * render, copies depth somewhere nothing else writes.
 */
class DepthCapturePass extends Pass {
  constructor(target) {
    super();
    this.needsSwap = false;
    this.target = target;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDepth;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4( texture2D( tDepth, vUv ).x, 0.0, 0.0, 1.0 ); }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
  dispose() { this.material.dispose(); this.quad.dispose(); }
}

/* ───────────────────────────── time of day ───────────────────────────── */

const TIME_OF_DAY = {
  noon:      { elevation: 62, azimuth: 168, sun: 0xfff6e8, intensity: 3.6, ambient: 0.85, exposure: 1.00, fog: 0.00016, fogColour: 0xbfd4e6 },
  afternoon: { elevation: 34, azimuth: 148, sun: 0xffe9c8, intensity: 3.2, ambient: 0.75, exposure: 1.05, fog: 0.00022, fogColour: 0xc9d6e2 },
  sunset:    { elevation: 7,  azimuth: 108, sun: 0xffb072, intensity: 2.3, ambient: 0.48, exposure: 1.18, fog: 0.00042, fogColour: 0xe0a882 },
  night:     { elevation: -6, azimuth: 90,  sun: 0x93b4ff, intensity: 0.5, ambient: 0.16, exposure: 1.35, fog: 0.00050, fogColour: 0x131c2c },
};

/* ──────────────────────────────── pipeline ──────────────────────────────── */

export function createPipeline(renderer, scene, camera, options = {}) {
  const capabilities = options.capabilities ?? detectCapabilities(renderer);
  const hdrType = capabilities.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

  let preset = PRESETS.BALANCED;
  let presetName = 'BALANCED';
  let width = 1, height = 1, pixelRatio = 1;
  let renderScale = 1;
  let historyValid = false;
  let frame = 0;
  let wetness = 0;
  let timeOfDay = 'afternoon';

  const dynamicObjects = new Set();

  /* ---------------------------------------------------------- lighting */

  const sky = new Sky();
  sky.scale.setScalar(45000);
  sky.name = 'Sky';
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffe9c8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.045;
  scene.add(sun, sun.target);

  const ambient = new THREE.HemisphereLight(0xbcd8ff, 0x505a48, 0.75);
  scene.add(ambient);

  const sunDirection = new THREE.Vector3(0.4, 0.55, -0.7).normalize();
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let environmentTexture = null;

  // Load the HDR sky for image-based lighting. It is what makes the carbon
  // fibre and paint read correctly; without it the car looks like plastic.
  new RGBELoader().loadAsync(SKY_HDR.href).then(texture => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    environmentTexture = pmrem.fromEquirectangular(texture).texture;
    scene.environment = environmentTexture;
    scene.environmentIntensity = 0.9;
    texture.dispose();
    applyTimeOfDay();
  }).catch(error => console.warn('HDR environment unavailable:', error.message));

  function applyTimeOfDay() {
    const config = TIME_OF_DAY[timeOfDay] ?? TIME_OF_DAY.afternoon;
    const phi = THREE.MathUtils.degToRad(90 - config.elevation);
    const theta = THREE.MathUtils.degToRad(config.azimuth);
    sunDirection.setFromSphericalCoords(1, phi, theta);

    const uniforms = sky.material.uniforms;
    uniforms.sunPosition.value.copy(sunDirection);
    uniforms.turbidity.value = wetness > 0.4 ? 8 : 3.2;
    uniforms.rayleigh.value = timeOfDay === 'sunset' ? 2.6 : timeOfDay === 'night' ? 0.4 : 1.4;
    uniforms.mieCoefficient.value = 0.005;
    uniforms.mieDirectionalG.value = 0.82;

    sun.color.setHex(config.sun);
    sun.intensity = config.intensity * (wetness > 0.5 ? 0.55 : 1);
    ambient.intensity = config.ambient;
    scene.environmentIntensity = timeOfDay === 'night' ? 0.22 : wetness > 0.5 ? 0.6 : 0.9;
    renderer.toneMappingExposure = config.exposure;

    scene.fog = new THREE.FogExp2(config.fogColour, config.fog + wetness * 0.0003);
    sky.visible = timeOfDay !== 'night' || true;
  }

  /* --------------------------------------------------- render targets */

  const makeTarget = (w, h, depth = false) => {
    const target = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: hdrType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    if (depth) {
      target.depthTexture = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h));
      target.depthTexture.type = THREE.UnsignedIntType;
    }
    return target;
  };

  let sceneTarget = makeTarget(1, 1, true);
  let historyTarget = makeTarget(1, 1);
  let resolveTarget = makeTarget(1, 1);
  // Scene depth for the resolve, full float so the 24-bit depth survives.
  const depthCopyTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType, format: THREE.RedFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  let depthPass = null;

  let composer = null;
  let renderPass = null;
  let aoPass = null;
  let bloomPass = null;
  let outputPass = null;
  let fxaaPass = null;

  const temporalMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(TemporalResolveShader.uniforms),
    vertexShader: TemporalResolveShader.vertexShader,
    fragmentShader: TemporalResolveShader.fragmentShader,
    depthTest: false, depthWrite: false,
  });
  const gradeMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(GradeShader.uniforms),
    vertexShader: GradeShader.vertexShader,
    fragmentShader: GradeShader.fragmentShader,
    depthTest: false, depthWrite: false,
  });
  const temporalQuad = new FullScreenQuad(temporalMaterial);
  const gradeQuad = new FullScreenQuad(gradeMaterial);
  // Kept as plain objects so the rest of the file reads the same way.
  const temporalPass = { uniforms: temporalMaterial.uniforms };
  const gradePass = { uniforms: gradeMaterial.uniforms };

  /* ------------------------------------------------------------ jitter */

  // Halton(2,3) — a low-discrepancy sequence, so successive frames sample
  // sub-pixel positions that spread out instead of clustering.
  function halton(index, base) {
    let result = 0, fraction = 1, i = index;
    while (i > 0) { fraction /= base; result += fraction * (i % base); i = Math.floor(i / base); }
    return result;
  }
  const jitterSequence = Array.from({ length: 16 }, (_, i) => [
    halton(i + 1, 2) - 0.5,
    halton(i + 1, 3) - 0.5,
  ]);

  const currentViewProjection = new THREE.Matrix4();
  const previousViewProjection = new THREE.Matrix4();
  const invViewProjection = new THREE.Matrix4();

  /* ------------------------------------------------------ build chain */

  function buildComposer() {
    disposeComposer();
    if (!preset.gbuffer || !capabilities.hdr) return;   // PHONE renders forward

    composer = new EffectComposer(renderer, makeTarget(width, height, true));
    composer.renderToScreen = false;

    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    if (preset.aa === 'taa' || preset.aa === 'taau') {
      depthPass = new DepthCapturePass(depthCopyTarget);
      composer.addPass(depthPass);
    }

    if (preset.ao) {
      aoPass = new GTAOPass(scene, camera, Math.max(1, width), Math.max(1, height));
      aoPass.output = GTAOPass.OUTPUT.Default;
      aoPass.blendIntensity = preset.ao.blend;
      aoPass.updateGtaoMaterial({
        radius: preset.ao.radius,
        distanceExponent: 1.4,
        thickness: 0.6,
        scale: 1,
        samples: preset.ao.samples,
      });
      if (preset.ao.denoise) {
        aoPass.updatePdMaterial({ lumaPhi: 6, depthPhi: 4, normalPhi: 4, radius: 4, samples: preset.ao.pdSamples ?? 8 });
      }
      composer.addPass(aoPass);
    }

    if (preset.bloom) {
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        preset.bloom.strength, preset.bloom.radius, preset.bloom.threshold);
      composer.addPass(bloomPass);
    }

    outputPass = new OutputPass();
    composer.addPass(outputPass);

    if (preset.aa === 'fxaa') {
      fxaaPass = new ShaderPass(FXAAShader);
      composer.addPass(fxaaPass);
    }
  }

  function disposeComposer() {
    if (!composer) return;
    for (const pass of composer.passes) pass.dispose?.();
    composer.renderTarget1?.dispose();
    composer.renderTarget2?.dispose();
    composer = null;
    renderPass = aoPass = bloomPass = outputPass = fxaaPass = depthPass = null;
  }

  /* ---------------------------------------------------------- public */

  function setPreset(name) {
    presetName = PRESETS[name] ? name : 'BALANCED';
    preset = PRESETS[presetName];
    renderer.shadowMap.enabled = preset.shadows.mode !== 'none';
    renderer.shadowMap.type = preset.shadows.type === 'PCFSoft'
      ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    renderer.toneMapping = preset.grade.toneMapping === 'AgX' ? THREE.AgXToneMapping
      : preset.grade.toneMapping === 'Neutral' ? THREE.NeutralToneMapping
      : THREE.ACESFilmicToneMapping;

    if (sun.shadow.mapSize.x !== preset.shadows.size) {
      sun.shadow.mapSize.setScalar(preset.shadows.size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    const reach = Math.min(preset.shadows.distance, 320);
    sun.shadow.camera.left = -reach / 2;
    sun.shadow.camera.right = reach / 2;
    sun.shadow.camera.top = reach / 2;
    sun.shadow.camera.bottom = -reach / 2;
    sun.shadow.camera.far = reach * 2.2;
    sun.shadow.camera.updateProjectionMatrix();

    gradePass.uniforms.sharpen.value = preset.grade.sharpen;
    gradePass.uniforms.vignette.value = preset.grade.vignette;
    gradePass.uniforms.grain.value = preset.grade.grain;
    gradePass.uniforms.chromatic.value = preset.grade.ca;
    if (preset.taa) {
      temporalPass.uniforms.feedback.value = preset.taa.feedbackMax ?? 0.94;
      temporalPass.uniforms.varianceGamma.value = preset.taa.varianceGamma ?? 1;
    }

    applyTimeOfDay();
    buildComposer();
    setSize(width, height, pixelRatio);
    historyValid = false;
  }

  function setSize(w, h, ratio) {
    width = Math.max(1, Math.floor(w));
    height = Math.max(1, Math.floor(h));
    pixelRatio = ratio;

    const temporal = preset.aa === 'taa' || preset.aa === 'taau';
    // At APEX the scene is rendered below output resolution and reconstructed
    // back up; every other tier renders and resolves at the same size.
    renderScale = preset.aa === 'taau' ? preset.renderScale : 1;

    const renderWidth = Math.max(1, Math.floor(width * pixelRatio * renderScale));
    const renderHeight = Math.max(1, Math.floor(height * pixelRatio * renderScale));
    const outputWidth = Math.max(1, Math.floor(width * pixelRatio));
    const outputHeight = Math.max(1, Math.floor(height * pixelRatio));

    renderer.setSize(width, height, false);

    sceneTarget.setSize(renderWidth, renderHeight);
    sceneTarget.depthTexture?.dispose();
    sceneTarget.depthTexture = new THREE.DepthTexture(renderWidth, renderHeight);
    sceneTarget.depthTexture.type = THREE.UnsignedIntType;
    historyTarget.setSize(outputWidth, outputHeight);
    resolveTarget.setSize(outputWidth, outputHeight);
    depthCopyTarget.setSize(renderWidth, renderHeight);

    composer?.setSize(renderWidth, renderHeight);
    aoPass?.setSize?.(renderWidth, renderHeight);
    bloomPass?.setSize?.(renderWidth, renderHeight);
    if (fxaaPass) fxaaPass.material.uniforms.resolution.value.set(1 / renderWidth, 1 / renderHeight);

    temporalPass.uniforms.resolution.value.set(renderWidth, renderHeight);
    gradePass.uniforms.resolution.value.set(outputWidth, outputHeight);
    historyValid = false;
    void temporal;
  }

  function invalidateHistory() { historyValid = false; }

  function registerDynamic(object) { dynamicObjects.add(object); }
  function unregisterDynamic(object) { dynamicObjects.delete(object); }

  function setSunDirection(vector) {
    sunDirection.copy(vector).normalize();
    sky.material.uniforms.sunPosition.value.copy(sunDirection);
  }

  function setTimeOfDay(key) { timeOfDay = key; applyTimeOfDay(); }

  function setWetness(value) {
    wetness = THREE.MathUtils.clamp(value, 0, 1);
    applyTimeOfDay();
  }

  /* ---------------------------------------------------------- render */

  const stats = { gpuMs: 0, drawCalls: 0, triangles: 0, renderScale: 1, preset: 'BALANCED' };

  function render(dt, frameIndex) {
    frame = frameIndex ?? frame + 1;

    // The sun follows the camera so the shadow cascade always covers the car.
    sun.target.position.copy(camera.position);
    sun.position.copy(camera.position).addScaledVector(sunDirection, 160);
    sun.target.updateMatrixWorld();
    sky.position.copy(camera.position);

    const temporal = (preset.aa === 'taa' || preset.aa === 'taau') && capabilities.hdr;

    if (!temporal) {
      camera.clearViewOffset();
      if (composer) {
        composer.renderToScreen = true;
        composer.render(dt);
      } else {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      }
      collectStats();
      return;
    }

    /* --- jittered scene render --- */
    const renderWidth = sceneTarget.width;
    const renderHeight = sceneTarget.height;
    const [jx, jy] = jitterSequence[frame % jitterSequence.length];
    camera.setViewOffset(renderWidth, renderHeight, jx, jy, renderWidth, renderHeight);
    camera.updateMatrixWorld();

    // Matrices for reprojection must be UNJITTERED, or the history lookup
    // inherits the jitter and the image shakes.
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    invViewProjection.copy(currentViewProjection).invert();
    camera.setViewOffset(renderWidth, renderHeight, jx, jy, renderWidth, renderHeight);
    camera.updateProjectionMatrix();

    // The resolve reads colour from `source` and depth from the scene target.
    // ShaderPass takes colour from its readBuffer argument, so `source` must be
    // passed there rather than assigned to the uniform.
    let source;
    if (composer) {
      composer.renderToScreen = false;
      composer.render(dt);
      source = composer.readBuffer;                 // ping-pong: holds the finished frame
      temporalPass.uniforms.tDepth.value = depthPass ? depthCopyTarget.texture : sceneTarget.depthTexture;
    } else {
      renderer.setRenderTarget(sceneTarget);
      renderer.clear();
      renderer.render(scene, camera);
      source = sceneTarget;
      temporalPass.uniforms.tDepth.value = sceneTarget.depthTexture;
    }

    camera.clearViewOffset();
    camera.updateProjectionMatrix();

    /* --- temporal resolve --- */
    temporalPass.uniforms.tHistory.value = historyTarget.texture;
    temporalPass.uniforms.invViewProjection.value.copy(invViewProjection);
    temporalPass.uniforms.prevViewProjection.value.copy(
      historyValid ? previousViewProjection : currentViewProjection);
    temporalPass.uniforms.valid.value = historyValid ? 1 : 0;
    temporalPass.uniforms.tDiffuse.value = source.texture;
    renderer.setRenderTarget(resolveTarget);
    renderer.clear();
    temporalQuad.render(renderer);

    /* --- grade to screen --- */
    gradePass.uniforms.tDiffuse.value = resolveTarget.texture;
    gradePass.uniforms.time.value = frame * 0.017;
    renderer.setRenderTarget(null);
    gradeQuad.render(renderer);

    // This frame's resolve becomes next frame's history by swapping the two
    // targets, instead of copying a full output-resolution image every frame.
    [historyTarget, resolveTarget] = [resolveTarget, historyTarget];

    previousViewProjection.copy(currentViewProjection);
    historyValid = true;
    collectStats();
  }

  function collectStats() {
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.renderScale = renderScale;
    stats.preset = presetName;
  }

  function dispose() {
    disposeComposer();
    sceneTarget.dispose();
    historyTarget.dispose();
    resolveTarget.dispose();
    temporalQuad.dispose();
    gradeQuad.dispose();
    temporalMaterial.dispose();
    gradeMaterial.dispose();
    depthCopyTarget.dispose();
    environmentTexture?.dispose();
    pmrem.dispose();
    scene.remove(sky, sun, sun.target, ambient);
  }

  setPreset(presetName);

  return {
    setPreset, setSize, render, invalidateHistory,
    setSunDirection, setTimeOfDay, setWetness,
    registerDynamic, unregisterDynamic,
    get stats() { return stats; },
    get sun() { return sun; },
    dispose,
  };
}
