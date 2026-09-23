/**
 * timing.js — lap, sector and mini-sector timing for a closed circuit.
 *
 * Everything here is driven by ONE number per frame: the player's lap distance
 * in metres, as produced by `circuit.locate(x, z).distance`. That is deliberate.
 * A racing game's timing is the one system that must never be wrong, and the
 * only way to guarantee that is to make it a 1-D problem — no trigger volumes,
 * no plane tests against a moving transform, no "did the collider tunnel through
 * the finish line at 330 km/h" class of bug.
 *
 * The crossing test is therefore: how far did we move along the lap since the
 * last frame (`circuit.gapAlong(prev, now)`, which wraps correctly), and which
 * timing lines lie inside that span. Because the span is signed, driving
 * backwards is detected by exactly the same code, and because the crossing
 * fraction within the frame is known, every split is interpolated to sub-frame
 * accuracy instead of being quantised to the frame rate. At 92 m/s and 60 fps a
 * frame is 1.5 m — that is 16 ms of error if you do not interpolate, which is
 * more than the gap between a good lap and a great one.
 *
 * Deviations from the design spec, and why:
 *
 *  - The spec stores the delta trace as one float per circuit node (967 of
 *    them). Nodes here are ~5.9 m apart and not exactly uniform, so this module
 *    uses its own fixed-metre bins instead (5 m by default). Same memory, same
 *    cost, but the lookup is a divide rather than a search, and the resolution
 *    no longer depends on how the circuit happened to be sampled.
 *
 *  - The spec's `results` is described as "a sortable classification". Returning
 *    an Array with extra properties bolted onto it is a trap (JSON.stringify
 *    drops them, `map` drops them, a later `sort` silently reorders what a HUD
 *    is iterating). `results` is an object with a `ranking` array — which is the
 *    sortable classification — plus the session summary alongside it.
 */

const SECTOR_COUNT = 3;
const STORAGE_VERSION = 'v1';
const STORAGE_PREFIX = `claude-f1.records.${STORAGE_VERSION}`;

/** Broadcast timing palette. Exported so the HUD does not re-invent it. */
export const TIMING_COLOURS = Object.freeze({
  purple: '#b14eff',
  green: '#00e676',
  yellow: '#ffd84a',
  invalid: '#ff4d4d',
  pending: '#6b7280',
});

/**
 * Per-mode rules. `outLap` means the clock does not start until the first
 * crossing of the start/finish line — a time trial must not time the roll-out
 * from the pits, but a standing-start race must time from the green.
 */
