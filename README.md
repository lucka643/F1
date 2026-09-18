# F1 Highway Drive — 1.0

[Play the game](https://lucka643.github.io/F1/)

A static browser driving game using the supplied RB19 car and Highway Battle roadway. Open the website and press **Start driving**. GitHub Pages continues to serve **main / (root)**; no local installation or build step is needed to play.

## Driving

The two left buttons control throttle and brake; the two right buttons steer. Multiple touch buttons work together. Hold brake at a stop to reverse. The top-left button opens settings and pauses; the top-right button resets to the last safe road position.

Keyboard: **WASD / arrow keys**, **Space** brake, **R** reset, **C** camera, **Esc** settings. A standard gamepad uses its left stick and right/left triggers. Landscape orientation is recommended on phones.

While stopped, drag to orbit and pinch or scroll to zoom. The selected camera resumes when the car starts moving. Choose chase, close chase, TV pod, cockpit, nose or top-down views. Settings also provide field of view, chase distance, a speed limiter, grip, downforce, steering sensitivity and stability assistance. Preferences are saved locally.

## Graphics and conditions

| Preset | Rendering |
| --- | --- |
| Simple | Lower pixel density, basic lighting, no dynamic shadow maps. |
| Medium | Dynamic shadows and a larger weather-particle budget. |
| High | HDR pipeline, ambient occlusion, bloom, anti-aliasing and 2048px shadows. |
| Ultra | Full-resolution RB19 asset, 4096px shadows, screen-space reflections, dynamic environment reflections, ambient occlusion and maximum weather detail. |

**Ray-traced Photo Mode** is separate from real-time driving. Stop, open settings, then choose Photo Mode. It uses genuine progressive path tracing, including multiple light bounces. Let samples accumulate for a cleaner image; moving the camera restarts accumulation. Save the result with **Save photo**, or return to driving. This is not hardware-accelerated RTX while racing. HDR and Photo Mode require compatible floating-point render targets; unsuitable devices retain the standard renderer.

Clear, rain, snow and fog conditions are available with day, sunset and night lighting. Rain and snow lower tyre friction. Rain also changes road reflectivity and produces tyre spray. Surface grain, building facades and street lights are generated detail, not enlarged copies of the low-resolution source textures.

## Simulation

The 800kg dynamic chassis has four ray-cast suspension springs, rear-wheel drive, braking, aerodynamic drag, speed-dependent downforce and traction changes. Solid chassis and wheel collision shapes interact with the road and barriers. Continuous collision detection is enabled with eight substeps. The simulation runs at a fixed 120Hz and pauses in menus or when the page loses focus. Wheel rotation follows the simulated wheels, and front-wheel steering is independent.

This is an adjustable game simulation, **not a telemetry-validated model of the real RB19**. The original track's roadway is retained; surrounding scenery is rebuilt rather than a full reproduction of the source game's environment. Ultra cannot turn that source into a photogrammetric AAA track.

## Tests and troubleshooting

Test scripts and machine-readable evidence live in [`docs/tests`](./docs/tests) and [`scripts`](./scripts). The release workflow runs actual Rapier simulation regressions, then Chromium WebGL browser tests and screenshots. Tests cover boot, asset loading, driving, wheel rotation, braking/reverse, steering, gravity/landing, wall impacts, weather-dependent friction, downforce, settings, cameras, stationary orbit, quality modes, Photo Mode and responsive touch layouts.

Browser automation uses a Linux Chromium software GPU. It checks rendering and input correctness; it does not establish iPhone Safari compatibility or a real-device frame-rate guarantee. Physical-device testing remains distinct. No test suite proves that software has no possible errors.

If a GPU runs slowly, choose Medium or Simple. If its graphics context is lost, the game displays a reload prompt. Read-only diagnostics are available through `window.__F1.health()`; deterministic simulation controls are present only at the explicit `?qa` URL.

## Hosting and development

The `vendor` directory contains pinned runtime modules and decoders, so the running game does not depend on a third-party CDN. It still needs a modern browser with WebGL2, WebAssembly, ES modules and gzip DecompressionStream support.

For local development, use `python -m http.server 8765` from this directory and open `http://localhost:8765`. Do not launch it as a `file://` document. The asset preparation and release acceptance workflows run on the release branch before merge to the Pages branch.

See [CREDITS.md](./CREDITS.md) for model authors, licenses and modification notes.
