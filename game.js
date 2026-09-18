// RELEASE_1_0
import * as THREE from 'three';
import R from 'rapier';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createTrack } from './track.js';
import { createCarVisual, WHEEL_CENTERS } from './car.js';
import { createEnvironment } from './environment.js';
import { createQualityPipeline } from './quality.js';
import { addSceneryDetail } from './scenery.js';
import { createRealism } from './realism.js';

const $ = id => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const coarse = matchMedia('(pointer: coarse)').matches;
const defaults = {camera:'chase',fov:58,distance:7.5,quality:coarse?'medium':'high',maxSpeed:330,grip:1,downforce:1,steering:1,assist:true,weather:'clear',time:'day',sound:true,showFPS:false};
const options = {camera:['chase','close','tv','cockpit','nose','top'],quality:['simple','medium','high','ultra'],weather:['clear','rain','snow','fog'],time:['day','sunset','night']};
const ranges = {fov:[40,100],distance:[5,18],maxSpeed:[100,420],grip:[.5,2.5],downforce:[0,2.5],steering:[.4,1.6]};
let saved = {};
try { saved = JSON.parse(localStorage.getItem('f1-highway-preview-settings') || '{}') || {}; } catch {}
if(saved.fov===65&&saved.distance===11){saved.fov=58;saved.distance=7.5;}
const settings = {...defaults};
for (const key of Object.keys(defaults)) {
  const value = saved[key];
  if (options[key] && options[key].includes(value)) settings[key] = value;
  else if (ranges[key] && typeof value === 'number' && Number.isFinite(value)) settings[key] = clamp(value,...ranges[key]);
  else if (typeof defaults[key] === 'boolean' && typeof value === 'boolean') settings[key] = value;
}
const renderer = new THREE.WebGLRenderer({canvas:$('game'),antialias:true,powerPreference:'high-performance'});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov,innerWidth/innerHeight,.08,6500);
const orbit = new OrbitControls(camera,renderer.domElement);
orbit.enablePan = false; orbit.enableDamping = true; orbit.dampingFactor = .12;
orbit.minDistance = .3; orbit.maxDistance = 40; orbit.minPolarAngle = .08; orbit.maxPolarAngle = Math.PI*.48;
orbit.rotateSpeed = .65; orbit.zoomSpeed = .8;
let messageTimer;
function notice(text,duration=5000) {
  clearTimeout(messageTimer); $('notice').textContent=text; $('notice').style.opacity='1';
  if(duration>0) messageTimer=setTimeout(()=>{$('notice').style.opacity='0';},duration);
}
$('load-message').textContent='Preparing suspension and highway collision geometry…';
await R.init();
const world = new R.World({x:0,y:-9.81,z:0});
const STEP = 1/120;
world.timestep = STEP;
world.integrationParameters.maxCcdSubsteps = 8;
const track = await createTrack(scene,world,R);
const atmosphere = createEnvironment(scene,renderer,track);
const car = createCarVisual(scene,notice);
const details = addSceneryDetail(scene,track);
$('load-message').textContent='Loading scanned surfaces, sky and vegetation…';
const realism = await createRealism(scene,renderer,track,settings,notice);
const quality = createQualityPipeline(renderer,scene,camera,track,car,settings,notice);

// A dynamic chassis with four independently ray-cast suspension springs.
const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
  .setTranslation(track.start.x,track.start.y+1,track.start.z)
  .setRotation({x:0,y:1,z:0,w:0}).setCcdEnabled(true)
  .setAngularDamping(.9).setLinearDamping(.015).setCanSleep(false));
