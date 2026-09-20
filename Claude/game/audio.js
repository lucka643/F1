/**
 * audio.js — an F1 car synthesised entirely in Web Audio. No samples.
 *
 * The engine is built from the harmonic series of a V6 firing at 3 cylinders
 * per revolution. Running a bank of oscillators at rpm-derived frequencies and
 * mixing them by harmonic weight produces the characteristic hard, hollow wail
 * — and, crucially, it tracks rpm continuously with no sample-rate artefacts or
 * loop points.
 *
 * Codex's build uses one sawtooth oscillator, which sounds like a wasp.
 *
 * Graph:
 *   [engine bank] -> engineGain -> engineFilter -----\
 *   [turbo]       -> turboGain  -> turboFilter ------+-> busGain -> compressor -> out
 *   [tyre noise]  -> tyreFilter -> tyreGain ---------/
 *   [wind noise]  -> windFilter -> windGain --------/
 */

const HARMONICS = [
  // [multiple of firing frequency, relative amplitude, detune cents]
  [0.5,  0.22,  0],     // half-order — the lumpy undertone of a V6
  [1.0,  1.00,  0],     // firing frequency
  [1.5,  0.30,  6],
  [2.0,  0.62, -5],
  [3.0,  0.40,  8],
  [4.0,  0.26, -7],
  [6.0,  0.16,  4],
  [8.0,  0.09, -3],
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A reusable buffer of white noise for tyre and wind beds. */
function makeNoiseBuffer(context, seconds = 2) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let value = 0;
  for (let i = 0; i < length; i++) {
    // Slightly pink rather than pure white: less harsh, closer to real rolling
    // and wind noise.
    value = (value + (Math.random() * 2 - 1) * 0.35) * 0.94;
    data[i] = clamp(value, -1, 1);
  }
  return buffer;
}

