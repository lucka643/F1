import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function createEnvironment(scene,renderer,track){
  const hemi=new THREE.HemisphereLight(0xc9e5ff,0x6b6954,2.1);scene.add(hemi);
  const sun=new THREE.DirectionalLight(0xfff0d7,3.1);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=sun.shadow.camera.bottom=-38;sun.shadow.camera.right=sun.shadow.camera.top=38;sun.shadow.camera.near=.5;sun.shadow.camera.far=220;sun.shadow.normalBias=.035;sun.shadow.bias=-.00015;scene.add(sun,sun.target);
  const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();const environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;room.dispose();pmrem.dispose();
  const uniforms={top:{value:new THREE.Color(0x3997e4)},horizon:{value:new THREE.Color(0xd1e5ea)},sunDirection:{value:new THREE.Vector3(-.5,.75,-.4).normalize()},sunColor:{value:new THREE.Color(0xfff2c4)},cloud:{value:.18},clock:{value:0}};
  const sky=new THREE.Mesh(new THREE.SphereGeometry(4000,24,16),new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,toneMapped:false,uniforms,vertexShader:'varying vec3 direction; void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'varying vec3 direction;uniform vec3 top,horizon,sunDirection,sunColor;uniform float cloud,clock;void main(){vec3 d=normalize(direction);float h=max(d.y,0.0);vec3 col=mix(horizon,top,pow(h,.45));float n=sin(d.x*17.0+d.z*8.0+clock*.007)*sin(d.z*24.0-d.x*13.0+clock*.011);float c=smoothstep(.18,.85,n)*smoothstep(.03,.2,h)*(1.0-smoothstep(.55,.85,h));col=mix(col,vec3(.92),c*cloud);float disc=smoothstep(.99965,.99994,dot(d,normalize(sunDirection)));col+=disc*sunColor*1.8;gl_FragColor=vec4(col,1.0);}'}));sky.frustumCulled=false;sky.renderOrder=-100;scene.add(sky);
  const count=1600,base=new Float32Array(count*3),rainArray=new Float32Array(count*6),snowArray=new Float32Array(count*3);
  let seed=412;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  for(let i=0;i<count;i++){base[i*3]=(random()-.5)*65;base[i*3+1]=random()*35;base[i*3+2]=(random()-.5)*65;}
  const rainGeo=new THREE.BufferGeometry();rainGeo.setAttribute('position',new THREE.BufferAttribute(rainArray,3).setUsage(THREE.DynamicDrawUsage));const rain=new THREE.LineSegments(rainGeo,new THREE.LineBasicMaterial({color:0xc9dcea,transparent:true,opacity:.35,depthWrite:false}));rain.frustumCulled=false;scene.add(rain);
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d'),gradient=ctx.createRadialGradient(16,16,1,16,16,15);gradient.addColorStop(0,'white');gradient.addColorStop(.6,'white');gradient.addColorStop(1,'transparent');ctx.fillStyle=gradient;ctx.fillRect(0,0,32,32);
  const snowGeo=new THREE.BufferGeometry();snowGeo.setAttribute('position',new THREE.BufferAttribute(snowArray,3).setUsage(THREE.DynamicDrawUsage));const snow=new THREE.Points(snowGeo,new THREE.PointsMaterial({color:0xffffff,size:.16,map:new THREE.CanvasTexture(canvas),transparent:true,opacity:.88,depthWrite:false}));snow.frustumCulled=false;scene.add(snow);
  let active=500,weather='clear',time='day';
  function apply(settings){
    weather=settings.weather;time=settings.time;active={simple:180,medium:500,high:1000,ultra:1600}[settings.quality]??500;
    rain.visible=weather==='rain';snow.visible=weather==='snow';rainGeo.setDrawRange(0,active*2);snowGeo.setDrawRange(0,active);
    const night=time==='night',sunset=time==='sunset',wet=weather==='rain',white=weather==='snow';
    const skyColor=night?0x101c36:sunset?0x586888:wet?0x728798:white?0xa8b8c3:0x3d9be3;
    const horizonColor=night?0x293751:sunset?0xefb589:wet?0xadb8c0:white?0xd4dce0:0xd0e7ed;
    uniforms.top.value.setHex(skyColor);uniforms.horizon.value.setHex(horizonColor);uniforms.cloud.value=night?0:wet?.5:.18;
    uniforms.sunDirection.value.set(night?.3:-.5,night?.65:sunset?.12:.75,-.4).normalize();uniforms.sunColor.value.setHex(night?0x536882:sunset?0xffb66c:0xfff2c4);
    hemi.intensity=night?.8:wet?1.75:2.1;hemi.color.setHex(night?0x8baddd:0xc9e5ff);sun.intensity=night?1.35:wet?1.2:sunset?2.5:3.1;sun.color.setHex(night?0x9dbbff:sunset?0xffb976:0xfff0d7);
    scene.fog=new THREE.FogExp2(horizonColor,weather==='fog'?.011:wet?.006:white?.0065:night?.002:.0013);
    track.roadMaterial.roughness=wet?.27:white?.8:.93;track.roadMaterial.metalness=wet?.16:.02;track.roadMaterial.color.setHex(wet?0x8b94a0:white?0xb9c0c4:0xffffff);track.grassMaterial.color.setHex(white?0xffffff:0xc8d5ad);track.banks.material.color.setHex(white?0xdde3e8:0x788664);
    sun.castShadow=settings.quality!=='simple';const resolution={simple:512,medium:1024,high:2048,ultra:4096}[settings.quality]??1024;if(sun.shadow.mapSize.x!==resolution){sun.shadow.mapSize.set(resolution,resolution);if(sun.shadow.map){sun.shadow.map.dispose();sun.shadow.map=null;}}
  }
  function update(dt,position,elapsed){
    sky.position.copy(position);uniforms.clock.value=elapsed;
    sun.target.position.copy(position);sun.position.copy(position).addScaledVector(uniforms.sunDirection.value,95);sun.target.updateMatrixWorld();
    rain.position.copy(position);snow.position.copy(position);
    if(weather==='clear'||weather==='fog')return;
    for(let i=0;i<active;i++){const j=i*3;base[j+1]-=dt*(weather==='rain'?27:2.6);if(base[j+1]<-3)base[j+1]+=38;const x=base[j]+(weather==='snow'?Math.sin(elapsed*.7+i)*.8:0),y=base[j+1],z=base[j+2];snowArray[j]=x;snowArray[j+1]=y;snowArray[j+2]=z;const k=i*6;rainArray[k]=x;rainArray[k+1]=y;rainArray[k+2]=z;rainArray[k+3]=x-.17;rainArray[k+4]=y-1.2;rainArray[k+5]=z+.06;}
    rainGeo.attributes.position.needsUpdate=true;snowGeo.attributes.position.needsUpdate=true;
  }
  return{apply,update};
}