body.setAdditionalSolverIterations(4);
world.createCollider(R.ColliderDesc.cuboid(.58,.17,2.22).setTranslation(0,-.21,-.1).setMass(760).setFriction(.3).setRestitution(.04),body);
world.createCollider(R.ColliderDesc.cuboid(.99,.065,.3).setTranslation(0,-.4,2.76).setMass(10).setFriction(.2),body);
world.createCollider(R.ColliderDesc.cuboid(.7,.1,.25).setTranslation(0,.2,-2.2).setMass(10).setFriction(.2),body);
for(const center of WHEEL_CENTERS) world.createCollider(R.ColliderDesc.cuboid(.22,.25,.31).setTranslation(center.x,-.17,center.z).setMass(5).setFriction(.3),body);
const vehicle = world.createVehicleController(body);
vehicle.indexUpAxis = 1;
// The pinned Rapier version names its forward-axis setter setIndexForwardAxis.
vehicle.setIndexForwardAxis = 2;
for(let i=0;i<4;i++) {
  const center=WHEEL_CENTERS[i];
  vehicle.addWheel({x:center.x,y:0,z:center.z},{x:0,y:-1,z:0},{x:-1,y:0,z:0},.25,.375);
  vehicle.setWheelSuspensionStiffness(i,95);
  vehicle.setWheelSuspensionCompression(i,4.5);
  vehicle.setWheelSuspensionRelaxation(i,5.8);
  vehicle.setWheelMaxSuspensionTravel(i,.18);
  vehicle.setWheelMaxSuspensionForce(i,26000);
  vehicle.setWheelSideFrictionStiffness(i,1);
}
world.step();

