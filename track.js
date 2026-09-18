import * as THREE from 'three';

// The integer vertices are extracted from Road2 meshes in the user's GLB.
// They store source coordinates * 16. Dividing by 64 gives metre-scale roads.
export async function createTrack(scene, world, R) {
  const response = await fetch(new URL('./assets/highway-road.b64', import.meta.url));
  if (!response.ok) throw new Error('Highway asset is missing (' + response.status + ')');
  const bytes = Uint8Array.from(atob((await response.text()).trim()), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const data = await new Response(stream).json();
  const vertices = data.v.map(v => new THREE.Vector3(v[0] / 64, v[1] / 64, v[2] / 64));
  const positions = new Float32Array(vertices.flatMap(v => v.toArray()));
  const indices = new Uint32Array(data.i);
  const triangles = [];
  const edges = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const [a,b,c] = ids.map(id => vertices[id]);
    const den = (b.z-c.z)*(a.x-c.x)+(c.x-b.x)*(a.z-c.z);
    if (Math.abs(den) > 1e-7) triangles.push({a,b,c,den,minX:Math.min(a.x,b.x,c.x),maxX:Math.max(a.x,b.x,c.x),minZ:Math.min(a.z,b.z,c.z),maxZ:Math.max(a.z,b.z,c.z)});
    for (let j = 0; j < 3; j++) {
      const x = ids[j], y = ids[(j+1)%3], key = Math.min(x,y)+':'+Math.max(x,y);
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key,{a:vertices[x],b:vertices[y],count:1});
    }
  }
  function heightAt(x,z,nearY=null) {
    let best = null, delta = Infinity;
    for (const t of triangles) {
      if (x < t.minX-.001 || x > t.maxX+.001 || z < t.minZ-.001 || z > t.maxZ+.001) continue;
      const u = ((t.b.z-t.c.z)*(x-t.c.x)+(t.c.x-t.b.x)*(z-t.c.z))/t.den;
      const v = ((t.c.z-t.a.z)*(x-t.c.x)+(t.a.x-t.c.x)*(z-t.c.z))/t.den;
      if (u < -.0001 || v < -.0001 || u+v > 1.0001) continue;
      const y = u*t.a.y+v*t.b.y+(1-u-v)*t.c.y;
      const d = nearY == null ? -y : Math.abs(y-nearY);
      if (d < delta) { best = y; delta = d; }
    }
    return best;
  }
  let seed = 192023;
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0) / 4294967296);
  function noiseTexture(base) {
    const canvas = document.createElement('canvas'); canvas.width=128;canvas.height=128;
    const context=canvas.getContext('2d');const image=context.createImageData(128,128);
    for(let i=0;i<image.data.length;i+=4){const n=(random()-.5)*18;image.data[i]=base[0]+n;image.data[i+1]=base[1]+n;image.data[i+2]=base[2]+n;image.data[i+3]=255;}
    context.putImageData(image,0,0);const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.colorSpace=THREE.SRGBColorSpace;return texture;
  }
  const asphalt=noiseTexture([101,105,111]);asphalt.anisotropy=4;
  const roadMaterial=new THREE.MeshStandardMaterial({map:asphalt,roughness:.93,metalness:.02,side:THREE.DoubleSide});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(vertices.flatMap(v=>[v.x*.42,v.z*.42]),2));geometry.computeVertexNormals();
  const road=new THREE.Mesh(geometry,roadMaterial);road.receiveShadow=true;scene.add(road);
  world.createCollider(R.ColliderDesc.trimesh(positions,indices).setFriction(1).setRestitution(.01));
  const grassTexture=noiseTexture([99,115,81]);grassTexture.repeat.set(400,400);
  const grassMaterial=new THREE.MeshStandardMaterial({map:grassTexture,roughness:1,color:0xc8d5ad,side:THREE.DoubleSide});
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(7000,7000),grassMaterial);ground.rotation.x=-Math.PI/2;ground.position.y=-8;ground.receiveShadow=true;scene.add(ground);
  world.createCollider(R.ColliderDesc.cuboid(3500,.3,3500).setTranslation(0,-8.3,0).setFriction(.7));
  const barrierMaterial=new THREE.MeshStandardMaterial({color:0xc3cad0,roughness:.85});
  const paintMaterial=new THREE.MeshStandardMaterial({color:0xf1ebd5,roughness:.95});
  const boundary=[];
  // Skip internal tile seams: only edges with road on one side get a wall.
  for(const edge of edges.values()){
    if(edge.count!==1)continue;
    const mid=edge.a.clone().add(edge.b).multiplyScalar(.5),dir=edge.b.clone().sub(edge.a);dir.y=0;const length=dir.length();if(length<.4)continue;dir.normalize();
    const normal=new THREE.Vector3(-dir.z,0,dir.x);
    const left=heightAt(mid.x+normal.x*.35,mid.z+normal.z*.35,mid.y);
    const right=heightAt(mid.x-normal.x*.35,mid.z-normal.z*.35,mid.y);
    const l=left!==null&&Math.abs(left-mid.y)<.6, r=right!==null&&Math.abs(right-mid.y)<.6;
    if(l===r)continue;
    if(l)normal.negate();
    boundary.push({mid,dir,normal,length,yaw:Math.atan2(dir.x,dir.z)});
  }
  const wallMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),barrierMaterial,boundary.length);
  const lineMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),paintMaterial,boundary.length);
  wallMesh.receiveShadow=true;wallMesh.castShadow=true;lineMesh.receiveShadow=true;
  const dummy=new THREE.Object3D(), embankment=[];
  boundary.forEach((e,i)=>{
    const pos=e.mid.clone().addScaledVector(e.normal,.16);pos.y+=.59;
    dummy.position.copy(pos);dummy.rotation.set(0,e.yaw,0);dummy.scale.set(.28,1.18,e.length+.08);dummy.updateMatrix();wallMesh.setMatrixAt(i,dummy.matrix);
    const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),e.yaw);
    world.createCollider(R.ColliderDesc.cuboid(.14,.59,e.length/2+.04).setTranslation(pos.x,pos.y,pos.z).setRotation(rotation).setFriction(.35).setRestitution(.07));
    dummy.position.copy(e.mid).addScaledVector(e.normal,-.28);dummy.position.y+=.025;dummy.scale.set(.09,.018,e.length);dummy.updateMatrix();lineMesh.setMatrixAt(i,dummy.matrix);
    // Broad banks connect the highway with the reduced-detail landscape.
    const a=e.mid.clone().addScaledVector(e.dir,-e.length/2),b=e.mid.clone().addScaledVector(e.dir,e.length/2);
    const c=b.clone().addScaledVector(e.normal,18),d=a.clone().addScaledVector(e.normal,18);c.y=d.y=-8;
    for(const v of [a,b,c,a,c,d])embankment.push(v.x,v.y-.04,v.z);
  });
  scene.add(wallMesh,lineMesh);
  const bankGeometry=new THREE.BufferGeometry();bankGeometry.setAttribute('position',new THREE.Float32BufferAttribute(embankment,3));bankGeometry.computeVertexNormals();
  const banks=new THREE.Mesh(bankGeometry,new THREE.MeshStandardMaterial({color:0x788664,roughness:1,side:THREE.DoubleSide}));banks.receiveShadow=true;scene.add(banks);
  // Scenery is deliberately lightweight in this preview. The road mesh above is not procedural.
  const scenery=[];
  for(let i=0;i<boundary.length;i+=5){const e=boundary[i];const p=e.mid.clone().addScaledVector(e.normal,32+random()*70);if(heightAt(p.x,p.z)!==null)continue;scenery.push({p,height:9+random()*35,width:10+random()*16});}
  const buildings=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:0xc0c8cd,roughness:.84}),scenery.length);
  scenery.forEach((s,i)=>{dummy.position.set(s.p.x,-8+s.height/2,s.p.z);dummy.rotation.set(0,Math.round(random()*4)*Math.PI/2,0);dummy.scale.set(s.width,s.height,s.width*(.7+random()*.7));dummy.updateMatrix();buildings.setMatrixAt(i,dummy.matrix);buildings.setColorAt(i,new THREE.Color().setHSL(.55+random()*.07,.04+random()*.08,.34+random()*.3));});buildings.castShadow=true;buildings.receiveShadow=true;scene.add(buildings);
  const trees=new THREE.InstancedMesh(new THREE.ConeGeometry(1,1,6),new THREE.MeshStandardMaterial({color:0x344f39,roughness:1}),300);
  for(let i=0;i<300;i++){const e=boundary[Math.floor(random()*boundary.length)];const p=e.mid.clone().addScaledVector(e.normal,20+random()*150);const h=7+random()*12;dummy.position.set(p.x,-8+h/2,p.z);dummy.rotation.set(0,random()*6.28,0);dummy.scale.set(h*.24,h,h*.24);if(heightAt(p.x,p.z)!==null)dummy.scale.setScalar(0);dummy.updateMatrix();trees.setMatrixAt(i,dummy.matrix);}scene.add(trees);
  const start=new THREE.Vector3(573.8,.1875,-87.5);
  const checker=document.createElement('canvas');checker.width=128;checker.height=32;const ctx=checker.getContext('2d');for(let y=0;y<2;y++)for(let x=0;x<8;x++){ctx.fillStyle=(x+y)%2?'#eef2ed':'#1c2533';ctx.fillRect(x*16,y*16,16,16);}
  const stripe=new THREE.Mesh(new THREE.PlaneGeometry(4,1),new THREE.MeshStandardMaterial({map:new THREE.CanvasTexture(checker),roughness:1}));stripe.rotation.x=-Math.PI/2;stripe.position.set(start.x,start.y+.028,start.z+4);scene.add(stripe);
  return {heightAt,start,roadMaterial,grassMaterial,banks,asphalt,road,boundary,triangles};
}
