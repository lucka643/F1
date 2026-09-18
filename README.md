# F1 Highway Drive — preview

The preview is a static website. `index.html` is in the repository root, alongside the game modules and stylesheet. No npm installation, build command or custom Pages workflow is needed to publish this preview.

## Play on GitHub Pages

In this repository's **Settings → Pages**, choose **Deploy from a branch**, then **main** and **/ (root)**. Save and wait for GitHub's publishing job to finish. The site address is:

**https://lucka643.github.io/F1/**

Open that website address, not the GitHub source-code view of `index.html`. Press **Start driving**. Use landscape orientation on a phone or tablet.

## Controls

- The two left buttons are throttle and brake. Hold brake while stopped to reverse.
- The two right buttons steer left and right. Throttle and steering can be held together.
- The top-left button opens the settings and pauses the simulation. The top-right button respawns the car at its last safe road position.
- Keyboard: **W A S D** or the **arrow keys**. **Space** brakes, **R** respawns, **C** changes camera and **Esc** opens settings.
- Drag or pinch the view while stopped to orbit and zoom. Moving restores the selected camera preset.

Settings include six cameras, field of view, chase distance, four graphics presets, speed limiter, tyre grip, downforce, steering sensitivity, stability assistance, weather, time of day, synthetic engine audio and frame-rate display. Preferences are saved on the device.

## Files

- `index.html`: entry point and settings interface.
- `style.css`: responsive interface and touch controls.
- `game.js`: application loop, Rapier chassis and suspension physics, input, audio and camera controls.
- `track.js`: highway road geometry, collision boundaries and reduced-detail scenery.
- `car.js`: RB19 loading, temporary loading car, steering pivots and wheel rotation.
- `environment.js`: lighting, sky, rain, snow and fog.
- `assets/highway-road.b64`: compressed road geometry extracted from the supplied Highway Battle GLB.
- `assets/rb19.glb`: the compact RB19 preview model.
- `.nojekyll`: enables direct static-file publishing.

## Preview limitations

This is the preview, **not the finished simulator**. The highway roadway comes from the supplied model, but surrounding scenery and road textures are simplified for this build. The compact RB19 model loads separately; a temporary car remains available while it loads or if the model download fails.

**Ultra is not ray tracing in this preview.** It increases resolution, shadow-map size and precipitation detail. Full asset fidelity, higher-end rendering, final vehicle tuning and the later testing pass remain separate work. The preview has not been browser-playtested by the assistant; it is provided for the user's requested first test.

An internet connection is required. Three.js, Rapier and model decoders load from pinned CDN versions; the car also has an attributed public-source download fallback. The browser needs WebGL2, JavaScript modules, WebAssembly and gzip `DecompressionStream` support. Opening `index.html` directly as a local `file://` document is not the supported launch method; use GitHub Pages or a local HTTP server.

Asset authors, license links and modification notes are in [CREDITS.md](./CREDITS.md).
