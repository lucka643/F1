"""Idempotent refinements applied after upgrade-release.py."""
from pathlib import Path
root=Path(__file__).resolve().parent.parent

def patch(name,old,new):
    p=root/name;s=p.read_text()
    if old in s:p.write_text(s.replace(old,new))
    elif new not in s:raise RuntimeError('Missing refinement anchor: '+name+' '+old[:70])

patch('quality.js','new THREE.CubeCamera(.15, 850, cubeTarget)','new THREE.CubeCamera(.15, 6500, cubeTarget)')
patch('game.js','if(canOrbit){if(orbitActive)orbit.target.copy(target);orbit.update();}', 'if(canOrbit&&orbitActive){orbit.target.copy(target);orbit.update();}')
p=root/'game.js';s=p.read_text()
if "import { createRealism }" not in s:
    s=s.replace("import { addSceneryDetail } from './scenery.js';", "import { addSceneryDetail } from './scenery.js';\nimport { createRealism } from './realism.js';")
    s=s.replace('const details = addSceneryDetail(scene,track);','const details = addSceneryDetail(scene,track);\n$(\'load-message\').textContent=\'Loading scanned surfaces, sky and vegetation…\';\nconst realism = await createRealism(scene,renderer,track,settings,notice);')
    s=s.replace('details.update(paused?0:delta,car.root,velocity,settings);','details.update(paused?0:delta,car.root,velocity,settings);realism.update(position);')
    s=s.replace("camera:'chase',fov:65,distance:11", "camera:'chase',fov:58,distance:7.5")
    s=s.replace('const settings = {...defaults};', "if(saved.fov===65&&saved.distance===11){saved.fov=58;saved.distance=7.5;}\nconst settings = {...defaults};")
    s=s.replace('2.7+Math.min(speed*.014,1.3)', '1.9+Math.min(speed*.009,.9)')
    p.write_text(s)
# Match collision boxes to the rendered building transforms.
p=root/'track.js';s=p.read_text()
if 'Building collision shapes use' not in s:
    s=s.replace('scene.add(buildings);', '''scene.add(buildings);
  // Building collision shapes use the same world-space instance transforms.
  {const matrix=new THREE.Matrix4(),p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();for(let i=0;i<buildings.count;i++){buildings.getMatrixAt(i,matrix);matrix.decompose(p,q,s);world.createCollider(R.ColliderDesc.cuboid(Math.abs(s.x)/2,Math.abs(s.y)/2,Math.abs(s.z)/2).setTranslation(p.x,p.y,p.z).setRotation(q).setFriction(.6).setRestitution(.02));}}''')
    p.write_text(s)
p=root/'car.js';s=p.read_text()
if 'disposedTextures' not in s:
    s=s.replace('const disposedGeometry=new Set(),disposedMaterial=new Set();', 'const disposedGeometry=new Set(),disposedMaterial=new Set(),disposedTextures=new Set();')
    s=s.replace('disposedMaterial.add(o.material);o.material.dispose();','disposedMaterial.add(o.material);for(const value of Object.values(o.material)){if(value?.isTexture&&!disposedTextures.has(value)){disposedTextures.add(value);value.dispose();}}o.material.dispose();')
    p.write_text(s)
p=root/'quality.js';s=p.read_text()
if 'scene.userData.usePhotoHDR' not in s:
    s=s.replace('if(o.isDirectionalLight){const light=o.clone();','if(o.isDirectionalLight){if(scene.userData.usePhotoHDR)return;const light=o.clone();')
    s=s.replace('result.environment=traceEnvironment;result.background=traceEnvironment;', 'result.environment=scene.userData.usePhotoHDR?scene.userData.photoEnvironment:traceEnvironment;result.background=result.environment;result.backgroundIntensity=.65;result.environmentIntensity=.85;')
    p.write_text(s)
p=root/'realism.js';s=p.read_text().replace('i+=4){tree.getMatrixAt','i+=6){tree.getMatrixAt')
if '// REFRESH_HDR_LIGHTS' not in s:
    s=s.replace('if(useHDR)suns.forEach(l=>{l.target.position.copy(position);', "// REFRESH_HDR_LIGHTS: atmosphere.apply also runs for unrelated settings.\n    if(useHDR){hemi.forEach(l=>l.intensity=.6);suns.forEach(l=>{l.intensity=3.5;l.color.setHex(0xfff5e5);});}\n    if(useHDR)suns.forEach(l=>{l.target.position.copy(position);")
if 'const treeCells=' not in s:
    s=s.replace("  gltf.scene.traverse(o=>{if(!o.isMesh)return;", "  // Separate instance bounds let the GPU skip whole offscreen tree clusters.\n  const treeCells=new Map();for(const v of placements){const key=Math.floor(v.position.x/180)+':'+Math.floor(v.position.z/180);if(!treeCells.has(key))treeCells.set(key,[]);treeCells.get(key).push(v);}\n  gltf.scene.traverse(o=>{if(!o.isMesh)return;")
    s=s.replace('const mesh=new THREE.InstancedMesh(geometry,o.material,placements.length);', 'for(const cluster of treeCells.values()){const mesh=new THREE.InstancedMesh(geometry,o.material,cluster.length);')
    s=s.replace('placements.forEach((v,i)=>{dummy.position.copy(v.position);', 'cluster.forEach((v,i)=>{dummy.position.copy(v.position);')
    s=s.replace('mesh.computeBoundingSphere();naturalTrees.add(mesh);', 'mesh.computeBoundingSphere();naturalTrees.add(mesh);}')
p.write_text(s)
print('Photographic lighting, spatial vegetation culling and collision refinements applied')
