/**
 * hud.js — the broadcast overlay.
 *
 * Every field is cached and only written when its value actually changes.
 * Touching the DOM is the single easiest way to lose frames in a game that is
 * already spending its budget on the renderer, and the speed readout alone
 * would otherwise cause a layout pass 60 times a second.
 */

const $ = id => document.getElementById(id);

/** 0:00.000, or an em dash when there is no time yet. */
export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** +0.123 / -0.456, signed, for deltas. */
export function formatDelta(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

/** A gap to another car, which is usually small but can become a full lap. */
export function formatGap(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  return seconds >= 60 ? `+${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
                       : `+${seconds.toFixed(3)}`;
}

export function createHUD(circuit, options = {}) {
  const root = $('hud');
  const el = {
    lapNow: $('lap-now'), lapTotal: $('lap-total'),
    timeCurrent: $('time-current'), timeBest: $('time-best'),
    sectors: [...document.querySelectorAll('[data-sector]')],
    delta: $('delta-bar'), deltaValue: $('delta-value'),
    positionBlock: $('position-block'), posNow: $('pos-now'), posTotal: $('pos-total'),
    gapAhead: $('gap-ahead'), gapBehind: $('gap-behind'),
    speed: $('speed'), gear: $('gear'), rpm: $('rpm'),
    throttle: $('bar-throttle'), brake: $('bar-brake'),
    drs: $('drs'), ers: $('ers'), tc: $('tc'),
    shiftLights: $('shift-lights'), flags: $('flags'),
    notice: $('notice'), fps: $('fps'), minimap: $('minimap'),
  };

  // 15 shift lights: green, green, green, green, green, yellow x5, red x5 —
  // the standard F1 steering-wheel arrangement.
  el.shiftLights.replaceChildren(...Array.from({ length: 15 }, (_, i) => {
    const light = document.createElement('i');
    light.className = i < 5 ? 'g' : i < 10 ? 'y' : 'r';
    return light;
  }));
  const lights = [...el.shiftLights.children];

  const cache = {};
  const write = (node, value, prop = 'textContent') => {
    const key = node.id + prop;
    if (cache[key] === value) return;
    cache[key] = value;
    node[prop] = value;
  };
  const toggleClass = (node, name, on) => {
    const key = `${node.id}:${name}`;
    if (cache[key] === on) return;
    cache[key] = on;
    node.classList.toggle(name, on);
  };

  /* ---------------------------------------------------------- minimap */

  const map = el.minimap.getContext('2d');
  const bounds = circuit.centreline.reduce((b, s) => ({
    minX: Math.min(b.minX, s.x), maxX: Math.max(b.maxX, s.x),
    minZ: Math.min(b.minZ, s.z), maxZ: Math.max(b.maxZ, s.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

  const PAD = 14;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const scale = Math.min(
    (el.minimap.width - PAD * 2) / spanX,
    (el.minimap.height - PAD * 2) / spanZ);
  const offsetX = (el.minimap.width - spanX * scale) / 2;
  const offsetZ = (el.minimap.height - spanZ * scale) / 2;
  const toMap = (x, z) => [
    offsetX + (x - bounds.minX) * scale,
    offsetZ + (z - bounds.minZ) * scale,
  ];

  // The circuit outline never changes, so bake it once into an offscreen
  // canvas and blit it each frame instead of re-stroking 649 segments.
  const baked = document.createElement('canvas');
  baked.width = el.minimap.width;
  baked.height = el.minimap.height;
  {
    const ctx = baked.getContext('2d');
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    circuit.centreline.forEach((s, i) => {
      const [x, y] = toMap(s.x, s.z);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Start/finish tick, drawn across the track at lap distance 0.
    const s0 = circuit.centreline[0];
    const [sx, sy] = toMap(s0.x, s0.z);
    ctx.beginPath();
    ctx.moveTo(sx - s0.nx * 6, sy - s0.nz * 6);
    ctx.lineTo(sx + s0.nx * 6, sy + s0.nz * 6);
    ctx.strokeStyle = '#ff2d55';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawMinimap(playerDistance, rivals) {
    map.clearRect(0, 0, el.minimap.width, el.minimap.height);
    map.drawImage(baked, 0, 0);
    for (const rival of rivals ?? []) {
      const p = circuit.lineAt(rival.lapDistance);
      const [x, y] = toMap(p.x, p.z);
      map.beginPath();
      map.arc(x, y, 3, 0, Math.PI * 2);
      map.fillStyle = rival.colour ?? '#8b96a8';
      map.fill();
    }
    const me = circuit.lineAt(playerDistance);
    const [x, y] = toMap(me.x, me.z);
    map.beginPath();
    map.arc(x, y, 4.5, 0, Math.PI * 2);
    map.fillStyle = '#ffffff';
    map.fill();
    map.lineWidth = 2;
    map.strokeStyle = '#ff2d55';
    map.stroke();
  }

  /* ----------------------------------------------------------- notice */

  let noticeTimer = null;
  function notice(text, duration = 4000) {
    el.notice.textContent = text;
    el.notice.style.opacity = '1';
    clearTimeout(noticeTimer);
    if (duration > 0) {
      noticeTimer = setTimeout(() => { el.notice.style.opacity = '0'; }, duration);
    }
  }

  /* ------------------------------------------------------------ flags */

  let activeFlags = '';
  function setFlags(flags) {
    const key = flags.join(',');
    if (key === activeFlags) return;
    activeFlags = key;
    el.flags.replaceChildren(...flags.map(flag => {
      const node = document.createElement('div');
      node.className = `flag ${flag.kind}`;
      node.textContent = flag.text;
      return node;
    }));
  }

  /* ----------------------------------------------------------- update */

  const SECTOR_CLASSES = ['purple', 'green', 'yellow'];

  function update(frame) {
    const { vehicle, timing, race, minimapRivals, showFPS, stats } = frame;

    // Car cluster.
    write(el.speed, String(Math.round(Math.abs(vehicle.speedKmh))));
    write(el.gear, vehicle.gear < 0 ? 'R' : vehicle.gear === 0 ? 'N' : String(vehicle.gear));
    const revs = Math.max(0, Math.min(1, vehicle.rpm / options.revLimit));
    write(el.rpm, `${(revs * 100).toFixed(1)}%`, 'style.width');
    el.rpm.style.width = `${revs * 100}%`;
    el.throttle.style.width = `${vehicle.throttle * 100}%`;
    el.brake.style.width = `${vehicle.brake * 100}%`;

    // Shift lights: the last 22% of the rev range, then a full-white flash at
    // the limiter — the cue a real driver actually shifts on.
    const shiftBand = Math.max(0, (revs - 0.78) / 0.22);
    const lit = Math.round(shiftBand * lights.length);
    for (let i = 0; i < lights.length; i++) {
      lights[i].classList.toggle('on', i < lit);
    }
    toggleClass(el.shiftLights, 'flash', revs > 0.985);

    toggleClass(el.drs, 'on', vehicle.drsOpen);
    toggleClass(el.ers, 'on', vehicle.ersDeploying);
    toggleClass(el.tc, 'on', !!frame.tcActive);

    // Timing.
    if (timing) {
      write(el.lapNow, String(timing.lap));
      write(el.lapTotal, race?.totalLaps ? String(race.totalLaps) : '∞');
      write(el.timeCurrent, formatLapTime(timing.currentLapTime));
      write(el.timeBest, formatLapTime(timing.bestLap));
      timing.sectorState.forEach((state, i) => {
        const node = el.sectors[i];
        for (const cls of SECTOR_CLASSES) toggleClass(node, cls, state === cls);
      });
      const hasDelta = Number.isFinite(timing.delta) && timing.bestLap > 0;
      el.delta.hidden = !hasDelta;
      if (hasDelta) {
        write(el.deltaValue, formatDelta(timing.delta));
        toggleClass(el.delta, 'ahead', timing.delta < 0);
        toggleClass(el.delta, 'behind', timing.delta >= 0);
      }
    }

    // Race position.
    if (race?.classification?.length) {
      el.positionBlock.hidden = false;
      write(el.posNow, String(race.position));
      write(el.posTotal, String(race.classification.length));
      write(el.gapAhead, race.gapAhead === null ? '— leader' : `▲ ${formatGap(race.gapAhead)}`);
      write(el.gapBehind, race.gapBehind === null ? '—' : `▼ ${formatGap(race.gapBehind)}`);
    } else {
      el.positionBlock.hidden = true;
    }

    setFlags(frame.flags ?? []);
    drawMinimap(vehicle.lapDistance ?? 0, minimapRivals);

    el.fps.hidden = !showFPS;
    if (showFPS && stats) {
      write(el.fps, stats);
    }
  }

  return {
    show() { root.hidden = false; },
    hide() { root.hidden = true; },
    update,
    notice,
    setTouchVisible(on) { $('touch-controls').hidden = !on; },
  };
}
