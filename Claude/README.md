# APEX

A browser F1 racing game on the *Highway Battle* circuit, built with the same
RB19 model and the same road mesh as the `Codex/` build in this repository.

**[Play it](https://lucka643.github.io/F1/Claude/)** — no install, no build step.

---

## What is different from the Codex build

The Codex build is free driving on a highway. This is a race.

### The road mesh is actually a circuit

The supplied asset is 669 triangles of DS-era geometry. Three things are wrong
with it for racing, and all three are fixed at load time in
[`circuit/roadmesh.js`](./circuit/roadmesh.js):

| | Source | After |
|---|---|---|
| Topology | 12 disjoint components (vertices 0.02–0.06 m apart, unwelded) | 2 continuous rings, then 1 surface |
| Carriageways | two 5.0 m ribbons split by a 0.7 m median | stitched into one ~10.1 m racing surface |
| Lap data | none | 3.87 km centreline, racing line, speed profile, sectors |

The median is the important one. Codex's `track.js` walls every boundary edge
that has road on only one side — which puts a barrier **down the middle of the
highway** and leaves you driving a 5 m lane. Bridging that seam with 308
triangles gives a corridor the width of a real F1 circuit, from the identical
source asset.

The original road geometry is preserved. Kerbs, barriers, run-off, markings and
scenery are built on top of it from the extracted centreline.

### Graphics: five tiers, topping out at APEX

The top preset renders at **65% resolution and reconstructs a full-resolution
image** from sixteen frames of motion-compensated history — sub-pixel Halton
jitter, velocity-buffer reprojection, YCoCg neighbourhood variance clipping and
a sharpening resolve. That is the technique DLSS uses, minus the learned
reconstruction network.

On top of that: screen-space reflections with a cube-probe fallback,
four-cascade shadow maps with screen-space contact shadows, GTAO, volumetric
light shafts, AgX tone mapping, speed-driven depth of field and per-object
motion blur.

It is **not ray tracing** — no browser exposes it. Genuine path tracing is
available in Photo Mode, parked. The settings screen says so in those words;
see [CREDITS.md](./CREDITS.md) for the full scope statement.

Every tier below APEX is a real degradation, not a token one. PHONE is plain
forward rendering with no post-processing at all.

### Handling

Codex uses Rapier's built-in raycast vehicle controller, which exposes a single
isotropic friction value per wheel. A single number cannot express a tyre.

This build uses a custom raycast-suspension model on a plain rigid body with a
simplified Pacejka magic formula for lateral and longitudinal force, load
sensitivity, a friction ellipse for combined slip, anti-roll bars, aero balance
that shifts with speed, a working DRS, an 8-speed gearbox and ERS.

Because a keyboard key is a digital on/off switch and a tyre model is not,
there is an input-shaping layer between them: throttle and brake ramps, and a
steering rate limit that tightens with speed and slip angle. It is transparent
on a gamepad with analogue triggers.

### There is a game

Free Practice, Time Trial with a ghost, and Quick Race against AI opponents on
a grid start. Lap and sector timing with purple/green/yellow deltas, a live
delta bar, personal bests, track-limits invalidation and a results screen.

---

## Running it locally

No build step. Serve the **repository root** (not this folder — the assets are
referenced at `../Codex/`):

```sh
python3 -m http.server 8765
# then open http://localhost:8765/Claude/
```

A `file://` URL will not work: ES modules and `fetch` both require http.

Requires a browser with WebGL2, WebAssembly, ES modules and
`DecompressionStream` — Chrome, Edge, Firefox and Safari 16.4+.

---

## Layout

```
Claude/
  index.html          shell, importmap, all UI markup
  style.css           broadcast-style UI
  main.js             boot, state machine, fixed-step frame loop
  circuit/
    roadmesh.js       weld, stitch, centreline extraction      (verified in Node)
    racingline.js     corridor queries, racing line, speed profile
    build.js          three.js geometry, colliders, track dressing
  sim/
    vehicle.js        raycast suspension, Pacejka tyres, aero, powertrain
  render/
    presets.js        the five quality tiers
    pipeline.js       G-buffer, TAA/TAAU, SSR, shadows, post
    shaders.js        GLSL sources
    car.js            RB19 loading, wheel splitting, material upgrade
    camera.js         camera rigs
  game/
    input.js          keyboard / gamepad / touch
    timing.js         laps, sectors, deltas, personal bests
    ai.js             opponents
    audio.js          Web Audio engine synth
  ui/
    hud.js            the overlay
    settings.js       settings model, persistence, settings screen
```

The circuit geometry pipeline is verified numerically: 3865 m lap, 10.1 m median
corridor width, 100% of the solved racing line on tarmac, `surfaceAt()` at
1.5 µs per query, whole circuit built in 44 ms.

---

## Credits

Assets are CC BY 4.0 (RB19, road mesh) and CC0 (Poly Haven surfaces and sky).
Full attribution and a list of every modification is in [CREDITS.md](./CREDITS.md).

Not an official Formula 1, Red Bull, Oracle or Need for Speed product.
