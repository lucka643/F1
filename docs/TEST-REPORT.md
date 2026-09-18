# F1 Highway Drive 1.0 — test report

## Published build

The tested runtime was published to `main` as commit `53dda4fab529a82ecfe86a491b94a194d1016a57`. GitHub Pages deployment succeeded. This report adds documentation only; it does not change the tested runtime.

Play: https://lucka643.github.io/F1/

## Release acceptance

The acceptance run finished on 18 September 2026. **All 9 physics regressions and all 12 browser scenarios passed.**

| Suite | Result | Evidence |
| --- | --- | --- |
| Actual Rapier physics | 9 passed, 0 failed | [physics.json](./tests/physics.json) |
| Chromium WebGL browser acceptance | 12 passed, 0 failed | [browser.json](./tests/browser.json) |
| Runtime / console errors during browser acceptance | 0 | `errors` in browser.json |
| Failed or HTTP-error asset requests during browser acceptance | 0 | `requests` in browser.json |
| Public GitHub Pages smoke test | Passed | [Live verification run](https://github.com/lucka643/F1/actions/runs/35315950016) |

[Release acceptance workflow run](https://github.com/lucka643/F1/actions/runs/35314857976).

Physics checks cover suspension settling, acceleration, braking and reverse, steering and wheel rotation, airborne gravity and landing, a high-speed wall impact, weather-dependent tyre friction, downforce-induced suspension load, and repeated resets.

Browser checks cover self-hosted loading and the RB19 model, keyboard input, wheel spin, pause and saved preferences, all six camera presets, stationary orbit and zoom with camera restoration when driving, all four quality presets, rain/night, snow/fog/sunset, path-traced Photo Mode, repeated settings changes, simultaneous mobile pedal/steering touches, and portrait layout.

## Public-site verification

A separate Chromium session opened the actual public Pages URL, loaded the standard car, accelerated under keyboard control, reset the car, opened settings, selected Ultra, loaded the full-resolution car and captured the rendered page.

Recorded at **2026-09-18 06:43:14 UTC**, against runtime commit `53dda4fab529a82ecfe86a491b94a194d1016a57`:

- Version: `1.0`.
- Driving speed observed: **18.69 km/h**.
- Selected quality and loaded car asset: **Ultra**.
- Game failure flag: **false**.
- Recorded runtime/console errors: **0**.
- Recorded HTTP-error responses: **0**.

The live screenshot and machine-readable result are in the `live-pages-evidence` artifact attached to the live verification run. The release screenshots are also retained in [docs/tests](./tests/).

## Test environment and limits

The tests used Playwright 1.55.1, Linux Chromium and ANGLE SwiftShader, a software GPU. Mobile tests simulate mobile viewport and touch input; they are not tests on a physical iPhone. Real-device frame rates and physical iPhone Safari have not been measured.

Seven non-fatal warnings were recorded in the acceptance suite: deprecated dependency initialization/loader APIs and an unavailable parallel shader compilation extension. These are retained in the raw report; they did not prevent any scenario from passing.

These checks do not establish that every device, driving situation or future change is error-free. The driving model is adjustable game physics, not a telemetry-validated real RB19 simulator.

**Ultra driving and ray tracing are different modes.** Ultra uses high-detail assets, lighting, shadows and real-time reflection techniques. Genuine progressive path tracing is available in stopped-car Photo Mode, not while racing. Surrounding scenery is rebuilt around the supplied road geometry; this release does not claim photorealistic AAA visuals.
