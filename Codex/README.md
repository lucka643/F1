# F1 Highway Drive — 1.0

[Play the game](https://lucka643.github.io/F1/)

A browser driving game using the supplied RB19 car and Highway Battle roadway. Open the website and press **Start driving**. GitHub Pages serves **main / (root)**; no installation or build command is needed to play.

## Driving

The two left buttons control throttle and brake; the two right buttons steer. Multiple touch buttons work together. Hold brake at a stop to reverse. The top-left button opens settings and pauses; the top-right button resets to the last safe road position.

Keyboard: **WASD / arrow keys**, **Space** brake, **R** reset, **C** camera, **Esc** settings. A standard gamepad uses its left stick and right/left triggers. Use landscape orientation on phones.

While stopped, drag to orbit and pinch or scroll to zoom. The selected camera resumes when the car starts moving. Choose chase, close chase, TV pod, cockpit, nose or top-down views. Settings also provide field of view, chase distance, a speed limiter, grip, downforce, steering sensitivity and stability assistance. Preferences are saved locally.

## Graphics and conditions

| Preset | Rendering |
| --- | --- |
| Simple | Lower pixel density, basic lighting, lightweight vegetation, no dynamic shadow maps. |
| Medium | Dynamic shadows and a larger weather-particle budget. |
| High | Photographic sky and lighting, natural tree models, HDR pipeline, ambient occlusion, bloom, anti-aliasing and 2048px shadows. |
| Ultra | Full-resolution RB19, 4096px shadows, screen-space reflections, dynamic environment reflections, ambient occlusion and maximum weather detail. |

The car's Ultra asset retains the original geometry detail and source texture dimensions. Scanned 2K asphalt, grass and concrete surfaces add normal and roughness detail. High and Ultra use a photographic HDR sky for clear daytime conditions and spatially culled natural vegetation. Building facades and street lighting are generated scenery. These additions are attributed in [CREDITS.md](./CREDITS.md).

**Ray-traced Photo Mode is separate from real-time driving.** Stop, open settings, then choose Photo Mode. It uses genuine progressive path tracing with multiple light bounces. Let samples accumulate for a cleaner image; moving the camera restarts accumulation. Save with **Save photo**, or return to driving. This is not hardware-accelerated RTX while racing. The path tracer and high-end render targets depend on GPU/browser support.

Clear, rain, snow and fog are available with day, sunset and night lighting. Rain and snow lower tyre friction. Rain changes road reflectivity and produces tyre spray. Weather particles and lighting are simulated; this build does not model accumulated snow depth.

## Simulation

The 800kg dynamic chassis has four ray-cast suspension springs, rear-wheel drive, braking, aerodynamic drag, speed-dependent downforce and traction changes. Chassis and wheel collision shapes interact with the road, barriers and building collision boxes. Continuous collision detection uses eight substeps. The simulation runs at a fixed 120Hz and pauses in menus or when the page loses focus. Wheel rotation follows the simulated wheels; front-wheel steering is independent. A rolled-over car is recovered automatically.

This is an adjustable game simulation, **not a telemetry-validated model of the real RB19**. The supplied roadway is retained; surrounding scenery is rebuilt rather than a full reproduction of the original track environment. Ultra is not equivalent to a photogrammetric AAA racing game.

## Tests and troubleshooting

The release workflow runs nine actual Rapier simulation regressions and twelve Chromium WebGL browser scenarios, with screenshots and machine-readable evidence in [`docs/tests`](./docs/tests). They cover boot, model loading, driving, wheel rotation, braking/reverse, steering, gravity/landing, a 324km/h wall impact, weather-dependent friction, downforce, settings persistence, pause, cameras, stationary orbit, quality presets, Photo Mode, mobile multitouch and portrait layout.

A separate **Live Pages smoke test** checks the public website after publication: cold loading, the RB19 model, acceleration, respawn, settings and Ultra loading/rendering. Its evidence is attached to the corresponding Actions run.

The browser tests use Linux Chromium and an ANGLE SwiftShader software GPU. They check rendering and input correctness, not physical-device frame rates. **Physical iPhone Safari and every possible device have not been tested.** No test suite proves that software has no possible errors.

If a GPU runs slowly, choose Medium or Simple. A lost graphics context displays a reload prompt. Read-only diagnostics are available through `window.__F1.health()`; deterministic simulation controls are exposed only at the explicit `?qa` URL.

## Hosting and development

Pinned runtime modules and decoders are self-hosted in `vendor`; the game does not load its engine from a third-party CDN. It requires a modern browser with WebGL2, WebAssembly, ES modules and gzip DecompressionStream support.

For local development, run `python -m http.server 8765` from the repository root and open `http://localhost:8765`. Do not launch through a `file://` URL. Asset preparation and acceptance workflows operate on the release branch before merging to Pages.

See [CREDITS.md](./CREDITS.md) for authors, licenses and modifications, and [the Actions runs](https://github.com/lucka643/F1/actions) for build and test status.