const keys = new Set();
const pointers = {throttle:new Set(),brake:new Set(),left:new Set(),right:new Set()};
let started=false, failed=false, accumulator=0, steer=0, gas=0, reverseHold=0, signedSpeed=0, elapsed=0, checkpointClock=0;
let resetCamera=true, orbitActive=false;
let checkpoint={x:track.start.x,y:track.start.y+.9,z:track.start.z,yaw:Math.PI};
const position=new THREE.Vector3(), rotation=new THREE.Quaternion(), forward=new THREE.Vector3(), up=new THREE.Vector3(), velocity=new THREE.Vector3();
const suspension=[.25,.25,.25,.25];
const dialog=$('settings');
const isPaused=()=>!started||dialog.open||document.hidden||failed||quality.photo;
let qaManual=false, invertedTime=0;
function clearInput(){keys.clear();Object.values(pointers).forEach(set=>set.clear());document.querySelectorAll('.drive-button').forEach(button=>button.classList.remove('pressed'));gas=0;reverseHold=0;}
function control(name){
  if(pointers[name].size)return 1;
  const pad=navigator.getGamepads?.()[0];
  if(pad){const axis=pad.axes?.[0]||0;if(name==='throttle'&&pad.buttons?.[7]?.value>.05)return pad.buttons[7].value;if(name==='brake'&&pad.buttons?.[6]?.value>.05)return pad.buttons[6].value;if(name==='left'&&axis<-.12)return Math.min(1,(-axis-.12)/.88);if(name==='right'&&axis>.12)return Math.min(1,(axis-.12)/.88);}
  if(name==='throttle')return keys.has('KeyW')||keys.has('ArrowUp')?1:0;
  if(name==='brake')return keys.has('KeyS')||keys.has('ArrowDown')||keys.has('Space')?1:0;
  if(name==='left')return keys.has('KeyA')||keys.has('ArrowLeft')?1:0;
  return keys.has('KeyD')||keys.has('ArrowRight')?1:0;
}
function readBody(){
  const p=body.translation(),q=body.rotation(),v=body.linvel();
  position.set(p.x,p.y,p.z);rotation.set(q.x,q.y,q.z,q.w);
  forward.set(0,0,1).applyQuaternion(rotation);up.set(0,1,0).applyQuaternion(rotation);
  velocity.set(v.x,v.y,v.z);signedSpeed=velocity.dot(forward);
}
function respawn(atStart=false){
  clearInput();
  if(atStart)checkpoint={x:track.start.x,y:track.start.y+.9,z:track.start.z,yaw:Math.PI};
  body.setTranslation({x:checkpoint.x,y:checkpoint.y,z:checkpoint.z},true);
  body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),checkpoint.yaw),true);
  body.setLinvel({x:0,y:0,z:0},true);body.setAngvel({x:0,y:0,z:0},true);body.resetForces(true);body.resetTorques(true);
  steer=0;signedSpeed=0;accumulator=0;resetCamera=true;orbitActive=false;
  for(let i=0;i<4;i++){vehicle.setWheelEngineForce(i,0);vehicle.setWheelBrake(i,0);vehicle.setWheelSteering(i,0);suspension[i]=.25;}
  readBody();notice(atStart?'Returned to the starting straight':'Car reset to the last safe road position');
}
function simulate(dt){
  readBody();
  if(!Number.isFinite(position.x+position.y+position.z)||position.y < -25||Math.abs(position.x)>5000||Math.abs(position.z)>5000){respawn();return;}
  const throttle=control('throttle'),brake=control('brake'),turn=control('left')-control('right');
  gas=THREE.MathUtils.damp(gas,throttle&&!brake?throttle:0,7,dt);
  const speed=velocity.length();
  const wetFactor={clear:1,rain:.63,snow:.32,fog:.95}[settings.weather];
  const grip=settings.grip*wetFactor;
  const downforce=Math.min(45000,2.3*speed*speed*settings.downforce);
  const safeAcceleration=(14+downforce/800*1.1)*grip;
  const steeringLimit=settings.assist?Math.min(.48,Math.atan(3.54*safeAcceleration/(signedSpeed*signedSpeed+20))):.48/(1+Math.abs(signedSpeed)*.018);
  const targetSteer=turn*steeringLimit*settings.steering;
  const steeringRate=dt*(settings.assist?1.8:2.5);
  steer+=clamp(targetSteer-steer,-steeringRate,steeringRate);
  const max=settings.maxSpeed/3.6;
  let engine=gas*Math.min(12500,640000/(Math.abs(signedSpeed)+12))*clamp((max-signedSpeed)/(max*.06),0,1);
  let braking=0;
  if(brake&&!throttle&&signedSpeed<.6){reverseHold+=dt;}else{reverseHold=0;}
  if(brake){
    engine=0;
    if(reverseHold>.65&&!throttle&&signedSpeed<.6)engine=-4300*clamp((8+signedSpeed)/2,0,1);
    else braking=800*15*dt/4;
  }
  if(throttle&&signedSpeed<-.5){engine=0;braking=800*12*dt/4;}
  if(!throttle&&!brake&&Math.abs(signedSpeed)<.3)braking=2.5;
  if(signedSpeed>max*1.02)braking=Math.max(braking,7);
  body.resetForces(true);body.resetTorques(true);
  body.addForce({x:-up.x*downforce-velocity.x*(.66*speed+9),y:-up.y*downforce-velocity.y*(.66*speed+9),z:-up.z*downforce-velocity.z*(.66*speed+9)},true);
  body.setAngularDamping(settings.assist?.9:.3);
  let contacts=0;
  for(let i=0;i<4;i++){
    vehicle.setWheelFrictionSlip(i,1.8*grip);
    vehicle.setWheelSteering(i,i<2?steer:0);
    vehicle.setWheelEngineForce(i,i>=2?engine/2:0);
    vehicle.setWheelBrake(i,braking*(i<2?1.15:.85));
  }
  vehicle.updateVehicle(dt,R.QueryFilterFlags.EXCLUDE_DYNAMIC);
  for(let i=0;i<4;i++){
    suspension[i]=clamp(vehicle.wheelSuspensionLength(i)??.25,.07,.43);
    if(vehicle.wheelIsInContact(i))contacts++;
  }
  world.step();
  invertedTime=up.y<.25?invertedTime+dt:0;
  if(invertedTime>3.5){invertedTime=0;respawn();notice('Car recovered after rolling over');}
  checkpointClock+=dt;
  if(checkpointClock>.6){
    checkpointClock=0;const ground=track.heightAt(position.x,position.z,position.y-.6);
    if(contacts>=3&&up.y>.85&&ground!==null&&Math.abs(position.y-ground)<1.5){checkpoint={x:position.x,y:ground+.9,z:position.z,yaw:Math.atan2(forward.x,forward.z)};}
  }
}

