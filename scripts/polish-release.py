"""Small idempotent corrections applied after upgrade-release.py."""
from pathlib import Path
root=Path(__file__).resolve().parent.parent

def patch(name,old,new):
    p=root/name;s=p.read_text()
    if old in s:p.write_text(s.replace(old,new))
    elif new not in s:raise RuntimeError('Missing refinement anchor: '+name+' '+old[:60])

patch('quality.js','new THREE.CubeCamera(.15, 850, cubeTarget)','new THREE.CubeCamera(.15, 6500, cubeTarget)')
# Unused orbit limits must not lift the selected nose/cockpit camera while parked.
patch('game.js','if(canOrbit){if(orbitActive)orbit.target.copy(target);orbit.update();}', 'if(canOrbit&&orbitActive){orbit.target.copy(target);orbit.update();}')
# Match collision boxes to the actual rendered building transforms.
patch('track.js','scene.add(buildings);', '''scene.add(buildings);
  // Building collision shapes use the same world-space instance transforms.
  {const matrix=new THREE.Matrix4(),p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();for(let i=0;i<buildings.count;i++){buildings.getMatrixAt(i,matrix);matrix.decompose(p,q,s);world.createCollider(R.ColliderDesc.cuboid(Math.abs(s.x)/2,Math.abs(s.y)/2,Math.abs(s.z)/2).setTranslation(p.x,p.y,p.z).setRotation(q).setFriction(.6).setRestitution(.02));}}''')
# Dispose replaced model textures as well as their materials and geometry.
patch('car.js','const disposedGeometry=new Set(),disposedMaterial=new Set();', 'const disposedGeometry=new Set(),disposedMaterial=new Set(),disposedTextures=new Set();')
patch('car.js','disposedMaterial.add(o.material);o.material.dispose();','disposedMaterial.add(o.material);for(const value of Object.values(o.material)){if(value?.isTexture&&!disposedTextures.has(value)){disposedTextures.add(value);value.dispose();}}o.material.dispose();')
print('Rendering and collision refinements applied')
