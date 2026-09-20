"""Apply the reviewed 1.0 upgrade to the committed preview source. Idempotent."""
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent

def replace(text, old, new):
    if old not in text: raise RuntimeError('Source anchor missing: '+old[:90])
    return text.replace(old,new)

game=ROOT/'game.js'
s=game.read_text()
if '// RELEASE_1_0' not in s:
    s='// RELEASE_1_0\n'+s
    s=replace(s,"import { createEnvironment } from './environment.js';", "import { createEnvironment } from './environment.js';\nimport { createQualityPipeline } from './quality.js';\nimport { addSceneryDetail } from './scenery.js';")
    s=replace(s,'world.timestep = STEP;', 'world.timestep = STEP;\nworld.integrationParameters.maxCcdSubsteps = 8;')
    s=replace(s,'const car = createCarVisual(scene,notice);', 'const car = createCarVisual(scene,notice);\nconst details = addSceneryDetail(scene,track);\nconst quality = createQualityPipeline(renderer,scene,camera,track,car,settings,notice);')
    s=replace(s,'const isPaused=()=>!started||dialog.open||document.hidden||failed;', 'const isPaused=()=>!started||dialog.open||document.hidden||failed||quality.photo;\nlet qaManual=false, invertedTime=0;')
    s=replace(s,"if(pointers[name].size)return 1;", "if(pointers[name].size)return 1;\n  const pad=navigator.getGamepads?.()[0];\n  if(pad){const axis=pad.axes?.[0]||0;if(name==='throttle'&&pad.buttons?.[7]?.value>.05)return pad.buttons[7].value;if(name==='brake'&&pad.buttons?.[6]?.value>.05)return pad.buttons[6].value;if(name==='left'&&axis<-.12)return Math.min(1,(-axis-.12)/.88);if(name==='right'&&axis>.12)return Math.min(1,(axis-.12)/.88);}")
    s=replace(s,'gas=THREE.MathUtils.damp(gas,throttle&&!brake?1:0,7,dt);','gas=THREE.MathUtils.damp(gas,throttle&&!brake?throttle:0,7,dt);')
    s=replace(s,'vehicle.setWheelBrake(i,braking);','vehicle.setWheelBrake(i,braking*(i<2?1.15:.85));')
    s=replace(s,'  world.step();\n  checkpointClock+=dt;', "  world.step();\n  invertedTime=up.y<.25?invertedTime+dt:0;\n  if(invertedTime>3.5){invertedTime=0;respawn();notice('Car recovered after rolling over');}\n  checkpointClock+=dt;")
    s=replace(s,'const canOrbit=speed<.8&&!dialog.open&&started;', 'const canOrbit=(speed<.8||quality.photo)&&!dialog.open&&started;\n  if(!canOrbit)orbitActive=false;')
    s=replace(s,'    if(canOrbit){orbit.target.copy(target);camera.lookAt(target);}', '')
    s=replace(s,'  orbitActive=canOrbit;', '')
    s=replace(s,'const cameraLabels=',"orbit.addEventListener('start',()=>{if(orbit.enabled){orbitActive=true;orbit.target.copy(position).add(new THREE.Vector3(0,.25,0));}});\nconst cameraLabels=")
    s=replace(s,'  camera.aspect=innerWidth/innerHeight;camera.fov=settings.fov;camera.updateProjectionMatrix();', '  camera.aspect=innerWidth/innerHeight;camera.fov=settings.fov;camera.updateProjectionMatrix();\n  quality.resize();')
    s=replace(s,"  $('fps').hidden=!settings.showFPS;", "  quality.apply();\n  if(settings.quality==='ultra'&&!quality.photo)car.loadModel('ultra').then(()=>quality.apply());\n  $('fps').hidden=!settings.showFPS;")
    s=replace(s,'function openSettings(){if(!started||dialog.open)return;', 'function openSettings(){if(!started||dialog.open)return;if(quality.photo)quality.leavePhoto();')
    s=replace(s,"$('menu').addEventListener('click',openSettings);", "$('menu').addEventListener('click',openSettings);\n$('photo').addEventListener('click',async()=>{if(Math.abs(signedSpeed)>1){notice('Stop the car before entering Photo Mode.',6000);return;}closeSettings();clearInput();car.speed=signedSpeed;await quality.enterPhoto();orbitActive=true;orbit.target.copy(position).add(new THREE.Vector3(0,.25,0));});")
    s=replace(s,"if(event.code==='Escape'){event.preventDefault();", "if(event.code==='Escape'){if(quality.photo){quality.leavePhoto();resetCamera=true;return;}event.preventDefault();")
    s=replace(s,"$('load-message').textContent='Highway ready. The RB19 model loads separately while you drive.';", "$('load-message').textContent='Highway ready. Choose your view and conditions in Drive settings.';")
    s=replace(s,'car.loadModel();', "car.loadModel(settings.quality==='ultra'?'ultra':'standard').then(()=>quality.apply());")
    s=replace(s,'if(!paused){accumulator=', 'if(!paused&&!qaManual){accumulator=')
    s=replace(s,'car.sync(suspension,steer,signedSpeed,paused?0:delta);','car.sync(suspension,steer,signedSpeed,paused?0:delta,Array.from({length:4},(_,i)=>vehicle.wheelRotation(i)));car.speed=signedSpeed;')
    s=replace(s,'updateCamera(delta);atmosphere.update(paused?0:delta,position,elapsed);', 'updateCamera(delta);atmosphere.update(paused?0:delta,position,elapsed);details.update(paused?0:delta,car.root,velocity,settings);')
    s=replace(s,'renderer.render(scene,camera);requestAnimationFrame(frame);', 'quality.render(delta);requestAnimationFrame(frame);')
    s+='''
// Read-only health data is useful when reporting a device-specific problem.
function health(){readBody();return {version:'1.0',ready:started,failed,position:position.toArray(),rotation:rotation.toArray(),velocity:velocity.toArray(),speed:signedSpeed*3.6,steer,up:up.y,contacts:Array.from({length:4},(_,i)=>vehicle.wheelIsInContact(i)),suspension:[...suspension],wheelAngles:Array.from({length:4},(_,i)=>vehicle.wheelRotation(i)),wheelLoads:Array.from({length:4},(_,i)=>vehicle.wheelSuspensionForce(i)),model:car.modelStatus,settings:{...settings},photo:quality.photo,samples:quality.samples,camera:camera.position.toArray(),orbit:orbitActive,ground:track.heightAt(position.x,position.z,position.y),render:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles},memory:{...renderer.info.memory}};}
window.__F1=Object.freeze({health});
// Deterministic test controls exist only at the explicit QA URL.
if(new URLSearchParams(location.search).has('qa'))window.__F1Test={
 manual(value=true){qaManual=value;clearInput();},
 reset(){respawn(true);invertedTime=0;},
 step(count=120,controls={}){clearInput();for(const [name,value] of Object.entries(controls))if(value&&pointers[name])pointers[name].add(-1);for(let i=0;i<Math.min(10000,count);i++)simulate(STEP);clearInput();readBody();car.root.position.copy(position);car.root.quaternion.copy(rotation);car.sync(suspension,steer,signedSpeed,0,Array.from({length:4},(_,i)=>vehicle.wheelRotation(i)));return health();},
 settings(values){for(const [k,v]of Object.entries(values)){if(options[k]&&options[k].includes(v))settings[k]=v;else if(ranges[k]&&Number.isFinite(v))settings[k]=clamp(v,...ranges[k]);else if(typeof defaults[k]==='boolean'&&typeof v==='boolean')settings[k]=v;const e=$(k);if(e){if(e.type==='checkbox')e.checked=settings[k];else e.value=settings[k];}}resetCamera=true;orbitActive=false;applySettings();return health();},
 pose(p,yaw=0,v=[0,0,0]){clearInput();body.setTranslation({x:p[0],y:p[1],z:p[2]},true);body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw),true);body.setLinvel({x:v[0],y:v[1],z:v[2]},true);body.setAngvel({x:0,y:0,z:0},true);body.resetForces(true);body.resetTorques(true);invertedTime=0;resetCamera=true;world.step();readBody();return health();},
 wall(){const edge=[...track.boundary].sort((a,b)=>a.mid.distanceToSquared(track.start)-b.mid.distanceToSquared(track.start))[0];return{mid:edge.mid.toArray(),normal:edge.normal.toArray()};},
 photo(){car.speed=signedSpeed;return quality.enterPhoto();}, exitPhoto(){quality.leavePhoto();},health
};
'''
    game.write_text(s)