const cameraPosition=new THREE.Vector3(),cameraTarget=new THREE.Vector3(),cameraDirection=new THREE.Vector3();
orbit.addEventListener('start',()=>{if(orbit.enabled){orbitActive=true;orbit.target.copy(position).add(new THREE.Vector3(0,.25,0));}});
const cameraLabels={chase:'CHASE',close:'CLOSE CHASE',tv:'TV POD',cockpit:'COCKPIT',nose:'NOSE',top:'TOP DOWN'};
function updateCamera(dt){
  const speed=Math.abs(signedSpeed);
  const target=position.clone().add(new THREE.Vector3(0,.4,0));
  const canOrbit=(speed<.8||quality.photo)&&!dialog.open&&started;
  if(!canOrbit)orbitActive=false;
  if(resetCamera||!canOrbit||!orbitActive){
    switch(settings.camera){
      case 'close':cameraPosition.set(0,1.6,-6);cameraTarget.set(0,.35,4);break;
      case 'tv':cameraPosition.set(0,1.08,-.1);cameraTarget.set(0,.65,16);break;
      case 'cockpit':cameraPosition.set(.01,.72,.4);cameraTarget.set(0,.62,17);break;
      case 'nose':cameraPosition.set(0,.14,2.86);cameraTarget.set(0,.14,24);break;
      case 'top':cameraPosition.set(.01,33,-.3);cameraTarget.set(0,0,1);break;
      default:cameraPosition.set(0,1.9+Math.min(speed*.009,.9),-settings.distance);cameraTarget.set(0,.4,3+speed*.025);
    }
    cameraPosition.applyQuaternion(rotation).add(position);cameraTarget.applyQuaternion(rotation).add(position);
    const alpha=resetCamera?1:1-Math.exp(-dt*8);
    camera.position.lerp(cameraPosition,alpha);orbit.target.lerp(cameraTarget,alpha);
    camera.up.set(0,1,0);camera.lookAt(orbit.target);

    resetCamera=false;
  }
  orbit.enabled=canOrbit;
  if(canOrbit&&orbitActive){orbit.target.copy(target);orbit.update();}

  // Move the camera closer when a static barrier blocks the line of sight.
  cameraDirection.copy(camera.position).sub(orbit.target);const distance=cameraDirection.length();
  if(distance>1.3){cameraDirection.divideScalar(distance);const hit=world.castRay(new R.Ray(orbit.target,cameraDirection),distance,true,R.QueryFilterFlags.EXCLUDE_DYNAMIC,undefined,undefined,body);if(hit&&hit.timeOfImpact>.4&&hit.timeOfImpact<distance)camera.position.copy(orbit.target).addScaledVector(cameraDirection,Math.max(.4,hit.timeOfImpact-.3));}
}

