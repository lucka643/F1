import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export async function createRealism(scene,renderer,track,settings,notice){
  const base=new URL('./assets/realism/',import.meta.url),loader=new THREE.TextureLoader();
  const response=await fetch(new URL('manifest.json',base));if(!response.ok)throw new Error('Scanned surface manifest HTTP '+response.status);
  const manifest=await response.json(),textures=[];
  async function texture(name,color=false,repeat=1){const t=await loader.loadAsync(new URL(name,base).href);t.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.setScalar(repeat);t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());textures.push(t);return t;}
  async function surface(key,repeat=1){const f=manifest.files[key];return{map:await texture(f.diff,true,repeat),normalMap:await texture(f.nor_gl,false,repeat),roughnessMap:await texture(f.rough,false,repeat)};}
  const [asphalt,grass,concrete,hdr]=await Promise.all([surface('asphalt',.8),surface('grass',1900),surface('concrete',4),new RGBELoader().loadAsync(new URL(manifest.files.sky,base).href)]);
  // TURF_ALBEDO: recolor the moss scan and reduce repeating large color patches.
  const turf=document.createElement('canvas');turf.width=grass.map.image.width;turf.height=grass.map.image.height;const tc=turf.getContext('2d');tc.drawImage(grass.map.image,0,0);const pixels=tc.getImageData(0,0,turf.width,turf.height);
  for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=25+pixels.data[i]*.4;pixels.data[i+1]=45+pixels.data[i+1]*.55;pixels.data[i+2]=22+pixels.data[i+2]*.65;}
  tc.putImageData(pixels,0,0);grass.map.image=turf;grass.map.needsUpdate=true;
  hdr.mapping=THREE.EquirectangularReflectionMapping;
  const pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromEquirectangular(hdr);pmrem.dispose();scene.environment=environment.texture;scene.environmentIntensity=.85;scene.userData.photoEnvironment=hdr;
  const oldRoadTextures=new Set([track.roadMaterial.map,track.roadMaterial.bumpMap,track.roadMaterial.roughnessMap]);
  Object.assign(track.roadMaterial,asphalt);track.roadMaterial.bumpMap=null;track.roadMaterial.normalScale.set(.38,.38);track.roadMaterial.needsUpdate=true;track.asphalt=asphalt.map;
  for(const t of oldRoadTextures)if(t)t.dispose();
  Object.assign(track.grassMaterial,grass);track.grassMaterial.normalScale.set(.18,.18);track.grassMaterial.needsUpdate=true;
  const banksMap=grass.map.clone(),banksNormal=grass.normalMap.clone(),banksRough=grass.roughnessMap.clone();for(const t of [banksMap,banksNormal,banksRough]){t.repeat.set(1,1);t.needsUpdate=true;}
  const pos=track.banks.geometry.attributes.position,uv=[];for(let i=0;i<pos.count;i++)uv.push(pos.getX(i)*.3,pos.getZ(i)*.3);track.banks.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));Object.assign(track.banks.material,{map:banksMap,normalMap:banksNormal,roughnessMap:banksRough});track.banks.material.normalScale.set(.35,.35);track.banks.material.needsUpdate=true;
  const oldTrees=[],sky=[],hemi=[],suns=[];
  scene.traverse(o=>{
    if(o.isInstancedMesh&&o.geometry.type==='ConeGeometry')oldTrees.push(o);
    if(o.isMesh&&o.material?.isShaderMaterial&&o.material.uniforms?.sunDirection)sky.push(o);
    if(o.isHemisphereLight)hemi.push(o);if(o.isDirectionalLight)suns.push(o);
    if(o.isInstancedMesh&&o.geometry.type==='BoxGeometry'&&o.count===track.boundary.length&&o.material.color?.getHex()===0xc3cad0){Object.assign(o.material,concrete);o.material.normalScale.set(.35,.35);o.material.color.setHex(0xb9bdbe);o.material.needsUpdate=true;}
  });
  // Use the brightest HDR sky texel to align direct sunlight with its reflection.
  const image=hdr.image,rgba=image.data,stride=rgba.length/(image.width*image.height);let max=-1,bright=0;
  for(let i=0;i<image.width*image.height;i+=2){const r=hdr.type===THREE.HalfFloatType?THREE.DataUtils.fromHalfFloat(rgba[i*stride]):rgba[i*stride];if(r>max){max=r;bright=i;}}
  const u=(bright%image.width+.5)/image.width,v=(Math.floor(bright/image.width)+.5)/image.height,elevation=(.5-v)*Math.PI,azimuth=(u-.5)*2*Math.PI;
  const sunDirection=new THREE.Vector3(Math.cos(elevation)*Math.cos(azimuth),Math.abs(Math.sin(elevation)),Math.cos(elevation)*Math.sin(azimuth)).normalize();
  let seed=992;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const naturalTrees=new THREE.Group();naturalTrees.name='Natural tree models';scene.add(naturalTrees);
  const decoder=new DRACOLoader().setDecoderPath(new URL('./vendor/three/examples/jsm/libs/draco/gltf/',import.meta.url).href);
  const gltf=await new GLTFLoader().setDRACOLoader(decoder).loadAsync(new URL(manifest.files.tree,base).href);decoder.dispose();gltf.scene.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(gltf.scene),center=bounds.getCenter(new THREE.Vector3()),height=bounds.max.y-bounds.min.y;
  const placements=[],matrix=new THREE.Matrix4(),p=new THREE.Vector3(),q=new THREE.Quaternion(),scale=new THREE.Vector3(),dummy=new THREE.Object3D();
  for(const tree of oldTrees)for(let i=0;i<tree.count;i+=6){tree.getMatrixAt(i,matrix);matrix.decompose(p,q,scale);if(scale.y<.1)continue;placements.push({position:new THREE.Vector3(p.x,p.y-scale.y/2,p.z),height:scale.y,yaw:rand()*Math.PI*2});}
  // Separate instance bounds let the GPU skip whole offscreen tree clusters.
  const treeCells=new Map();for(const v of placements){const key=Math.floor(v.position.x/180)+':'+Math.floor(v.position.z/180);if(!treeCells.has(key))treeCells.set(key,[]);treeCells.get(key).push(v);}
  gltf.scene.traverse(o=>{if(!o.isMesh)return;const geometry=o.geometry.clone().applyMatrix4(o.matrixWorld);geometry.translate(-center.x,-bounds.min.y,-center.z);for(const cluster of treeCells.values()){const mesh=new THREE.InstancedMesh(geometry,o.material,cluster.length);mesh.castShadow=true;mesh.receiveShadow=true;
    cluster.forEach((v,i)=>{dummy.position.copy(v.position);dummy.rotation.set(0,v.yaw,0);dummy.scale.setScalar(v.height/Math.max(.1,height));dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);mesh.setColorAt(i,new THREE.Color().setRGB(.85+rand()*.15,.88+rand()*.12,.82+rand()*.18));});mesh.computeBoundingSphere();naturalTrees.add(mesh);}
  });
  gltf.scene.traverse(o=>{if(o.geometry)o.geometry.dispose();});
  // A distant terrain ring removes the artificial flat horizon without altering the roadway.
  const terrainGeometry=new THREE.PlaneGeometry(9000,9000,100,100);terrainGeometry.rotateX(-Math.PI/2);const tp=terrainGeometry.attributes.position;
  for(let i=0;i<tp.count;i++){const x=tp.getX(i),z=tp.getZ(i)+100,r=Math.sqrt(x*x+z*z),rise=THREE.MathUtils.smoothstep(r,1150,2600);const peaks=110+140*Math.pow(Math.sin(x*.0017+.3)*Math.cos(z*.0013),2)+65*Math.sin(x*.0021+z*.0011);tp.setY(i,-8.2+rise*peaks);}
  terrainGeometry.computeVertexNormals();const terrainMaterial=new THREE.MeshStandardMaterial({color:0x8b936e,roughness:1,map:grass.map});const terrain=new THREE.Mesh(terrainGeometry,terrainMaterial);terrain.receiveShadow=true;terrain.name='Distant terrain';scene.add(terrain);
  let previous='';
  function update(position){
    const detailed=settings.quality==='high'||settings.quality==='ultra',day=settings.time==='day',clear=settings.weather==='clear';
    naturalTrees.visible=detailed;oldTrees.forEach(o=>o.visible=!detailed);
    // Keep road reflectance in asphalt range instead of overexposed concrete white.
    track.roadMaterial.color.setHex(settings.weather==='snow'?0xe1e4e7:settings.weather==='rain'?0x687583:0x9ca3aa);
    track.grassMaterial.color.setHex(settings.weather==='snow'?0xf2f4f5:0xc4ceba);track.banks.material.color.setHex(settings.weather==='snow'?0xe3e8ea:0xb6c0ac);
    const useHDR=detailed&&day&&clear,condition=[settings.quality,settings.time,settings.weather].join(':');
    if(condition!==previous){previous=condition;scene.background=useHDR?hdr:null;scene.backgroundIntensity=useHDR?.65:1;sky.forEach(o=>o.visible=!useHDR);scene.userData.usePhotoHDR=useHDR;
      if(useHDR){hemi.forEach(l=>l.intensity=.6);suns.forEach(l=>{l.intensity=3.5;l.color.setHex(0xfff5e5);});}
      scene.environmentIntensity=settings.time==='night'?.23:settings.weather==='rain'?.55:.85;
      textures.forEach(t=>t.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),settings.quality==='ultra'?16:8));
    }
    // REFRESH_HDR_LIGHTS: atmosphere.apply also runs for unrelated settings.
    if(useHDR){hemi.forEach(l=>l.intensity=.6);suns.forEach(l=>{l.intensity=3.5;l.color.setHex(0xfff5e5);});}
    if(useHDR)suns.forEach(l=>{l.target.position.copy(position);l.position.copy(position).addScaledVector(sunDirection,95);l.target.updateMatrixWorld();});
  }
  update(track.start);notice('Scanned surfaces, sky and natural vegetation loaded',4000);
  return{update};
}
