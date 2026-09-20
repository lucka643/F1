# Asset credits and build notes

## Oracle Red Bull F1 Car RB19 2023

Author: **Redgrund**, https://sketchfab.com/redgrund

Original model: https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821

License stated in the supplied model: **Creative Commons Attribution 4.0 International**, https://creativecommons.org/licenses/by/4.0/

The regular car uses the compressed WebP-textured version of the supplied model in `assets/rb19.glb`. Its source is https://github.com/vladlen-codes/f1-pitwall/blob/6238d08d9f3a6e6790560525659b30f9cc87d8d4/public/rb19.glb.

The Ultra car is prepared from the exact original 54,470,372-byte GLB. Its Git blob checksum is checked during preparation, and provenance is recorded in `assets/ultra-manifest.json`. The Ultra preparation does not simplify triangles or resize source textures. It uses Draco geometry quantization/compression and lossless WebP texture packaging. These are not invented higher-resolution textures.

Game modifications include scale/origin normalization, wheel-region separation, steering pivots, suspension movement and wheel-spin animation. The temporary geometric loading car is separate from this asset.

## NFS Undercover DS — Highway Battle

Author/uploader credited by the supplied GLB: **amogusstrikesback2**, https://sketchfab.com/amogusstrikesback2

Original model: https://sketchfab.com/3d-models/nfs-undercover-ds-highway-battle-e8b1859b628a42209b8866d9a4b45936

License stated in the supplied model: **Creative Commons Attribution 4.0 International**, https://creativecommons.org/licenses/by/4.0/

Roadway meshes are extracted, merged and rescaled in `assets/highway-road.b64`. The game adds scanned surface materials, collision barriers, embankments, buildings, facades, vegetation, distant terrain and lighting. It preserves the supplied road geometry, not the original model's complete scenery or original texture set. The original environment is not a photorealistic asset, and this reconstruction is not a full reproduction of the source game.

Names, liveries, logos and trademarks appearing on the supplied assets remain those of their respective owners. Attribution does not imply endorsement or grant separate trademark rights. This is not an official Formula 1, Red Bull, Oracle or Need for Speed product.

## Poly Haven photographic assets — CC0

Source files and download metadata are recorded in `assets/realism/`. These assets are distributed by **Poly Haven** under CC0: https://polyhaven.com/license

- Asphalt 02: https://polyhaven.com/a/asphalt_02
- Aerial Grass Rock: https://polyhaven.com/a/aerial_grass_rock
- Concrete Floor Worn 001: https://polyhaven.com/a/concrete_floor_worn_001
- Kloppenheim 05 PureSky: https://polyhaven.com/a/kloppenheim_05_puresky
- Tree Small 02: https://polyhaven.com/a/tree_small_02

Surface color, normal and roughness maps are packaged at 2K in WebP format. The lighting environment is a 2K HDR panorama. The tree is simplified and Draco-compressed, with 1K WebP textures, and placed in spatially culled instance clusters. Source texture licenses do not apply to the separate branded car or extracted road assets above.

## Runtime libraries

- Three.js 0.180.0, MIT: https://github.com/mrdoob/three.js
- Rapier JavaScript compatibility package 0.17.3, Apache 2.0: https://github.com/dimforge/rapier.js
- three-mesh-bvh 0.9.1, MIT: https://github.com/gkjohnson/three-mesh-bvh
- three-gpu-pathtracer 0.0.24, MIT: https://github.com/gkjohnson/three-gpu-pathtracer
- Draco decoder, Apache 2.0: https://github.com/google/draco
- Meshoptimizer decoder, MIT: https://github.com/zeux/meshoptimizer

Runtime packages and their available licenses are distributed under `vendor/`. The Rapier package omits a license file, so its upstream Apache 2.0 license is included separately.

## Rendering and simulation scope

Ultra driving uses rasterized HDR rendering with ambient occlusion, screen-space and environment-map reflections, bloom and shadow maps. **Ray tracing is genuine progressive path tracing in parked Photo Mode, not hardware RTX while driving.** The road environment is rebuilt and the physics are game-oriented rather than a measured real-RB19 vehicle model.

Test source and results are in `scripts/` and `docs/tests/`. Automated desktop/mobile-viewport browser tests are not a substitute for testing on every physical device.