let audio=null;
function startAudio(){
  if(!settings.sound)return;
  try{
    const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return;
    if(!audio){const context=new Context(),oscillator=context.createOscillator(),filter=context.createBiquadFilter(),gain=context.createGain();oscillator.type='sawtooth';oscillator.frequency.value=90;filter.type='lowpass';filter.frequency.value=1300;gain.gain.value=0;oscillator.connect(filter).connect(gain).connect(context.destination);oscillator.start();audio={context,oscillator,filter,gain};}
    if(audio.context.state==='suspended')audio.context.resume().catch(()=>{});
  }catch(error){console.warn('Audio is unavailable:',error.message);}
}
function updateAudio(rpm){
  if(!audio)return;const t=audio.context.currentTime;
  audio.gain.gain.setTargetAtTime(settings.sound&&!isPaused()?.012+gas*.019:0,t,.06);
  audio.oscillator.frequency.setTargetAtTime(70+rpm*310,t,.035);
  audio.filter.frequency.setTargetAtTime(500+gas*1600+rpm*450,t,.07);
}
function resize(){
  const limit={simple:.85,medium:1.2,high:1.5,ultra:2}[settings.quality];
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,limit));renderer.setSize(innerWidth,innerHeight,false);
  camera.aspect=innerWidth/innerHeight;camera.fov=settings.fov;camera.updateProjectionMatrix();
  quality.resize();
}
function applySettings(){
  resize();renderer.shadowMap.enabled=settings.quality!=='simple';
  atmosphere.apply(settings);track.asphalt.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),settings.quality==='ultra'?16:settings.quality==='high'?8:4);track.asphalt.needsUpdate=true;
  quality.apply();
  if(settings.quality==='ultra'&&!quality.photo)car.loadModel('ultra').then(()=>quality.apply());
  $('fps').hidden=!settings.showFPS;$('camera-name').textContent=cameraLabels[settings.camera];
  $('surface').textContent={clear:'DRY',rain:'WET',snow:'SNOW',fog:'FOG'}[settings.weather];
  const units={fov:'°',distance:' m',maxSpeed:' km/h',grip:'×',downforce:'×',steering:'×'};
  for(const key of Object.keys(ranges))$(key+'-value').textContent=settings[key]+units[key];
  try{localStorage.setItem('f1-highway-preview-settings',JSON.stringify(settings));}catch{}
}
for(const key of Object.keys(defaults)){
  const element=$(key);if(!element)continue;
  if(element.type==='checkbox')element.checked=settings[key];else element.value=settings[key];
  const update=()=>{
    settings[key]=element.type==='checkbox'?element.checked:ranges[key]?clamp(Number(element.value),...ranges[key]):element.value;
    if(key==='camera'||key==='distance')resetCamera=true;
    applySettings();if(key==='sound')startAudio();
  };
  element.addEventListener(element.type==='range'?'input':'change',update);
}
function openSettings(){if(!started||dialog.open)return;if(quality.photo)quality.leavePhoto();clearInput();dialog.showModal();accumulator=0;orbit.enabled=false;}
function closeSettings(){if(dialog.open)dialog.close();clearInput();accumulator=0;resetCamera=true;startAudio();}
$('menu').addEventListener('click',openSettings);
$('photo').addEventListener('click',async()=>{if(Math.abs(signedSpeed)>1){notice('Stop the car before entering Photo Mode.',6000);return;}closeSettings();clearInput();car.speed=signedSpeed;await quality.enterPhoto();orbitActive=true;orbit.target.copy(position).add(new THREE.Vector3(0,.25,0));});
$('close-settings').addEventListener('click',closeSettings);$('resume').addEventListener('click',closeSettings);
dialog.addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
$('reset').addEventListener('click',()=>respawn());
$('reset-start').addEventListener('click',()=>{respawn(true);closeSettings();});
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else notice('Fullscreen is not offered by this browser. Use landscape orientation.',9000);}catch{notice('Fullscreen was not available. The game can still run in this window.',8000);}});
for(const button of document.querySelectorAll('.drive-button')){
  const name=button.dataset.control;
  button.addEventListener('pointerdown',event=>{event.preventDefault();if(isPaused())return;pointers[name].add(event.pointerId);button.classList.add('pressed');try{button.setPointerCapture(event.pointerId);}catch{}startAudio();});
  const release=event=>{pointers[name].delete(event.pointerId);if(!pointers[name].size)button.classList.remove('pressed');};
  button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);button.addEventListener('contextmenu',event=>event.preventDefault());
}
const drivingKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']);
window.addEventListener('keydown',event=>{
  if(!started)return;
  if(event.code==='Escape'){if(quality.photo){quality.leavePhoto();resetCamera=true;return;}event.preventDefault();if(!event.repeat)dialog.open?closeSettings():openSettings();return;}
  if(dialog.open||event.target.matches('input,select,textarea'))return;
  if(drivingKeys.has(event.code)){event.preventDefault();keys.add(event.code);}
  if(event.repeat)return;
  if(event.code==='KeyR'){event.preventDefault();respawn();}
  if(event.code==='KeyC'){event.preventDefault();const list=options.camera;settings.camera=list[(list.indexOf(settings.camera)+1)%list.length];$('camera').value=settings.camera;resetCamera=true;applySettings();notice(cameraLabels[settings.camera]+' camera',2200);}
});
window.addEventListener('keyup',event=>keys.delete(event.code));
window.addEventListener('blur',()=>{clearInput();if(started&&!dialog.open)openSettings();});
document.addEventListener('visibilitychange',()=>{clearInput();accumulator=0;if(document.hidden&&started&&!dialog.open)openSettings();});
window.addEventListener('resize',resize);
renderer.domElement.addEventListener('contextmenu',event=>event.preventDefault());
renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();failed=true;clearInput();updateAudio(0);window.previewFail(new Error('The graphics context was lost. Reload to restart'));});