p=ROOT/'car.js';s=p.read_text()
if '// RELEASE_MODEL_1_0' not in s:
    s='// RELEASE_MODEL_1_0\n'+s
    s=replace(s,'let wheels=[], assembly=new THREE.Group(), spinAngle=0;',"let wheels=[], assembly=new THREE.Group(), spinAngle=0, modelStatus='loading', loading=null, loadedQuality='';")
    s=replace(s,'function sync(suspension,steering,speed,dt)', 'function sync(suspension,steering,speed,dt,rotations)')
    s=replace(s,'w.spin.rotation.x=spinAngle;', 'w.spin.rotation.x=Number.isFinite(rotations?.[i])?rotations[i]%(Math.PI*2):spinAngle;')
    s=replace(s,'async function loadModel(){',"async function loadModel(quality='standard'){\n    if(loadedQuality===quality||loadedQuality==='ultra')return;\n    if(loading){await loading;if(loadedQuality===quality||loadedQuality==='ultra')return;}\n    let finish;loading=new Promise(resolve=>{finish=resolve;});\n    if(quality==='ultra')notice('Loading full-resolution RB19 for Ultra…',0);")
    s=s.replace("'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/draco/gltf/'", "new URL('./vendor/three/examples/jsm/libs/draco/gltf/',import.meta.url).href")
    s=replace(s,"const urls=[new URL('./assets/rb19.glb',import.meta.url).href,'https://raw.githubusercontent.com/vladlen-codes/f1-pitwall/6238d08d9f3a6e6790560525659b30f9cc87d8d4/public/rb19.glb'];", "const urls=[new URL(quality==='ultra'?'./assets/rb19-ultra.glb':'./assets/rb19.glb',import.meta.url).href];")
    s=replace(s,"notice('RB19 loaded · drive with the pedals or W A S D',6000);", "loadedQuality=quality;modelStatus=quality;notice(quality==='ultra'?'Full-resolution RB19 loaded':'RB19 loaded · drive with the pedals or W A S D',6000);")
    s=replace(s,'finally{draco.dispose();}', 'finally{draco.dispose();finish();loading=null;}')
    s=replace(s,'return{root,sync,loadModel,rearLight};','return{root,sync,loadModel,rearLight,get modelStatus(){return modelStatus;}};')
    p.write_text(s)

