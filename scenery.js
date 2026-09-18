import * as THREE from 'three';

/** Detail surfaces are procedural rather than upscaled low-resolution maps. */
export function addSceneryDetail(scene,track) {
  let seed=1919;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
  const ctx=canvas.getContext('2d'),im=ctx.createImageData(1024,1024);
  for(let y=0;y<1024;y++)for(let x=0;x<1024;x++){const i=(y*1024+x)*4,n=rand(),coarse=Math.sin(x*.073)*Math.sin(y*.059)*3;
    const c=76+coarse+n*34+(n>.982?31:0);im.data[i]=c;im.data[i+1]=c+2;im.data[i+2]=c+3;im.data[i+3]=255;}
  ctx.putImageData(im,0,0);const asphalt=new THREE.CanvasTexture(canvas);asphalt.wrapS=asphalt.wrapT=THREE.RepeatWrapping;asphalt.colorSpace=THREE.SRGBColorSpace;
  const bump=asphalt.clone();bump.colorSpace=THREE.NoColorSpace;
  track.roadMaterial.map=asphalt;track.roadMaterial.bumpMap=bump;track.roadMaterial.bumpScale=.012;track.roadMaterial.needsUpdate=true;track.asphalt.dispose();track.asphalt=asphalt;
  const rc=document.createElement('canvas');rc.width=rc.height=256;const rctx=rc.getContext('2d');rctx.fillStyle='#a0a0a0';rctx.fillRect(0,0,256,256);
  for(let i=0;i<150;i++){const x=rand()*256,y=rand()*256,r=6+rand()*30,grad=rctx.createRadialGradient(x,y,0,x,y,r);grad.addColorStop(0,i%3?'#555':'#eee');grad.addColorStop(1,'#a0a0a000');rctx.fillStyle=grad;rctx.fillRect(x-r,y-r,r*2,r*2);}
  const rough=new THREE.CanvasTexture(rc);rough.wrapS=rough.wrapT=THREE.RepeatWrapping;rough.repeat.set(.12,.12);track.roadMaterial.roughnessMap=rough;
  const fc=document.createElement('canvas');fc.width=256;fc.height=512;const fctx=fc.getContext('2d');fctx.fillStyle='#a2a6a4';fctx.fillRect(0,0,256,512);
  for(let row=0;row<16;row++)for(let col=0;col<8;col++){fctx.fillStyle=rand()>.84?'#adb7b9':'#35474c';fctx.fillRect(col*32+5,row*32+7,21,19);fctx.fillStyle='#d4d7d4';fctx.fillRect(col*32+4,row*32+27,23,2);}
  const facade=new THREE.CanvasTexture(fc);facade.colorSpace=THREE.SRGBColorSpace;facade.wrapS=facade.wrapT=THREE.RepeatWrapping;facade.anisotropy=8;
  scene.traverse(o=>{if(o.isInstancedMesh&&o.geometry.type==='BoxGeometry'&&o.count>10&&o.count<track.boundary.length){o.material.map=facade;o.material.roughness=.86;o.material.needsUpdate=true;}});
  const group=new THREE.Group();group.name='Track lighting';scene.add(group);const lampPoints=[];
  let previous=null;
  for(const e of track.boundary){if(previous&&e.mid.distanceTo(previous)<65)continue;const p=e.mid.clone().addScaledVector(e.normal,1.4);if(track.heightAt(p.x,p.z)!==null)continue;previous=p;lampPoints.push(p);}
  const poles=new THREE.InstancedMesh(new THREE.CylinderGeometry(.07,.14,8,7),new THREE.MeshStandardMaterial({color:0x8c9295,metalness:.65,roughness:.42}),lampPoints.length);
  const heads=new THREE.InstancedMesh(new THREE.BoxGeometry(.7,.12,.36),new THREE.MeshStandardMaterial({color:0xdee5ed,emissive:0xffdda8,emissiveIntensity:0}),lampPoints.length),dummy=new THREE.Object3D();
  lampPoints.forEach((p,i)=>{dummy.position.copy(p).add(new THREE.Vector3(0,4,0));dummy.rotation.set(0,0,0);dummy.scale.set(1,1,1);dummy.updateMatrix();poles.setMatrixAt(i,dummy.matrix);dummy.position.y=p.y+8;dummy.updateMatrix();heads.setMatrixAt(i,dummy.matrix);});poles.castShadow=true;group.add(poles,heads);
  const lights=Array.from({length:4},()=>{const l=new THREE.PointLight(0xffddaa,0,48,2);group.add(l);return l;});
  const count=640,positions=new Float32Array(count*3),ages=new Float32Array(count),vels=new Float32Array(count*3);ages.fill(-1);let next=0;
  const sc=document.createElement('canvas');sc.width=sc.height=32;const sx=sc.getContext('2d'),grad=sx.createRadialGradient(16,16,0,16,16,16);grad.addColorStop(0,'#ffffffff');grad.addColorStop(.35,'#ffffffbb');grad.addColorStop(1,'#ffffff00');sx.fillStyle=grad;sx.fillRect(0,0,32,32);
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
  const mat=new THREE.PointsMaterial({size:.55,map:new THREE.CanvasTexture(sc),transparent:true,opacity:.16,depthWrite:false,color:0xe0e8ee});const spray=new THREE.Points(geo,mat);spray.frustumCulled=false;scene.add(spray);let lampClock=2;
  function update(dt,car,velocity,settings){
    const night=settings.time==='night';heads.material.emissiveIntensity=night?6:0;lampClock+=dt;
    if(lampClock>1.5){lampClock=0;const nearest=lampPoints.map(p=>({p,d:p.distanceToSquared(car.position)})).sort((a,b)=>a.d-b.d).slice(0,4);lights.forEach((l,i)=>{const v=nearest[i];l.intensity=night&&v?800:0;if(v)l.position.copy(v.p).add(new THREE.Vector3(0,7.8,0));});}
    if(!night)lights.forEach(l=>l.intensity=0);
    const wet=settings.weather==='rain'||settings.weather==='snow';spray.visible=wet&&settings.quality!=='simple';if(!spray.visible)return;
    const speed=velocity.length();if(speed>7&&dt>0)for(let n=0;n<Math.min(18,Math.ceil(dt*speed*5));n++){const i=next++%count,j=i*3,p=new THREE.Vector3(n%2?.8:-.8,-.38,-1.8).applyQuaternion(car.quaternion).add(car.position);positions[j]=p.x;positions[j+1]=p.y;positions[j+2]=p.z;vels[j]=-velocity.x*.2+(rand()-.5)*2;vels[j+1]=1+rand()*1.5;vels[j+2]=-velocity.z*.2+(rand()-.5)*2;ages[i]=0;}
    for(let i=0;i<count;i++){const j=i*3;if(ages[i]<0){positions[j+1]=-1000;continue;}ages[i]+=dt;if(ages[i]>1.4){ages[i]=-1;positions[j+1]=-1000;continue;}positions[j]+=vels[j]*dt;positions[j+1]+=vels[j+1]*dt;positions[j+2]+=vels[j+2]*dt;vels[j+1]-=2*dt;}
    geo.attributes.position.needsUpdate=true;
  }
  return{update};
}