applySettings();readBody();car.root.position.copy(position);car.root.quaternion.copy(rotation);updateCamera(0);atmosphere.update(0,position,0);
$('load-message').textContent='Highway ready. Choose your view and conditions in Drive settings.';
$('load-line').hidden=true;$('start').disabled=false;$('start').textContent='Start driving';
$('start').addEventListener('click',()=>{started=true;$('loading').hidden=true;$('hud').hidden=false;clearInput();resetCamera=true;startAudio();notice('W A S D or touch controls · R resets · C changes camera',6500);});
// A model-download error never prevents driving the temporary preview car.
car.loadModel(settings.quality==='ultra'?'ultra':'standard').then(()=>quality.apply());
let previous=performance.now(),fpsElapsed=0,fpsFrames=0;
function frame(now){
  if(failed)return;
  try{
    const delta=clamp((now-previous)/1000,0,.1);previous=now;elapsed+=delta;
    const paused=isPaused();
    if(!paused&&!qaManual){accumulator=Math.min(accumulator+delta,STEP*12);let steps=0;while(accumulator>=STEP&&steps<12){simulate(STEP);accumulator=Math.max(0,accumulator-STEP);steps++;}}else accumulator=0;
    readBody();car.root.position.copy(position);car.root.quaternion.copy(rotation);car.sync(suspension,steer,signedSpeed,paused?0:delta,Array.from({length:4},(_,i)=>vehicle.wheelRotation(i)));car.speed=signedSpeed;
    updateCamera(delta);atmosphere.update(paused?0:delta,position,elapsed);details.update(paused?0:delta,car.root,velocity,settings);realism.update(position);
    car.rearLight.visible=settings.weather!=='clear'||Math.floor(elapsed*5)%2===0;
    const kmh=Math.abs(signedSpeed)*3.6,gear=signedSpeed<-1?'R':kmh<2?'N':String(Math.min(8,1+Math.floor(kmh/43)));
    const revs=gear==='N'?.15+gas*.5:.2+(kmh%43)/43*.65+gas*.15;
    $('speed').textContent=String(Math.round(kmh));$('gear').textContent=gear;$('rpm').style.width=clamp(revs*100,0,100)+'%';$('hint').hidden=kmh>3;
    updateAudio(revs);fpsElapsed+=delta;fpsFrames++;if(fpsElapsed>.7){$('fps').textContent=Math.round(fpsFrames/fpsElapsed)+' FPS';fpsElapsed=0;fpsFrames=0;}
    quality.render(delta);requestAnimationFrame(frame);
  }catch(error){failed=true;clearInput();updateAudio(0);console.error(error);window.previewFail(error);}
}
requestAnimationFrame(frame);

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