export function createAudio(options = {}) {
  let context = null;
  let started = false;
  let enabled = options.enabled !== false;
  let master = clamp(options.volume ?? 0.7, 0, 1);
  let engineLevel = clamp(options.engineVolume ?? 0.8, 0, 1);
  let effectsLevel = clamp(options.effectsVolume ?? 0.7, 0, 1);

  let nodes = null;
  let lastGear = 1;
  let shiftEnvelope = 0;
  let backfireTimer = 0;

  function build() {
    if (nodes) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    context = new Context();

    const out = context.createGain();
    out.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 22;
    compressor.ratio.value = 7;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;
    out.connect(compressor).connect(context.destination);

    /* ---- engine bank ---- */
    const engineGain = context.createGain();
    engineGain.gain.value = 0;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 2400;
    engineFilter.Q.value = 0.9;
    // A resonant peak gives the exhaust its "pipe" character.
    const resonance = context.createBiquadFilter();
    resonance.type = 'peaking';
    resonance.frequency.value = 1150;
    resonance.Q.value = 3.2;
    resonance.gain.value = 7;
    engineGain.connect(engineFilter).connect(resonance).connect(out);

    const oscillators = HARMONICS.map(([multiple, amplitude, detune]) => {
      const oscillator = context.createOscillator();
      // Sawtooth for the low orders (rich, buzzy), square higher up (hollow).
      oscillator.type = multiple >= 3 ? 'square' : 'sawtooth';
      oscillator.detune.value = detune;
      const gain = context.createGain();
      gain.gain.value = amplitude;
      oscillator.connect(gain).connect(engineGain);
      oscillator.start();
      return { oscillator, gain, multiple, amplitude };
    });

    /* ---- turbo ---- */
    const turbo = context.createOscillator();
    turbo.type = 'sine';
    turbo.frequency.value = 3000;
    const turboGain = context.createGain();
    turboGain.gain.value = 0;
    const turboFilter = context.createBiquadFilter();
    turboFilter.type = 'bandpass';
    turboFilter.frequency.value = 5200;
    turboFilter.Q.value = 7;
    turbo.connect(turboGain).connect(turboFilter).connect(out);
    turbo.start();

    /* ---- noise beds ---- */
    const noiseBuffer = makeNoiseBuffer(context);

    const tyreSource = context.createBufferSource();
    tyreSource.buffer = noiseBuffer;
    tyreSource.loop = true;
    const tyreFilter = context.createBiquadFilter();
    tyreFilter.type = 'bandpass';
    tyreFilter.frequency.value = 1600;
    tyreFilter.Q.value = 1.1;
    const tyreGain = context.createGain();
    tyreGain.gain.value = 0;
    tyreSource.connect(tyreFilter).connect(tyreGain).connect(out);
    tyreSource.start();

    const windSource = context.createBufferSource();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 900;
    const windGain = context.createGain();
    windGain.gain.value = 0;
    windSource.connect(windFilter).connect(windGain).connect(out);
    windSource.start();

    const rumbleSource = context.createBufferSource();
    rumbleSource.buffer = noiseBuffer;
    rumbleSource.loop = true;
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 220;
    const rumbleGain = context.createGain();
    rumbleGain.gain.value = 0;
    rumbleSource.connect(rumbleFilter).connect(rumbleGain).connect(out);
    rumbleSource.start();

    nodes = {
      out, compressor, oscillators, engineGain, engineFilter, resonance,
      turbo, turboGain, turboFilter,
      tyreGain, tyreFilter, windGain, windFilter, rumbleGain,
    };
  }

  function start() {
    if (!enabled) return;
    build();
    if (!context) return;
    started = true;
    if (context.state === 'suspended') context.resume().catch(() => {});
  }

  function stop() {
    started = false;
    if (nodes) nodes.out.gain.setTargetAtTime(0, context.currentTime, 0.08);
  }

  /**
   * @param state  the player's vehicle state
   */
  function update(dt, state, rivals, camera) {
    if (!nodes || !context || !started || !enabled || !state) return;
    const now = context.currentTime;
    const smooth = 0.03;

    const rpm = state.rpm ?? 4000;
    const throttle = state.throttle ?? 0;
    const speed = Math.abs(state.speed ?? 0);

    // A V6 fires 3 times per crank revolution.
    const firing = (rpm / 60) * 3;

    for (const voice of nodes.oscillators) {
      voice.oscillator.frequency.setTargetAtTime(
        clamp(firing * voice.multiple, 20, 18000), now, smooth);
    }

    // Off-throttle the upper harmonics drop away and the engine goes hollow;
    // on-throttle they come back and it hardens up.
    const load = 0.32 + throttle * 0.68;
    for (const voice of nodes.oscillators) {
      const weight = voice.multiple >= 2 ? load : 0.55 + throttle * 0.45;
      voice.gain.gain.setTargetAtTime(voice.amplitude * weight, now, 0.05);
    }

    // Gear change: a brief torque cut, heard as a dip and a crackle.
    const gear = state.gear ?? 1;
    if (gear !== lastGear) { shiftEnvelope = 1; lastGear = gear; }
    shiftEnvelope = Math.max(0, shiftEnvelope - dt * 9);

    const revFraction = clamp(rpm / (state.revLimit ?? 15000), 0, 1);
    let engineVolume = (0.055 + throttle * 0.13 + revFraction * 0.06) * engineLevel;
    engineVolume *= 1 - shiftEnvelope * 0.75;
    nodes.engineGain.gain.setTargetAtTime(engineVolume, now, 0.02);

    nodes.engineFilter.frequency.setTargetAtTime(
      900 + throttle * 3400 + revFraction * 3200, now, 0.04);
    nodes.resonance.frequency.setTargetAtTime(700 + revFraction * 1400, now, 0.06);

    // Overrun crackle: closed throttle at high rpm pops irregularly.
    backfireTimer -= dt;
    if (throttle < 0.08 && revFraction > 0.55 && backfireTimer <= 0) {
      backfireTimer = 0.04 + Math.random() * 0.13;
      nodes.engineGain.gain.setTargetAtTime(engineVolume * 2.4, now, 0.004);
      nodes.engineGain.gain.setTargetAtTime(engineVolume, now + 0.02, 0.03);
    }

    // Turbo: spools with load and rpm, whistles, then blows off on a lift.
    const spool = clamp(throttle * revFraction, 0, 1);
    nodes.turbo.frequency.setTargetAtTime(2600 + spool * 4200, now, 0.1);
    nodes.turboGain.gain.setTargetAtTime(spool * 0.028 * effectsLevel, now, 0.08);
    nodes.turboFilter.frequency.setTargetAtTime(4200 + spool * 3600, now, 0.1);

    // Tyres: scrub from slip, plus a surface-dependent rumble.
    let slip = 0;
    let kerb = 0;
    for (const wheel of state.wheels ?? []) {
      slip = Math.max(slip, wheel.skidding ?? 0);
      if (wheel.contact && wheel.surface === 'kerb') kerb = 1;
      else if (wheel.contact && (wheel.surface === 'grass' || wheel.surface === 'runoff')) kerb = Math.max(kerb, 0.55);
    }
    const scrub = clamp(slip, 0, 1) * clamp(speed / 12, 0, 1);
    nodes.tyreGain.gain.setTargetAtTime(scrub * 0.10 * effectsLevel, now, 0.04);
    nodes.tyreFilter.frequency.setTargetAtTime(900 + scrub * 2600, now, 0.05);
    nodes.rumbleGain.gain.setTargetAtTime(kerb * clamp(speed / 30, 0, 1) * 0.16 * effectsLevel, now, 0.03);

    // Wind, and the sense of speed it carries.
    const windAmount = clamp(speed / 95, 0, 1);
    nodes.windGain.gain.setTargetAtTime(windAmount * windAmount * 0.075 * effectsLevel, now, 0.12);
    nodes.windFilter.frequency.setTargetAtTime(400 + windAmount * 2200, now, 0.15);

    nodes.out.gain.setTargetAtTime(master, now, 0.08);
  }

  return {
    start,
    stop,
    update,
    setEnabled(value) {
      enabled = value;
      if (!value) stop(); else if (started) start();
    },
    setVolume(value) { master = clamp(value, 0, 1); },
    setEngineVolume(value) { engineLevel = clamp(value, 0, 1); },
    setEffectsVolume(value) { effectsLevel = clamp(value, 0, 1); },
    get running() { return started; },
    dispose() {
      if (!context) return;
      try { context.close(); } catch { /* already closed */ }
      context = null;
      nodes = null;
      started = false;
    },
  };
}
