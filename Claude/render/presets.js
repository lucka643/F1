/**
 * presets.js — the quality ladder. Data only, no logic.
 *
 * Five tiers. The top one, APEX, is the headline: it renders at 65% resolution
 * and reconstructs a full-resolution image from a jittered, motion-compensated
 * history buffer. That is what DLSS actually does — sub-pixel jitter, temporal
 * accumulation, neighbourhood clamping, temporal upsampling — minus the learned
 * reconstruction network, which we compensate for with a tighter render scale,
 * a Blackman-Harris resolve filter and a mandatory post-resolve sharpen.
 *
 * Nothing here is hardware ray tracing; browsers have none. Reflections are
 * screen-space with a real-time cube probe filling in what the screen cannot
 * see. Genuine path tracing is available, but only in parked Photo Mode.
 */

export const PRESETS = {
  PHONE: {
    label: 'Phone',
    blurb: 'Runs anywhere. Forward rendering, no post-processing.',
    cost: 'Very low',
    renderScale: 0.70, maxPixelRatio: 1.0, upsample: 'bilinear',
    gbuffer: false, hdrTarget: false,
    aa: 'none',
    shadows: { mode: 'single', size: 1024, cascades: 1, distance: 90, type: 'PCF' },
    contactShadow: null,
    ao: null,
    ssr: null,
    envProbe: null,
    bloom: null,
    godrays: null, volumetricFog: false,
    dof: null, motionBlur: null, lensflare: false,
    grade: { toneMapping: 'Neutral', exposure: 1.0, vignette: 0, grain: 0, ca: 0, sharpen: 0 },
    road: { detailNormals: 0, wetness: 'flat', aniso: 2 },
    car: 'standard',
    scenery: { trees: 120, drawDistance: 350 },
  },

  PERFORMANCE: {
    label: 'Performance',
    blurb: 'Locked 60 fps on integrated graphics. Cascaded shadows and ambient occlusion.',
    cost: 'Low',
    renderScale: 0.85, maxPixelRatio: 1.25, upsample: 'bilinear',
    gbuffer: true, hdrTarget: true,
    aa: 'fxaa',
    shadows: { mode: 'csm', size: 1024, cascades: 2, distance: 180, type: 'PCF' },
    contactShadow: null,
    ao: { samples: 8, radius: 0.5, denoise: false, blend: 0.45 },
    ssr: null,
    envProbe: { size: 64, refreshHz: 0.5 },
    bloom: { strength: 0.14, radius: 0.30, threshold: 1.05 },
    godrays: null, volumetricFog: false,
    dof: null, motionBlur: null, lensflare: false,
    grade: { toneMapping: 'AgX', exposure: 1.0, vignette: 0.15, grain: 0, ca: 0, sharpen: 0 },
    road: { detailNormals: 1, wetness: 'roughness', aniso: 4 },
    car: 'standard',
    scenery: { trees: 400, drawDistance: 600 },
  },

  BALANCED: {
    label: 'Balanced',
    blurb: 'The default. Temporal anti-aliasing, three-cascade shadows, screen-space reflections.',
    cost: 'Medium',
    renderScale: 1.0, maxPixelRatio: 1.5, upsample: 'taa',
    gbuffer: true, hdrTarget: true,
    aa: 'taa',
    taa: { jitterLength: 8, feedbackMin: 0.85, feedbackMax: 0.94, varianceGamma: 1.0 },
    shadows: { mode: 'csm', size: 2048, cascades: 3, distance: 400, type: 'PCFSoft', fade: true },
    contactShadow: { steps: 8, maxDistance: 0.35, thickness: 0.05 },
    ao: { samples: 16, radius: 0.8, denoise: true, pdSamples: 8, blend: 0.6 },
    ssr: { scale: 0.5, steps: 24, maxDistance: 60, thickness: 0.25, roughnessCut: 0.35, temporal: true },
    envProbe: { size: 128, refreshHz: 2 },
    bloom: { strength: 0.18, radius: 0.40, threshold: 1.0 },
    godrays: null, volumetricFog: 'analytic',
    dof: null,
    motionBlur: { samples: 6, strength: 0.6 },
    lensflare: false,
    grade: { toneMapping: 'AgX', exposure: 1.05, vignette: 0.18, grain: 0.008, ca: 0.0008, sharpen: 0.55 },
    road: { detailNormals: 2, wetness: 'full', aniso: 8 },
    car: 'standard',
    scenery: { trees: 900, drawDistance: 900 },
  },

  CINEMATIC: {
    label: 'Cinematic',
    blurb: 'Full effect stack at native resolution. Volumetric light, depth of field, motion blur.',
    cost: 'High',
    renderScale: 1.0, maxPixelRatio: 1.75, upsample: 'taa',
    gbuffer: true, hdrTarget: true,
    aa: 'taa',
    taa: { jitterLength: 16, feedbackMin: 0.90, feedbackMax: 0.975, varianceGamma: 1.0 },
    shadows: { mode: 'csm', size: 2048, cascades: 4, distance: 900, type: 'PCFSoft', fade: true },
    contactShadow: { steps: 14, maxDistance: 0.6, thickness: 0.045 },
    ao: { samples: 24, radius: 1.1, denoise: true, pdSamples: 16, blend: 0.7 },
    ssr: { scale: 0.75, steps: 40, maxDistance: 110, thickness: 0.18, roughnessCut: 0.5, temporal: true },
    envProbe: { size: 256, refreshHz: 4, boxProject: true },
    bloom: { strength: 0.20, radius: 0.45, threshold: 0.95 },
    godrays: { scale: 0.25, steps: 40 }, volumetricFog: 'raymarch-quarter',
    dof: { speedDriven: true, maxBlur: 0.012 },
    motionBlur: { samples: 10, strength: 0.85 },
    lensflare: true,
    grade: { toneMapping: 'AgX', exposure: 1.05, vignette: 0.20, grain: 0.010, ca: 0.0012, sharpen: 0.6 },
    road: { detailNormals: 2, wetness: 'full', aniso: 16 },
    car: 'ultra',
    scenery: { trees: 1600, drawDistance: 1400 },
  },

  // ───────────────────────── THE HEADLINE TIER ─────────────────────────
  APEX: {
    label: 'APEX',
    blurb: 'Temporal super-resolution. Renders below native and reconstructs from sixteen '
         + 'frames of motion-compensated history. Screen-space reflections '
         + 'with a box-projected probe fallback, four-cascade contact-hardened shadows, '
         + 'volumetric light and an AgX filmic grade.',
    honesty: 'APEX is not ray tracing — browsers do not have it. It does what DLSS actually does: '
           + 'render at a lower resolution, jitter the camera a sub-pixel amount every frame, and '
           + 'reconstruct a full-resolution image from motion-compensated history. Reflections are '
           + 'screen-space, with a real-time cube probe filling in what the screen cannot see. '
           + 'For genuine ray tracing, park the car and open Photo Mode.',
    cost: 'Very high',
    renderScale: 0.82,            // renders LOW, resolves HIGH — the DLSS trick
    outputScale: 1.0,
    maxPixelRatio: 2.0,
    upsample: 'taau',             // temporal upsampling, not bilinear
    gbuffer: true, hdrTarget: true,
    aa: 'taau',
    taa: {
      jitterLength: 16,
      feedbackMin: 0.86, feedbackMax: 0.95,
      varianceGamma: 1.0,
      historyRejectDepth: 0.02,
      lumaWeighting: true,
      resolveFilter: 'blackman-harris', resolveRadius: 1.5,
    },
    shadows: {
      mode: 'csm', size: 2048, cascades: 4, distance: 1200,
      type: 'PCFSoft', fade: true, splits: [0.018, 0.055, 0.19, 1.0],
    },
    contactShadow: { steps: 16, maxDistance: 0.8, thickness: 0.04 },
    ao: { samples: 32, radius: 1.2, denoise: true, pdSamples: 16, pdRings: 2, blend: 0.75, temporal: true },
    ssr: { scale: 1.0, steps: 64, maxDistance: 160, thickness: 0.14, roughnessCut: 0.65, temporal: true, probeFallback: true },
    envProbe: { size: 256, refreshHz: 8, boxProject: true },
    bloom: { strength: 0.22, radius: 0.50, threshold: 0.9 },
    godrays: { scale: 0.5, steps: 60 },
    volumetricFog: 'raymarch-half',
    dof: { speedDriven: true, maxBlur: 0.016 },
    motionBlur: { samples: 16, strength: 1.0 },
    lensflare: true,
    // sharpen is NOT optional at this tier — without it the 0.65 render reads
    // softer than CINEMATIC and the whole reconstruction argument falls over.
    grade: { toneMapping: 'AgX', exposure: 1.05, vignette: 0.20, grain: 0.010, ca: 0.0012, sharpen: 0.75 },
    road: { detailNormals: 2, wetness: 'full', aniso: 16, puddles: true },
    car: 'ultra',
    scenery: { trees: 2400, drawDistance: 2000 },
  },
};

export const TIER_ORDER = ['PHONE', 'PERFORMANCE', 'BALANCED', 'CINEMATIC', 'APEX'];

/** Default tier for a device we know nothing about yet. */
export function suggestPreset() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = navigator.deviceMemory ?? 4;
  if (coarse) return cores >= 6 ? 'PERFORMANCE' : 'PHONE';
  if (cores >= 10 && memory >= 8) return 'CINEMATIC';
  if (cores >= 6) return 'BALANCED';
  return 'PERFORMANCE';
}
