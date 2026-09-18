// RELEASE_MODEL_1_0
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const WHEEL_CENTERS = [new THREE.Vector3(.8,-.22,1.77),new THREE.Vector3(-.8,-.22,1.77),new THREE.Vector3(.8,-.22,-1.77),new THREE.Vector3(-.8,-.22,-1.77)];

export function createCarVisual(scene, notice) {
  const root=new THREE.Group();scene.add(root);
  let wheels=[], assembly=new THREE.Group(), spinAngle=0, modelStatus='loading', loading=null, loadedQuality='';
  root.add(assembly);
  const navy=new THREE.MeshStandardMaterial({color:0x09192e,roughness:.4,metalness:.45});
  const red=new THREE.MeshStandardMaterial({color:0xd81e32,roughness:.4});
  const yellow=new THREE.MeshStandardMaterial({color:0xffcd24,roughness:.4});
  const rubber=new THREE.MeshStandardMaterial({color:0x101215,roughness:.97});
  function box(size,position,material,parent=assembly){const m=new THREE.Mesh(new THREE.BoxGeometry(...size),material);m.position.set(...position);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  box([1.38,.08,3.6],[0,-.49,-.05],navy);box([.73,.45,2.7],[0,-.23,-.5],navy);
  box([1.35,.37,1.75],[0,-.28,-.45],navy);box([.27,.19,2.35],[0,-.28,1.34],navy);
  box([1.91,.085,.58],[0,-.45,2.73],red);box([1.87,.08,.23],[0,-.32,2.54],navy);
  box([1.34,.13,.5],[0,.33,-2.18],navy);box([.1,.75,.33],[-.63,-.01,-2.18],navy);box([.1,.75,.33],[.63,-.01,-2.18],navy);
  box([.32,.08,.58],[0,-.13,2.44],yellow);box([.55,.13,.67],[0,.08,.32],rubber);
  const halo=new THREE.Mesh(new THREE.TorusGeometry(.37,.037,8,28),navy);halo.rotation.x=Math.PI/2;halo.position.set(0,.36,.22);assembly.add(halo);box([.05,.32,.05],[0,.21,.58],navy);
  const helmet=new THREE.Mesh(new THREE.SphereGeometry(.17,16,12),yellow);helmet.position.set(0,.25,.15);assembly.add(helmet);
  for(let i=0;i<4;i++){
    const pivot=new THREE.Group(),spin=new THREE.Group();pivot.position.copy(WHEEL_CENTERS[i]);pivot.add(spin);assembly.add(pivot);wheels.push({pivot,spin});
    const tyre=new THREE.Mesh(new THREE.CylinderGeometry(.375,.375,i<2?.39:.45,24),rubber);tyre.rotation.z=Math.PI/2;tyre.castShadow=true;spin.add(tyre);
    const rim=new THREE.Mesh(new THREE.CylinderGeometry(.225,.225,.46,16),navy);rim.rotation.z=Math.PI/2;spin.add(rim);
    for(const side of [-1,1]){const ring=new THREE.Mesh(new THREE.TorusGeometry(.297,.01,6,32),yellow);ring.rotation.y=Math.PI/2;ring.position.x=side*(i<2?.2:.23);spin.add(ring);box([.01,.035,.4],[side*.234,0,0],yellow,spin);}
  }
  const rearLight=new THREE.Mesh(new THREE.BoxGeometry(.09,.1,.04),new THREE.MeshBasicMaterial({color:0xff2525}));rearLight.position.set(0,-.32,-2.49);root.add(rearLight);
  function sync(suspension,steering,speed,dt,rotations){spinAngle=(spinAngle+speed*dt/.375)%(Math.PI*2);wheels.forEach((w,i)=>{w.pivot.position.y=-(suspension[i]??.22);w.pivot.rotation.y=i<2?steering:0;w.spin.rotation.x=Number.isFinite(rotations?.[i])?rotations[i]%(Math.PI*2):spinAngle;});}
  // Compact each subset rather than copying the entire car for every wheel.
  function subset(source,indexList){
    const ids=[],map=new Map(),out=[];
    for(const old of indexList){if(!map.has(old)){map.set(old,ids.length);ids.push(old);}out.push(map.get(old));}
    const result=new THREE.BufferGeometry();
    for(const [name,attribute] of Object.entries(source.attributes)){
      if(attribute.itemSize>4)continue;
      const values=new Float32Array(ids.length*attribute.itemSize);
      for(let j=0;j<ids.length;j++){const old=ids[j],o=j*attribute.itemSize;values[o]=attribute.getX(old);if(attribute.itemSize>1)values[o+1]=attribute.getY(old);if(attribute.itemSize>2)values[o+2]=attribute.getZ(old);if(attribute.itemSize>3)values[o+3]=attribute.getW(old);}
      result.setAttribute(name,new THREE.BufferAttribute(values,attribute.itemSize));
    }
    result.setIndex(out);result.computeBoundingSphere();return result;
  }
  async function loadModel(quality='standard'){
    if(loadedQuality===quality||loadedQuality==='ultra')return;
    if(loading){await loading;if(loadedQuality===quality||loadedQuality==='ultra')return;}
    let finish;loading=new Promise(resolve=>{finish=resolve;});
    if(quality==='ultra')notice('Loading full-resolution RB19 for Ultra…',0);
    const draco=new DRACOLoader().setDecoderPath(new URL('./vendor/three/examples/jsm/libs/draco/gltf/',import.meta.url).href);
    const loader=new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    const urls=[new URL(quality==='ultra'?'./assets/rb19-ultra.glb':'./assets/rb19.glb',import.meta.url).href];
    let gltf=null;
    try{
      for(const url of urls){try{gltf=await loader.loadAsync(url);break;}catch(error){console.warn('RB19 source unavailable:',url,error.message);}}
      if(!gltf){notice('RB19 download unavailable. The temporary car remains driveable.',12000);return;}
      gltf.scene.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(gltf.scene),size=bounds.getSize(new THREE.Vector3());
      if(size.z<=0)throw new Error('The car model has no measurable length.');
      const scale=5.53/size.z;
      const origin=new THREE.Vector3((bounds.min.x+bounds.max.x)/2,bounds.min.y+.376/scale,bounds.min.z+size.z*.44765);
      const next=new THREE.Group();const nextWheels=WHEEL_CENTERS.map(center=>{const pivot=new THREE.Group(),spin=new THREE.Group();pivot.position.copy(center);pivot.add(spin);next.add(pivot);return{pivot,spin};});
      gltf.scene.traverse(object=>{
        if(!object.isMesh||!object.geometry?.attributes.position)return;
        const geometry=object.geometry.clone();geometry.applyMatrix4(object.matrixWorld);geometry.translate(-origin.x,-origin.y,-origin.z);geometry.scale(scale,scale,scale);geometry.translate(0,-.22,0);
        const p=geometry.attributes.position,indices=geometry.index?.array??Uint32Array.from({length:p.count},(_,i)=>i),parts=[[],[],[],[],[]];
        for(let t=0;t+2<indices.length;t+=3){
          const tri=[indices[t],indices[t+1],indices[t+2]];let part=0;
          for(let w=0;w<4;w++){const c=WHEEL_CENTERS[w];if(tri.every(id=>Math.abs(p.getX(id)-c.x)<.275&&Math.abs(p.getY(id)-c.y)<.425&&Math.abs(p.getZ(id)-c.z)<.44)){part=w+1;break;}}
          parts[part].push(...tri);
        }
        const material=Array.isArray(object.material)?object.material[0]:object.material;
        if(material){material.envMapIntensity=.9;material.needsUpdate=true;}
        parts.forEach((list,part)=>{if(!list.length)return;const g=subset(geometry,list);if(part){const c=WHEEL_CENTERS[part-1];g.translate(-c.x,-c.y,-c.z);}if(!g.attributes.normal)g.computeVertexNormals();const mesh=new THREE.Mesh(g,material);mesh.castShadow=true;mesh.receiveShadow=true;(part?nextWheels[part-1].spin:next).add(mesh);});geometry.dispose();
      });
      const old=assembly;assembly=next;wheels=nextWheels;root.add(assembly);root.remove(old);
      const disposedGeometry=new Set(),disposedMaterial=new Set();old.traverse(o=>{if(o.geometry&&!disposedGeometry.has(o.geometry)){disposedGeometry.add(o.geometry);o.geometry.dispose();}if(o.material&&!disposedMaterial.has(o.material)){disposedMaterial.add(o.material);o.material.dispose();}});
      gltf.scene.traverse(o=>{if(o.geometry)o.geometry.dispose();});
      loadedQuality=quality;modelStatus=quality;notice(quality==='ultra'?'Full-resolution RB19 loaded':'RB19 loaded · drive with the pedals or W A S D',6000);
    }catch(error){console.warn(error);notice('RB19 loading was interrupted. The temporary car is available.',12000);}finally{draco.dispose();finish();loading=null;}
  }
  return{root,sync,loadModel,rearLight,get modelStatus(){return modelStatus;}};
}
