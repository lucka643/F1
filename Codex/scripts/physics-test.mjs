import fs from 'node:fs/promises';
const root=new URL('../',import.meta.url),source=await fs.readFile(new URL('game.js',root),'utf8');
const core=source.slice(source.indexOf('// A dynamic chassis'),source.indexOf('const cameraPosition='));
if(!core.includes('function simulate'))throw new Error('Physics test cannot locate simulation');
const prefix=`import * as THREE from 'three';import R from './vendor/rapier/rapier.es.js';import {createTrack} from './track.js';import {WHEEL_CENTERS} from './car.js';import fs from 'node:fs/promises';import assert from 'node:assert/strict';
globalThis.document={hidden:false,querySelectorAll:()=>[],createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){},fillRect(){}})})};
Object.defineProperty(globalThis,'navigator',{value:{getGamepads:()=>[]},configurable:true});
globalThis.fetch=async u=>new Response(await fs.readFile(u));
await R.init();const STEP=1/120,world=new R.World({x:0,y:-9.81,z:0});world.timestep=STEP;world.integrationParameters.maxCcdSubsteps=8;
const scene=new THREE.Scene(),track=await createTrack(scene,world,R),clamp=THREE.MathUtils.clamp,$=()=>({open:false}),notice=()=>{},quality={photo:false};
const settings={camera:'chase',fov:65,distance:11,quality:'simple',maxSpeed:330,grip:1,downforce:1,steering:1,assist:true,weather:'clear',time:'day',sound:false,showFPS:false};
`;
const tests=`
const report=[];
function step(seconds,inputs={}){clearInput();for(const [k,v]of Object.entries(inputs))if(v)pointers[k].add(-1);for(let i=0;i<Math.round(seconds/STEP);i++){simulate(STEP);const p=body.translation(),v=body.linvel();assert(Number.isFinite(p.x+p.y+p.z+v.x+v.y+v.z));}clearInput();readBody();return{position:position.toArray(),speed:signedSpeed*3.6,up:up.y,contacts:Array.from({length:4},(_,i)=>vehicle.wheelIsInContact(i)),suspension:[...suspension]};}
function test(name,fn){try{const data=fn();report.push({name,passed:true,data});console.log('PASS',name,JSON.stringify(data));}catch(e){report.push({name,passed:false,error:e.message});console.error('FAIL',name,e.message);}}
function reset(){settings.weather='clear';settings.grip=1;settings.downforce=1;settings.maxSpeed=330;respawn(true);step(2);}
test('Gravity and suspension settle',()=>{reset();const s=step(1);assert(s.contacts.every(Boolean));assert(Math.abs(s.speed)<.5);assert(s.position[1]>.45&&s.position[1]<1.1);return s;});
test('Acceleration under engine power',()=>{reset();const s=step(3,{throttle:1});assert(s.speed>70&&s.speed<210);assert(s.up>.8);return s;});
test('Braking and controlled reverse',()=>{reset();const initial=step(3,{throttle:1});const stopped=step(2.7,{brake:1});assert(Math.abs(stopped.speed)<2);const reverse=step(1.5,{brake:1});assert(reverse.speed<-3&&reverse.speed>-40);return{initial,stopped,reverse};});
test('Steering changes yaw and front wheels',()=>{reset();step(.65,{throttle:1});const before=Math.atan2(forward.x,forward.z);const s=step(.4,{throttle:1,left:1});assert(Math.abs(steer)>.01);const yaw=Math.atan2(forward.x,forward.z),yawChange=Math.atan2(Math.sin(yaw-before),Math.cos(yaw-before));assert(Math.abs(yawChange)>.02);assert(vehicle.wheelSteering(2)===0);return{...s,steer,yawChange,wheelRotation:vehicle.wheelRotation(0)};});
test('Airborne gravity and landing',()=>{reset();body.setTranslation({x:track.start.x,y:track.start.y+7,z:track.start.z},true);body.setLinvel({x:0,y:0,z:0},true);step(.3);assert(body.linvel().y<-2);const s=step(3);assert(s.contacts.filter(Boolean).length>=3);assert(s.position[1]<1.2);return s;});
test('High-speed wall impact cannot pass through',()=>{reset();const e=[...track.boundary].sort((a,b)=>a.mid.distanceToSquared(track.start)-b.mid.distanceToSquared(track.start))[0];const p=e.mid.clone().addScaledVector(e.normal,-4);p.y=e.mid.y+.8;body.setTranslation(p,true);body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.atan2(e.normal.x,e.normal.z)),true);body.setLinvel({x:e.normal.x*90,y:0,z:e.normal.z*90},true);body.setAngvel({x:0,y:0,z:0},true);let worst=-100;for(let i=0;i<120;i++){simulate(STEP);const v=body.translation();const d=(v.x-e.mid.x)*e.normal.x+(v.z-e.mid.z)*e.normal.z;worst=Math.max(worst,d);}readBody();assert(worst<.55,'wall penetration '+worst);return{maximumOutsideDistance:worst,speed:signedSpeed*3.6,position:position.toArray()};});
test('Rain and snow change tyre friction',()=>{reset();const values={};for(const weather of ['clear','rain','snow']){settings.weather=weather;step(.1);values[weather]=vehicle.wheelFrictionSlip(0);}assert(values.snow<values.rain&&values.rain<values.clear);return values;});
test('Downforce increases suspension load',()=>{reset();function load(setting){respawn(true);settings.downforce=setting;step(1);body.setLinvel({x:0,y:0,z:-70},true);step(.1);return Array.from({length:4},(_,i)=>vehicle.wheelSuspensionForce(i)||0).reduce((a,b)=>a+b,0);}const off=load(0),on=load(2);assert(on>off*1.1);return{off,on};});
test('Repeated reset remains finite and grounded',()=>{for(let i=0;i<12;i++){reset();step(.1,{throttle:1});}const s=step(.2);assert(s.up>.9);return s;});
await fs.mkdir(new URL('./docs/tests/',import.meta.url),{recursive:true});await fs.writeFile(new URL('./docs/tests/physics.json',import.meta.url),JSON.stringify({engine:'Rapier 0.17.3',fixedStep:STEP,tests:report},null,2));if(report.some(t=>!t.passed))process.exitCode=1;
`;
const file=new URL('.physics-test.generated.mjs',root);await fs.writeFile(file,prefix+core+tests);try{await import(file.href+'?'+Date.now());}finally{await fs.unlink(file);}
