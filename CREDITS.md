# Asset credits and preview notes

## Oracle Red Bull F1 Car RB19 2023

- Author: **Redgrund**, https://sketchfab.com/redgrund
- Original model: https://sketchfab.com/3d-models/oracle-red-bull-f1-car-rb19-2023-e4afe46f3aab4b23a418da06fc163821
- License stated in the supplied model: **Creative Commons Attribution 4.0 International**, https://creativecommons.org/licenses/by/4.0/
- The preview uses a compressed, WebP-textured version of the same model, redistributed in `assets/rb19.glb`.
- Compact-model source: https://github.com/vladlen-codes/f1-pitwall/blob/6238d08d9f3a6e6790560525659b30f9cc87d8d4/public/rb19.glb
- Preview modifications: model scale and origin normalization, wheel-region separation, steering pivots and wheel-spin animation. The temporary geometric loading car is separate from this asset.

## NFS Undercover DS — Highway Battle

- Author/uploader credited by the supplied GLB: **amogusstrikesback2**, https://sketchfab.com/amogusstrikesback2
- Original model: https://sketchfab.com/3d-models/nfs-undercover-ds-highway-battle-e8b1859b628a42209b8866d9a4b45936
- License stated in the supplied model: **Creative Commons Attribution 4.0 International**, https://creativecommons.org/licenses/by/4.0/
- Preview modifications: roadway meshes extracted, merged and rescaled; compressed geometry stored in `assets/highway-road.b64`; generated surface materials, collision barriers and simplified scenery added. This preview does not reproduce the original model's complete scenery or original textures.

The names, liveries, logos and trademarks appearing on supplied assets remain those of their respective owners. Asset attribution does not imply endorsement or grant separate trademark rights. This project is not an official Formula 1, Red Bull, Oracle or Need for Speed product.

## Runtime libraries

- Three.js 0.180.0, MIT: https://github.com/mrdoob/three.js
- Rapier 3D JavaScript compatibility package 0.17.3, Apache 2.0: https://github.com/dimforge/rapier.js
- Draco decoder, Apache 2.0: https://github.com/google/draco
- Meshoptimizer decoder, MIT: https://github.com/zeux/meshoptimizer

## Build status

Preview 0.1 is supplied for the user's first playtest. Its menus and runtime include touch/keyboard driving, chassis collision geometry, ray-cast suspension, grip and downforce controls, camera presets, stationary orbit/zoom, weather/time settings and quality presets. This is not a validated simulation of the real RB19. Full scene fidelity, final physics tuning and high-end rendering are unfinished. **No ray-traced rendering is included in this preview.**