const MODE_RULES = {
  practice: { outLap: true, trackLimits: 'warn', lapLimit: 0 },
  timeTrial: { outLap: true, trackLimits: 'invalidate', lapLimit: 0 },
  qualifying: { outLap: true, trackLimits: 'invalidate', lapLimit: 0 },
  race: { outLap: false, trackLimits: 'warn', lapLimit: 0 },
  hotlap: { outLap: false, trackLimits: 'invalidate', lapLimit: 1 },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod = (v, m) => ((v % m) + m) % m;

/** `1:02.418`. Returns an em-dash placeholder for null so the HUD never prints "NaN". */
export function formatLapTime(seconds, placeholder = '—:——.———') {
  if (!Number.isFinite(seconds) || seconds < 0) return placeholder;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`;
}

/** `13.601` for a sector — minutes are noise at sector length. */
export function formatSectorTime(seconds, placeholder = '——.———') {
  if (!Number.isFinite(seconds) || seconds < 0) return placeholder;
  return seconds >= 60 ? formatLapTime(seconds) : seconds.toFixed(3);
}

/** `+0.284` / `−0.284`, always signed, always three decimals. */
export function formatDelta(seconds, placeholder = '—.———') {
  if (!Number.isFinite(seconds)) return placeholder;
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

/**
 * purple = best anyone has done this session, green = your own best, yellow =
 * anything else. Exactly the F1 broadcast rule, and the reason it works is that
 * the two thresholds are independent: your personal best can be green on a lap
 * where someone else already holds the purple.
 */
export function colourFor(time, personalBest, sessionBest) {
  if (!Number.isFinite(time)) return null;
  // No session best yet means this IS the session best — the opening lap of a
  // session is purple in every sector, which is what broadcast graphics show.
  if (!Number.isFinite(sessionBest) || time <= sessionBest + 1e-9) return 'purple';
  if (!Number.isFinite(personalBest) || time <= personalBest + 1e-9) return 'green';
  return 'yellow';
}

/**
 * localStorage with a working in-memory fallback. Probed once: Safari private
 * browsing and embedded webviews throw on `setItem`, not on access, so the only
 * reliable detection is to actually write something.
 */
const storage = (() => {
  try {
    const probe = '__claude_f1_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    };
  }
})();

function readRecord(key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** A finished (or in-progress) lap. Plain data — it goes straight into results. */
function makeLap(index, startTime, binCount) {
  return {
    index,
    startTime,
    time: null,
    sectors: new Array(SECTOR_COUNT).fill(null),
    sectorColours: new Array(SECTOR_COUNT).fill(null),
    miniSectors: [],
    valid: true,
    invalidReason: null,
    colour: null,
    /** trace[b] = seconds from the S/F crossing to reaching bin b. -1 = not yet reached. */
    trace: new Float32Array(binCount).fill(-1),
    maxSpeed: 0,
    date: 0,
  };
}

/**
 * @param {object} circuit  a `Circuit` from circuit/racingline.js — needs
 *                          `lapLength` and `gapAlong(a, b)`.
 * @param {object} [options]
 * @param {string} [options.mode='timeTrial']
 * @param {string} [options.circuitId='tri-city']  storage key component
 * @param {number} [options.startFinish=0]  lap distance of the S/F line, metres
 * @param {number[]} [options.sectorStarts]  lap distance of each sector start
 * @param {number} [options.miniSectors=20]
 * @param {number} [options.traceBinMetres=5]
 * @param {number} [options.offTrackGrace=0.35]  seconds off-track before a lap dies
 * @param {number} [options.lapLimit=0]  0 = unlimited
 * @param {boolean} [options.autoSave=true]
 */
export function createTiming(circuit, options = {}) {
  const lapLength = Number(circuit?.lapLength) || 1;
  const gapAlong = typeof circuit?.gapAlong === 'function'
    ? (a, b) => circuit.gapAlong(a, b)
    // Fallback so timing still works against a bare {lapLength} stub.
    : (a, b) => {
      let d = (b - a) % lapLength;
      if (d > lapLength / 2) d -= lapLength;
      if (d < -lapLength / 2) d += lapLength;
      return d;
    };

  const config = {
    mode: options.mode ?? 'timeTrial',
    circuitId: options.circuitId ?? 'circuit',
    startFinish: Number.isFinite(options.startFinish) ? options.startFinish : 0,
    miniSectorCount: Math.max(SECTOR_COUNT, Math.round(options.miniSectors ?? 20)),
    binMetres: Math.max(1, options.traceBinMetres ?? 5),
    offTrackGrace: options.offTrackGrace ?? 0.35,
    offTrackReset: options.offTrackReset ?? 0.25,
    autoSave: options.autoSave !== false,
    lapLimit: Math.max(0, Math.round(options.lapLimit ?? 0)),
    trackLimits: options.trackLimits ?? null,
    outLap: options.outLap ?? null,
    keepLaps: Math.max(1, Math.round(options.keepLaps ?? 64)),
    deltaSmoothing: options.deltaSmoothing ?? 6,
    /** Movement in one frame beyond this is a teleport, not driving. */
    teleportMetres: options.teleportMetres ?? 30,
    onEvent: typeof options.onEvent === 'function' ? options.onEvent : null,
  };

  const sectorStarts = Array.isArray(options.sectorStarts) && options.sectorStarts.length === SECTOR_COUNT
    ? options.sectorStarts.map((s) => mod(s - config.startFinish, lapLength)).sort((a, b) => a - b)
    : [0, lapLength / 3, (lapLength * 2) / 3];
  sectorStarts[0] = 0;

  // Timing lines expressed as lap progress (0 = S/F, lapLength = S/F again).
  const sectorLines = sectorStarts.slice(1);          // ends of sectors 1 and 2
  const binCount = Math.max(16, Math.round(lapLength / config.binMetres));
  const binSize = lapLength / binCount;
  const miniSectorSize = lapLength / config.miniSectorCount;

  const listeners = new Map();

  /* ------------------------------------------------------------- session */

  let rules = { ...MODE_RULES[config.mode] ?? MODE_RULES.timeTrial };
  let clock = 0;                 // seconds of session time, accumulated from dt
  let started = false;           // have we seen a first lapDistance yet
  let armed = false;             // is a lap actually being timed
  let prevDistance = 0;
  let lapProgress = 0;           // metres since the last S/F crossing
  let offTrackTime = 0;
  let reseeded = false;             // a teleport re-seed is pending a clean lap start
  let lapTravel = 0;                // metres actually driven forward since this lap began
  let onTrackTime = 0;
  let sessionDistance = 0;
  let deltaShown = 0;

  let current = null;            // the lap in progress
  let previousStart = 0;         // so a reverse over the line can be undone
  let previousLap = null;
  const laps = [];

  /** Personal bests, seeded from storage and updated as the session runs. */
  let personal = {
    lap: null,
    sectors: new Array(SECTOR_COUNT).fill(null),
    miniSectors: new Array(config.miniSectorCount).fill(null),
    trace: null,
  };

  /**
   * Session bests drive the purple. In a solo session they track the player; in
   * a race, `notifySessionBest()` lets the field push an AI's time in here so
   * the player's sector goes green rather than purple when someone is faster.
   */
  let session = {
    lap: null,
    lapDriver: null,
    sectors: new Array(SECTOR_COUNT).fill(null),
    sectorDrivers: new Array(SECTOR_COUNT).fill(null),
  };

  const state = {
    mode: config.mode,
    lap: 0,                      // lap currently being driven, 1-based; 0 = out lap
    lapCount: 0,                 // completed laps
    currentLapTime: 0,
    lastLap: null,
    bestLap: null,
    sectors: new Array(SECTOR_COUNT).fill(null),
    bestSectors: new Array(SECTOR_COUNT).fill(null),
    sectorState: new Array(SECTOR_COUNT).fill(null),
    miniSectors: new Array(config.miniSectorCount).fill(null),
    miniSectorState: new Array(config.miniSectorCount).fill(null),
    delta: null,                 // raw live delta to the best lap, seconds
    deltaShown: null,            // smoothed, for the delta bar only
    valid: true,
    invalidReason: null,
    finished: false,
    // Extras the HUD wants and nothing else has to recompute:
    currentSector: 0,
    lapProgress: 0,              // 0..1 around the lap
    lapDistance: 0,
    sessionTime: 0,
    sessionDistance: 0,
    sessionBestLap: null,
    theoreticalBest: null,
    lapsRemaining: 0,
    trackLimitsRule: 'invalidate',
    onTrack: true,
    offTrackTime: 0,
    armed: false,
    lastRecord: null,            // 'lap' | 'sector1' … set for one lap after a PB
  };

  /* -------------------------------------------------------------- events */

  function emit(type, payload) {
    const bucket = listeners.get(type);
    if (bucket) for (const fn of bucket) { try { fn(payload); } catch (error) { console.warn(`timing: ${type} listener threw`, error); } }
    if (config.onEvent) { try { config.onEvent(type, payload); } catch (error) { console.warn('timing: onEvent threw', error); } }
  }

  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    let bucket = listeners.get(type);
    if (!bucket) listeners.set(type, bucket = new Set());
    bucket.add(fn);
    return () => bucket.delete(fn);
  }

  /* ------------------------------------------------------------- storage */

  const storageKey = () => `${STORAGE_PREFIX}:${config.circuitId}:${config.mode}`;

  function loadBest() {
    const record = readRecord(storageKey());
    if (!record) return null;
    const sectors = Array.isArray(record.bestSectors) ? record.bestSectors : [];
    personal.lap = Number.isFinite(record.bestLap) ? record.bestLap : null;
    personal.sectors = new Array(SECTOR_COUNT).fill(null)
      .map((_, i) => (Number.isFinite(sectors[i]) ? sectors[i] : null));
    personal.miniSectors = new Array(config.miniSectorCount).fill(null)
      .map((_, i) => (Number.isFinite(record.bestMiniSectors?.[i]) ? record.bestMiniSectors[i] : null));
    // The delta trace is stored as a plain array of seconds; -1 marks a bin the
    // recorded lap never reached (only possible if the trace came from a
    // different bin size, which the length check below rejects anyway).
    if (Array.isArray(record.trace) && record.trace.length === binCount) {
      personal.trace = Float32Array.from(record.trace);
    } else {
      personal.trace = null;
    }
    state.bestLap = personal.lap;
    state.bestSectors = personal.sectors.slice();
    state.theoreticalBest = theoretical();
    emit('bestLoaded', { record, personal });
    return record;
  }

  function saveBest() {
    if (!Number.isFinite(personal.lap) && !personal.sectors.some(Number.isFinite)) return null;
    const record = {
      version: 1,
      circuit: config.circuitId,
      mode: config.mode,
      lapLength,
      bins: binCount,
      bestLap: personal.lap,
      bestSectors: personal.sectors.slice(),
      bestMiniSectors: personal.miniSectors.slice(),
      theoretical: theoretical(),
      trace: personal.trace ? Array.from(personal.trace, (v) => Math.round(v * 1000) / 1000) : null,
      laps: rankedLaps().slice(0, 5).map((lap) => ({
        time: lap.time, sectors: lap.sectors.slice(), date: lap.date,
      })),
      updated: Date.now(),
    };
    const ok = writeRecord(storageKey(), record);
    emit('bestSaved', { record, stored: ok });
    return record;
  }

  /* --------------------------------------------------------- delta trace */

  const binOf = (progress) => clamp(Math.floor(progress / binSize), 0, binCount - 1);

  /**
   * Write "time at which we reached this bin" for every bin the car passed this
   * frame. Filling the whole span rather than just the current bin is what keeps
   * the trace usable at low frame rates — at 20 fps a car at 92 m/s covers 4.6 m
   * and would otherwise leave holes in a 5 m grid.
   */
  function fillTrace(lap, fromProgress, toProgress, fromTime, toTime) {
    if (!lap || toProgress <= fromProgress) return;
    const first = Math.ceil(fromProgress / binSize);
    const last = Math.min(binCount - 1, Math.floor(toProgress / binSize));
    const span = toProgress - fromProgress;
    for (let b = Math.max(0, first); b <= last; b++) {
      const f = (b * binSize - fromProgress) / span;
      lap.trace[b] = fromTime + (toTime - fromTime) * f;
    }
  }

  /** Linear read-back of a trace at an arbitrary lap progress. */
  function traceAt(trace, progress) {
    if (!trace) return null;
    const p = clamp(progress / binSize, 0, binCount - 1);
    const i = Math.floor(p);
    const a = trace[i];
    if (!(a >= 0)) return null;
    const j = Math.min(binCount - 1, i + 1);
    const b = trace[j];
    if (!(b >= 0) || j === i) return a;
    return a + (b - a) * (p - i);
  }

  /* ------------------------------------------------------- lap lifecycle */

  function theoretical() {
    if (!personal.sectors.every(Number.isFinite)) return null;
    return personal.sectors.reduce((a, b) => a + b, 0);
  }

  function rankedLaps() {
    return laps.filter((lap) => lap.valid && Number.isFinite(lap.time))
      .sort((a, b) => a.time - b.time);
  }

  function beginLap(atTime) {
    lapTravel = 0;
    previousStart = current ? current.startTime : atTime;
    previousLap = current;
    current = makeLap(state.lapCount + 1, atTime, binCount);
    // Bin 0 is the start/finish line itself, reached at t = 0 by definition.
    // Seeding it keeps the delta readable from the first metre of the lap.
    current.trace[0] = 0;
    state.lap = current.index;
    state.sectors = new Array(SECTOR_COUNT).fill(null);
    state.sectorState = new Array(SECTOR_COUNT).fill(null);
    state.miniSectors = new Array(config.miniSectorCount).fill(null);
    state.miniSectorState = new Array(config.miniSectorCount).fill(null);
    state.valid = true;
    state.invalidReason = null;
    state.currentSector = 0;
    state.currentLapTime = 0;
    offTrackTime = 0;
    emit('lapStart', { lap: current.index, time: atTime });
  }

  function invalidate(reason) {
    if (!current || !current.valid) return;
    if (rules.trackLimits === 'off' && (reason === 'offtrack' || reason === 'cut')) return;
    if (rules.trackLimits === 'warn' && (reason === 'offtrack' || reason === 'cut')) {
      emit('trackLimitsWarning', { lap: current.index, reason });
      return;
    }
    current.valid = false;
    current.invalidReason = reason;
    state.valid = false;
    state.invalidReason = reason;
    emit('invalidated', { lap: current.index, reason });
  }

  /** Force-invalidate regardless of the track-limits rule (used by respawn). */
  function invalidateHard(reason) {
    if (!current || !current.valid) return;
    current.valid = false;
    current.invalidReason = reason;
    state.valid = false;
    state.invalidReason = reason;
    emit('invalidated', { lap: current.index, reason });
  }

  function completeSector(sectorIndex, atTime) {
    if (!current) return;
    const startOfSector = sectorIndex === 0
      ? current.startTime
      : current.startTime + (current.sectors.slice(0, sectorIndex).reduce((a, b) => a + (b ?? 0), 0));
    const time = atTime - startOfSector;
    if (!(time > 0)) return;
    current.sectors[sectorIndex] = time;
    state.sectors[sectorIndex] = time;

    const colour = current.valid
      ? colourFor(time, personal.sectors[sectorIndex], session.sectors[sectorIndex])
      : 'invalid';
    current.sectorColours[sectorIndex] = colour;
    state.sectorState[sectorIndex] = colour;
    state.currentSector = Math.min(SECTOR_COUNT - 1, sectorIndex + 1);

    if (current.valid) {
      if (!Number.isFinite(session.sectors[sectorIndex]) || time < session.sectors[sectorIndex]) {
        session.sectors[sectorIndex] = time;
        session.sectorDrivers[sectorIndex] = 'player';
      }
      if (!Number.isFinite(personal.sectors[sectorIndex]) || time < personal.sectors[sectorIndex]) {
        personal.sectors[sectorIndex] = time;
        state.bestSectors[sectorIndex] = time;
        state.theoreticalBest = theoretical();
        state.lastRecord = `sector${sectorIndex + 1}`;
        emit('record', { kind: 'sector', sector: sectorIndex, time });
      }
    }
    emit('sector', { lap: current.index, sector: sectorIndex, time, colour, valid: current.valid });
  }

  function completeMiniSector(index, atTime) {
    if (!current) return;
    const elapsed = atTime - current.startTime;
    current.miniSectors[index] = elapsed;
    state.miniSectors[index] = elapsed;
    const best = personal.miniSectors[index];
    const colour = current.valid ? (!Number.isFinite(best) || elapsed <= best ? 'green' : 'yellow') : 'invalid';
    state.miniSectorState[index] = colour;
    if (current.valid && (!Number.isFinite(best) || elapsed < best)) personal.miniSectors[index] = elapsed;
  }

  function completeLap(atTime) {
    if (!current) return;
    // Sector 3 closes on the same crossing that closes the lap.
    completeSector(SECTOR_COUNT - 1, atTime);
    const time = atTime - current.startTime;
    current.time = time;
    current.date = Date.now();
    current.trace[binCount - 1] = time;

    let colour = 'invalid';
    if (current.valid) {
      colour = colourFor(time, personal.lap, session.lap);
      if (!Number.isFinite(session.lap) || time < session.lap) {
        session.lap = time;
        session.lapDriver = 'player';
      }
      if (!Number.isFinite(personal.lap) || time < personal.lap) {
        personal.lap = time;
        // The delta reference is always the fastest lap, so it moves with the PB.
        personal.trace = current.trace.slice();
        state.bestLap = time;
        state.lastRecord = 'lap';
        emit('record', { kind: 'lap', time, lap: current.index });
        if (config.autoSave) saveBest();
      } else if (config.autoSave && state.lastRecord) {
        saveBest();
      }
    }
    current.colour = colour;

    if (reseeded || lapTravel < lapLength * 0.5) {
      // Not a lap: either the tail of one interrupted by a re-seed, or a
      // crossing reached without driving most of the circuit — which is what
      // happened off a standing start, when rolling back over the line (or a
      // stale position read at the green) wrapped the counter to "almost a
      // lap" and the first forward crossing completed it. Start a clean lap at
      // the line instead of crediting one that was never driven.
      reseeded = false;
      beginLap(atTime);
      return;
    }

    laps.push(current);
    while (laps.length > config.keepLaps) laps.shift();

    state.lapCount += 1;
    state.lastLap = time;
    state.sessionBestLap = session.lap;
    state.theoreticalBest = theoretical();
    emit('lap', {
      lap: current.index, time, colour, valid: current.valid,
      sectors: current.sectors.slice(), record: state.lastRecord,
    });

    const finished = rules.lapLimit > 0 && state.lapCount >= rules.lapLimit;
    beginLap(atTime);
    if (finished) {
      state.finished = true;
      state.lap = state.lapCount;
      current = null;
      emit('finished', { laps: state.lapCount, best: personal.lap, results: buildResults() });
    }
  }

  /**
   * Reversing over the start/finish line un-completes the lap you just finished.
   * It is rare, but a player who spins on the line and rolls backwards must not
   * be handed a 0.4-second lap — and the same path catches an AI-free replay
   * scrubbing backwards.
   */
  function uncompleteLap() {
    if (state.lapCount > 0) {
      state.lapCount -= 1;
      const removed = laps.pop();
      if (removed) {
        state.lastLap = laps.length ? laps[laps.length - 1].time : null;
        emit('lapRemoved', { lap: removed.index, reason: 'reversed' });
      }
    }
    if (previousLap) {
      current = previousLap;
      previousLap = null;
      current.time = null;
      state.lap = current.index;
      state.sectors = current.sectors.slice();
      state.sectorState = current.sectorColours.slice();
    } else if (current) {
      current.startTime = previousStart;
    }
    invalidateHard('reversed');
  }

  /* ------------------------------------------------------------- crossing */

  /**
   * Advance the timing lines over a signed span of lap progress, and fill the
   * delta trace for every bin inside that span. Both jobs live here because
   * both need the same sub-frame crossing fractions.
   *
   * `step` is metres travelled this frame (negative = backwards).
   */
  function advanceLines(step, dt) {
    let from = lapProgress - step;
    let to = lapProgress;
    let segStart = clock - dt;               // absolute session time at `from`

    if (step > 0) {
      // `guard` only exists so a pathological dt cannot spin forever.
      for (let guard = 0; guard < 16; guard++) {
        let line = Infinity;
        let isSector = -1;
        for (let i = 0; i < sectorLines.length; i++) {
          if (sectorLines[i] > from + 1e-9 && sectorLines[i] <= to && sectorLines[i] < line) {
            line = sectorLines[i];
            isSector = i;
          }
        }
        if (lapLength > from + 1e-9 && lapLength <= to && lapLength < line) { line = lapLength; isSector = -1; }
        if (!Number.isFinite(line)) break;

        const atTime = clock - dt * (1 - (line - from) / step);
        // Close the trace right up to the line before the lap can roll over.
        if (current) fillTrace(current, from, line, segStart - current.startTime, atTime - current.startTime);

        if (isSector >= 0) {
          completeSector(isSector, atTime);
        } else {
          completeLap(atTime);                 // begins the next lap at `atTime`
          from -= lapLength;
          to -= lapLength;
          lapProgress -= lapLength;
          line -= lapLength;
        }
        from = line;
        segStart = atTime;
      }
      // Whatever is left of the frame after the last crossing.
      if (current) fillTrace(current, Math.max(0, from), Math.min(lapLength, to), segStart - current.startTime, clock - current.startTime);
    } else if (step < 0) {
      for (let i = sectorLines.length - 1; i >= 0; i--) {
        if (sectorLines[i] <= from + 1e-9 && sectorLines[i] > to) {
          // Rolling back over a sector line drops that split and kills the lap.
          if (current) {
            current.sectors[i] = null;
            current.sectorColours[i] = null;
            state.sectors[i] = null;
            state.sectorState[i] = null;
            state.currentSector = i;
          }
          invalidateHard('reversed');
        }
      }
      if (to < 0) {
        uncompleteLap();
        lapProgress += lapLength;
      }
    }
  }

  /* --------------------------------------------------------------- update */

  /**
   * @param {number} dt         seconds since the last call
   * @param {number} lapDistance  `circuit.locate(x, z).distance`
   * @param {boolean} [isOnTrack=true]
   */
  function update(dt, lapDistance, isOnTrack = true) {
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(lapDistance)) return state;

    const progressNow = mod(lapDistance - config.startFinish, lapLength);

    if (!started) {
      started = true;
      prevDistance = lapDistance;
      lapProgress = progressNow;
      if (!rules.outLap) {
        armed = true;
        // A standing start begins the lap at the line, not wherever the car is.
        lapProgress = 0;
        beginLap(clock);
      }
      state.armed = armed;
      state.lapDistance = lapDistance;
      return state;
    }

    clock += dt;
    state.sessionTime = clock;

    let step = gapAlong(prevDistance, lapDistance);
    prevDistance = lapDistance;

    // Anything faster than 120 m/s (432 km/h) in one frame is a respawn, a
    // camera cut or a stalled tab, not driving. Re-seed instead of crediting it.
    const teleport = Math.max(config.teleportMetres, 120 * dt);
    if (Math.abs(step) > teleport) {
      lapProgress = progressNow;
      // Re-seeding drops the car anywhere in the lap — including a few metres
      // before the line, where the next crossing would otherwise be credited
      // as a complete lap seconds after the start. The next crossing restarts
      // the lap instead of completing it.
      reseeded = true;
      if (armed) invalidateHard('reset');
      emit('teleport', { lapDistance, step });
      step = 0;
    } else {
      lapProgress += step;
      if (step > 0) { sessionDistance += step; lapTravel += step; }
    }
    state.sessionDistance = sessionDistance;

    // The out lap is untimed: arm on the first forward crossing of the line.
    if (!armed) {
      if (step > 0 && lapProgress >= lapLength) {
        const before = lapProgress - step;                 // still < lapLength
        const f = (lapLength - before) / step;             // fraction of this frame
        lapProgress -= lapLength;
        armed = true;
        state.armed = true;
        beginLap(clock - dt * (1 - clamp(f, 0, 1)));
      } else if (lapProgress < 0) {
        lapProgress += lapLength;
      }
      state.lapDistance = lapDistance;
      state.lapProgress = lapProgress / lapLength;
      state.onTrack = !!isOnTrack;
      return state;
    }

    if (state.finished) {
      state.lapDistance = lapDistance;
      state.lapProgress = lapProgress / lapLength;
      state.onTrack = !!isOnTrack;
      return state;
    }

    advanceLines(step, dt);

    // Mini-sectors are purely cosmetic, so they are handled after the real
    // lines and never influence validity.
    if (current && step > 0) {
      const beforeMini = Math.floor((lapProgress - step) / miniSectorSize);
      const nowMini = Math.floor(lapProgress / miniSectorSize);
      for (let m = beforeMini + 1; m <= nowMini; m++) {
        const index = ((m % config.miniSectorCount) + config.miniSectorCount) % config.miniSectorCount;
        const f = (m * miniSectorSize - (lapProgress - step)) / step;
        completeMiniSector(index, clock - dt * (1 - clamp(f, 0, 1)));
      }
    }

    /* ---- track limits ---- */
    state.onTrack = !!isOnTrack;
    if (isOnTrack) {
      onTrackTime += dt;
      offTrackTime = Math.max(0, offTrackTime - dt / Math.max(config.offTrackReset, 1e-3) * config.offTrackGrace);
    } else {
      offTrackTime += dt;
      if (offTrackTime >= config.offTrackGrace) invalidate('offtrack');
    }
    state.offTrackTime = offTrackTime;

    /* ---- live state ---- */
    if (current) {
      state.currentLapTime = clock - current.startTime;
      state.valid = current.valid;
      state.invalidReason = current.invalidReason;
      const reference = traceAt(personal.trace, lapProgress);
      state.delta = reference === null ? null : state.currentLapTime - reference;
    } else {
      state.currentLapTime = 0;
      state.delta = null;
    }

    // Smoothed only for display — the stored delta stays raw so a HUD that wants
    // the true number (or a replay that wants to re-derive it) still can.
    if (state.delta === null) {
      deltaShown = 0;
      state.deltaShown = null;
    } else {
      deltaShown += (state.delta - deltaShown) * (1 - Math.exp(-dt * config.deltaSmoothing));
      state.deltaShown = deltaShown;
    }

    state.lapDistance = lapDistance;
    state.lapProgress = lapProgress / lapLength;
    state.lapsRemaining = rules.lapLimit > 0 ? Math.max(0, rules.lapLimit - state.lapCount) : 0;
    state.sessionBestLap = session.lap;
    return state;
  }

  /* -------------------------------------------------------------- results */

  function buildResults() {
    const ranking = rankedLaps().map((lap, i) => ({
      rank: i + 1,
      lap: lap.index,
      time: lap.time,
      gap: null,
      sectors: lap.sectors.slice(),
      sectorColours: lap.sectorColours.slice(),
      colour: lap.colour,
      valid: lap.valid,
      date: lap.date,
    }));
    if (ranking.length) for (const row of ranking) row.gap = row.time - ranking[0].time;

    return {
      mode: config.mode,
      circuit: config.circuitId,
      lapLength,
      /** The sortable classification. Sorted fastest-first already. */
      ranking,
      /** Every lap in the order it was driven, invalid ones included. */
      laps: laps.map((lap) => ({
        lap: lap.index,
        time: lap.time,
        sectors: lap.sectors.slice(),
        sectorColours: lap.sectorColours.slice(),
        valid: lap.valid,
        invalidReason: lap.invalidReason,
        colour: lap.colour,
        date: lap.date,
      })),
      best: personal.lap,
      bestSectors: personal.sectors.slice(),
      theoretical: theoretical(),
      sessionBest: session.lap,
      sessionBestSectors: session.sectors.slice(),
      lapCount: state.lapCount,
      validLapCount: ranking.length,
      totalTime: clock,
      totalDistance: sessionDistance,
      onTrackTime,
      finished: state.finished,
      records: state.lastRecord ? [state.lastRecord] : [],
    };
  }

  /* ----------------------------------------------------------------- api */

  function reset(mode = config.mode, resetOptions = {}) {
    config.mode = mode;
    state.mode = mode;
    rules = { ...(MODE_RULES[mode] ?? MODE_RULES.timeTrial) };
    if (config.trackLimits) rules.trackLimits = config.trackLimits;
    if (resetOptions.trackLimits) rules.trackLimits = resetOptions.trackLimits;
    if (config.outLap !== null) rules.outLap = config.outLap;
    if (resetOptions.outLap !== undefined) rules.outLap = resetOptions.outLap;
    rules.lapLimit = Number.isFinite(resetOptions.lapLimit) ? resetOptions.lapLimit : (config.lapLimit || rules.lapLimit);

    clock = 0;
    started = false;
    armed = false;
    reseeded = false;
    lapTravel = 0;
    lapProgress = 0;
    prevDistance = 0;
    offTrackTime = 0;
    onTrackTime = 0;
    sessionDistance = 0;
    deltaShown = 0;
    current = null;
    previousLap = null;
    previousStart = 0;
    laps.length = 0;

    session = {
      lap: null,
      lapDriver: null,
      sectors: new Array(SECTOR_COUNT).fill(null),
      sectorDrivers: new Array(SECTOR_COUNT).fill(null),
    };

    Object.assign(state, {
      mode,
      lap: 0,
      lapCount: 0,
      currentLapTime: 0,
      lastLap: null,
      sectors: new Array(SECTOR_COUNT).fill(null),
      sectorState: new Array(SECTOR_COUNT).fill(null),
      miniSectors: new Array(config.miniSectorCount).fill(null),
      miniSectorState: new Array(config.miniSectorCount).fill(null),
      delta: null,
      deltaShown: null,
      valid: true,
      invalidReason: null,
      finished: false,
      currentSector: 0,
      lapProgress: 0,
      lapDistance: 0,
      sessionTime: 0,
      sessionDistance: 0,
      sessionBestLap: null,
      lapsRemaining: rules.lapLimit,
      onTrack: true,
      offTrackTime: 0,
      armed: false,
      lastRecord: null,
    });

    // Personal bests survive a reset — they are the point of the mode — but a
    // mode change has to re-read them from the right storage key.
    loadBest();
    state.theoreticalBest = theoretical();
    emit('reset', { mode, rules: { ...rules } });
    return state;
  }

  /**
   * Let a race feed another driver's time in so the player's splits colour
   * correctly. Returns true if it became the new session best.
   */
  function notifySessionBest({ lap, sectors, driver } = {}) {
    let changed = false;
    if (Number.isFinite(lap) && (!Number.isFinite(session.lap) || lap < session.lap)) {
      session.lap = lap;
      session.lapDriver = driver ?? null;
      state.sessionBestLap = lap;
      changed = true;
    }
    if (Array.isArray(sectors)) {
      for (let i = 0; i < SECTOR_COUNT; i++) {
        if (Number.isFinite(sectors[i]) && (!Number.isFinite(session.sectors[i]) || sectors[i] < session.sectors[i])) {
          session.sectors[i] = sectors[i];
          session.sectorDrivers[i] = driver ?? null;
          changed = true;
        }
      }
    }
    return changed;
  }

  loadBest();
  reset(config.mode);

  return {
    state,
    get results() { return buildResults(); },
    get rules() { return { ...rules }; },
    get laps() { return laps.slice(); },
    get personalBest() { return { lap: personal.lap, sectors: personal.sectors.slice(), theoretical: theoretical() }; },
    get sessionBest() { return { lap: session.lap, sectors: session.sectors.slice() }; },
    get bestTrace() { return personal.trace; },

    update,
    reset,
    saveBest,
    loadBest,
    notifySessionBest,
    on,

    /** Kill the current lap from outside — a wall hit, a cut, a manual reset. */
    invalidate: (reason = 'reset') => invalidateHard(reason),
    /** Wipe the stored personal bests for this circuit + mode. */
    clearBest() {
      personal = { lap: null, sectors: new Array(SECTOR_COUNT).fill(null), miniSectors: new Array(config.miniSectorCount).fill(null), trace: null };
      state.bestLap = null;
      state.bestSectors = new Array(SECTOR_COUNT).fill(null);
      state.theoreticalBest = null;
      try { storage.removeItem(storageKey()); } catch { /* nothing to do */ }
    },
    /** Race length, applied live (the flag falls at the leader's final lap). */
    setLapLimit(limit) {
      rules.lapLimit = Math.max(0, Math.round(limit || 0));
      state.lapsRemaining = rules.lapLimit > 0 ? Math.max(0, rules.lapLimit - state.lapCount) : 0;
    },
    /** Lap distance of each timing line, for a HUD that wants to draw them. */
    get sectorLines() { return [0, ...sectorLines].map((l) => mod(l + config.startFinish, lapLength)); },
    formatLapTime,
    formatSectorTime,
    formatDelta,
    colourFor,
  };
}

export default createTiming;
