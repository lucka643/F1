# Credits, licences and build notes — APEX

APEX shares its assets with the `Codex/` build in this repository. Nothing under
`Codex/` is modified; assets are referenced from it by relative path so the
repository does not carry two copies of a 120 MB vendor tree.

---

## Oracle Red Bull RB19 (2023)

Author: **Redgrund** — <https://sketchfab.com/redgrund>
Model: <https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821>
Licence: **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/>

Used from `../Codex/assets/rb19.glb` (157,552 triangles, WebP textures,
meshopt-compressed) and `../Codex/assets/rb19-ultra.glb` (674,992 triangles,
Draco-compressed, lossless WebP textures).

**Modifications made by APEX** (`Claude/render/car.js`):

- Scale and origin normalised so the car is 5.53 m long with its origin at the
  centre of mass.
- The model ships as a single mesh with one baked material, so the wheels are
  not separable as authored. Triangles whose vertices fall inside each wheel's
  bounding box are extracted into their own geometry and re-origined on the hub,
  giving four steerable, spinning wheels.
- The baked material is promoted from `MeshStandardMaterial` to
  `MeshPhysicalMaterial` with a clearcoat lobe.
- A roughness map is **derived** from the existing baked base-colour texture by
  saturation and luminance. This is a re-interpretation of the supplied texture,
  not an invented higher-resolution map — no new surface detail is fabricated.
- AI liveries hue-rotate the same base-colour texture, masked by saturation so
  near-greyscale regions (tyres, carbon, driver) are left untouched.

Names, liveries, logos and trademarks on the model remain those of their
respective owners. Attribution does not imply endorsement.

---

## NFS Undercover DS — Highway Battle (the circuit)

Author/uploader credited by the supplied GLB: **amogusstrikesback2** —
<https://sketchfab.com/amogusstrikesback2>
Model: <https://sketchfab.com/3d-models/nfs-undercover-ds-highway-battle-e8b1859b628a42209b8866d9a4b45936>
Licence: **CC BY 4.0**

Used from `../Codex/assets/highway-road.b64` — the roadway meshes extracted,
merged and rescaled by the Codex build. APEX consumes that file unchanged.

**Modifications made by APEX** (`Claude/circuit/roadmesh.js`), all at load time:

1. **Vertex welding at 0.15 m.** Consecutive road segments in the source meet at
   coincident-but-distinct vertices 0.02–0.06 m apart, so the ribbon reads as 12
   disjoint components. Welding merges them into two continuous rings — one per
   carriageway — of 3892 m and 3856 m.
2. **Median stitching.** The source is a dual carriageway: two ~5.0 m ribbons
   separated by a 0.57–0.75 m median. 154 mutually-facing boundary-edge pairs are
   bridged with 308 new triangles, merging the two ribbons into one continuous
   ~10.1 m racing surface. 973 triangles result, from 669 in the source.
3. **Centreline extraction.** Seeded by pairing one carriageway's two rims, then
   re-measured by probing the real triangle mesh perpendicular to the direction
   of travel. Yields a 3.87 km closed centreline with a measured corridor width
   at every station.
4. **Racing line and speed profile** solved over that corridor
   (`Claude/circuit/racingline.js`).

The original road geometry is **preserved**, not replaced. Kerbs, barriers,
run-off, markings, grandstands and scenery are added on top of it and are
original work. This is not a reproduction of the source game's environment.

---

## Poly Haven surfaces and sky — CC0

Distributed by **Poly Haven** under CC0 — <https://polyhaven.com/license>
Used from `../Codex/assets/realism/`.

- Asphalt 02 — <https://polyhaven.com/a/asphalt_02>
- Aerial Grass Rock — <https://polyhaven.com/a/aerial_grass_rock>
- Concrete Floor Worn 001 — <https://polyhaven.com/a/concrete_floor_worn_001>
- Kloppenheim 05 PureSky — <https://polyhaven.com/a/kloppenheim_05_puresky>
- Tree Small 02 — <https://polyhaven.com/a/tree_small_02>

---

## Runtime libraries

Self-hosted under `../Codex/vendor/`. No third-party CDN is contacted at runtime.

- **three.js 0.180.0** — MIT — <https://github.com/mrdoob/three.js>
- **Rapier JS compat 0.17.3** — Apache 2.0 — <https://github.com/dimforge/rapier.js>
- **three-mesh-bvh 0.9.1** — MIT — <https://github.com/gkjohnson/three-mesh-bvh>
- **three-gpu-pathtracer 0.0.24** — MIT — <https://github.com/gkjohnson/three-gpu-pathtracer>
- **Draco decoder** — Apache 2.0 — <https://github.com/google/draco>
- **meshoptimizer decoder** — MIT — <https://github.com/zeux/meshoptimizer>

---

## What "APEX" does and does not do

**It does not ray-trace while driving.** WebGL2 has no hardware ray tracing and
no browser exposes it. The APEX preset is a rasterised pipeline. What it does is
what DLSS actually does: render at 65% resolution, jitter the projection matrix
by a sub-pixel amount each frame along a Halton sequence, and reconstruct a
full-resolution image from motion-compensated history with neighbourhood
variance clipping, followed by a sharpening pass.

Reflections are **screen-space**, backed by a real-time cube probe for rays that
leave the screen. Shadows are cascaded shadow maps plus a screen-space contact
shadow pass. Ambient occlusion is GTAO. None of these are ray tracing.

**Genuine path tracing is available in Photo Mode only**, while the car is
parked, using `three-gpu-pathtracer`. That is the one place the claim is true,
and it is where the claim is made.

APEX is not equivalent to a native AAA racing game. It is a browser game that
borrows the techniques those games use.

---

Not an official Formula 1, Red Bull, Oracle or Need for Speed product.