p=ROOT/'index.html';s=p.read_text()
s=s.replace('https://cdn.jsdelivr.net/npm/three@0.180.0/','./vendor/three/').replace('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.17.3/','./vendor/rapier/')
if 'three-gpu-pathtracer' not in s:s=s.replace('"rapier":"./vendor/rapier/rapier.es.js"','"rapier":"./vendor/rapier/rapier.es.js","three/examples/jsm/":"./vendor/three/examples/jsm/","three-mesh-bvh":"./vendor/three-mesh-bvh/build/index.module.js","three-gpu-pathtracer":"./vendor/three-gpu-pathtracer/build/index.module.js"')
s=s.replace('Preview</title>','1.0</title>').replace('preview-1','release-1').replace('PLAYABLE PREVIEW · 0.1','DRIVING BUILD · 1.0').replace('<b>PREVIEW</b>','<b>1.0</b>').replace('Ultra (preview)','Ultra')
s=s.replace('A reduced-detail preview using the supplied highway road geometry.<br>The RB19 model streams separately. Internet access is required.','The supplied highway road mesh, rebuilt scenery and the RB19.<br>All engine and model files are hosted with this game.')
s=s.replace('Preview presets change resolution, shadows and weather detail. Ray tracing is not included in this build.','Ultra enables HDR reflections, ambient occlusion, 4096px shadows and full-resolution car textures. Photo Mode adds genuine path tracing while parked; driving uses real-time rendering.')
if 'id="photo"' not in s:s=s.replace('<button id="fullscreen">','<button id="photo">Ray-traced Photo Mode (park first)</button><button id="fullscreen">')
s=s.replace('Asset credits & preview notes','Credits and build notes').replace('Could not start the preview:','Could not start the game:')
p.write_text(s)
p=ROOT/'style.css';s=p.read_text()
if '#photo-bar' not in s:s+='''
#photo-bar{position:fixed;z-index:40;bottom:max(20px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;gap:10px;width:max-content;max-width:95vw;background:#0c1729dc;backdrop-filter:blur(8px);border:1px solid #ffffff38;border-radius:10px;padding:10px 14px;font-size:12px}#photo-bar button{padding:9px 12px;font-size:11px}body.photo-mode #hud{visibility:hidden}#photo-state{min-width:175px;font-variant-numeric:tabular-nums}@media(max-width:600px){#photo-bar{flex-wrap:wrap;width:94vw}#photo-state{width:100%;text-align:center}}
'''
p.write_text(s)
print('Release 1.0 source prepared')
