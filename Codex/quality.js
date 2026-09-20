import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/** Real-time raster pipeline and a separate, genuine path-traced photo renderer. */
export function createQualityPipeline(renderer, scene, camera, track, car, settings, notice) {
  let composer, beauty, reflections, ao, bloom, fxaa, pathTracer, photoScene;
  let photo = false, busy = false, generation = 0, lastCamera = new THREE.Matrix4();
  let traceEnvironment, traceModule, cubeClock = 10, lastSize = '';
  const coarse = matchMedia('(pointer:coarse)').matches;
  const hdr = !!renderer.extensions.get('EXT_color_buffer_float');
  const cubeTarget = new THREE.WebGLCubeRenderTarget(128, {type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter});
  const probe = new THREE.CubeCamera(.15, 6500, cubeTarget);
  const originalEnvironment = scene.environment;
  const photoBar = document.createElement('div'); photoBar.id='photo-bar'; photoBar.hidden=true;
  photoBar.innerHTML='<span id="photo-state" role="status">Preparing ray tracing…</span><button id="photo-save">Save photo</button><button id="photo-close">Return to driving</button>';
  document.body.append(photoBar);
  photoBar.querySelector('#photo-close').onclick=()=>leavePhoto();
  photoBar.querySelector('#photo-save').onclick=()=>{
    if (!photo || busy || !pathTracer || pathTracer.samples < 1) return;
    pathTracer.renderSample();
    renderer.domElement.toBlob(blob=>{if(!blob)return; const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='F1-Highway-Photo.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);},'image/png');
  };
  function build() {
    if (composer) return;
    const rt=new THREE.WebGLRenderTarget(1,1,{type:hdr?THREE.HalfFloatType:THREE.UnsignedByteType});
    composer=new EffectComposer(renderer,rt);
    beauty=new RenderPass(scene,camera);composer.addPass(beauty);
    reflections=new SSRPass({renderer,scene,camera,width:1,height:1,selects:[track.road]});
    reflections.opacity=.25;reflections.maxDistance=32;reflections.thickness=.12;reflections.blur=true;reflections.distanceAttenuation=true;reflections.fresnel=true;reflections.resolutionScale=coarse?.5:1;
    composer.addPass(reflections);
    ao=new GTAOPass(scene,camera,1,1);ao.output=GTAOPass.OUTPUT.Default;ao.blendIntensity=.65;
    ao.updateGtaoMaterial({radius:.9,thickness:.5,distanceExponent:1.5,distanceFallOff:1,samples:16});composer.addPass(ao);
    bloom=new UnrealBloomPass(new THREE.Vector2(1,1),.17,.25,1.1);composer.addPass(bloom);
    composer.addPass(new OutputPass());fxaa=new ShaderPass(FXAAShader);composer.addPass(fxaa);
  }
  function resize() {
    if (!composer) return;
    const size=renderer.getSize(new THREE.Vector2()),ratio=renderer.getPixelRatio(),id=[size.x,size.y,ratio].join(':');
    if(lastSize===id)return;lastSize=id;composer.setPixelRatio(ratio);composer.setSize(size.x,size.y);
    fxaa.uniforms.resolution.value.set(1/(size.x*ratio),1/(size.y*ratio));
    if(pathTracer)pathTracer.reset();
  }
  function apply() {
    if (settings.quality==='high'||settings.quality==='ultra') {
      if(!hdr){notice('This GPU does not support HDR targets. Using standard lighting.',8000);return;}
      build();const ultra=settings.quality==='ultra';
      beauty.enabled=!ultra;reflections.enabled=ultra;
      const targets=[track.road];car.root.traverse(o=>{if(o.isMesh)targets.push(o);});reflections.selects=targets;
      reflections.opacity=settings.weather==='rain'?.42:.16;
      ao.enabled=true;ao.blendIntensity=ultra?.68:.48;bloom.strength=settings.time==='night'?.24:.12;
      resize();
    } else scene.environment=originalEnvironment;
    cubeClock=10;
  }
  function updateProbe(dt) {
    if(settings.quality!=='ultra'||photo)return;
    cubeClock+=dt;if(cubeClock<1.4)return;cubeClock=0;
    const visible=car.root.visible,shadow=renderer.shadowMap.autoUpdate;
    car.root.visible=false;renderer.shadowMap.autoUpdate=false;
    probe.position.copy(car.root.position).add(new THREE.Vector3(0,1,0));
    const env=scene.environment;scene.environment=originalEnvironment;
    try{probe.update(renderer,scene);scene.environment=cubeTarget.texture;}
    finally{car.root.visible=visible;renderer.shadowMap.autoUpdate=shadow;if(!scene.environment)scene.environment=env;}
  }
  function snapshot() {
    const result=new THREE.Scene(),origin=car.root.position,temp=new THREE.Matrix4(),world=new THREE.Matrix4(),p=new THREE.Vector3();
    scene.updateMatrixWorld(true);
    scene.traverseVisible(o=>{
      if(o.isDirectionalLight){if(scene.userData.usePhotoHDR)return;const light=o.clone();light.position.setFromMatrixPosition(o.matrixWorld);light.target.position.setFromMatrixPosition(o.target.matrixWorld);result.add(light,light.target);return;}
      if(o.isPointLight||o.isSpotLight){p.setFromMatrixPosition(o.matrixWorld);if(p.distanceTo(origin)<130){const light=o.clone();light.position.copy(p);result.add(light);}return;}
      if(!o.isMesh||!o.geometry)return;
      const materials=Array.isArray(o.material)?o.material:[o.material];
      if(materials.some(m=>!m || !(m.isMeshStandardMaterial||m.isMeshPhysicalMaterial)))return;
      const add=matrix=>{const mesh=new THREE.Mesh(o.geometry,o.material);mesh.matrix.copy(matrix);mesh.matrixAutoUpdate=false;mesh.castShadow=true;mesh.receiveShadow=true;result.add(mesh);};
      if(o.isInstancedMesh){for(let i=0;i<o.count;i++){o.getMatrixAt(i,temp);world.multiplyMatrices(o.matrixWorld,temp);p.setFromMatrixPosition(world);if(p.distanceTo(origin)<160)add(world);}return;}
      add(o.matrixWorld);
    });
    const night=settings.time==='night',sunset=settings.time==='sunset';
    traceEnvironment=new traceModule.GradientEquirectTexture(256);
    traceEnvironment.topColor.set(night?0x14243e:sunset?0x8195ad:0x8fc4e9);
    traceEnvironment.bottomColor.set(night?0x10141b:sunset?0xc7a285:0x6e7761);traceEnvironment.exponent=1;traceEnvironment.update();
    result.environment=scene.userData.usePhotoHDR?scene.userData.photoEnvironment:traceEnvironment;result.background=result.environment;result.backgroundIntensity=.65;result.environmentIntensity=.85;
    return result;
  }
  async function enterPhoto() {
    if(busy||photo)return false;
    if(!hdr){notice('Ray tracing requires floating-point render targets on this GPU.',9000);return false;}
    if(Math.abs(car.speed||0)>1){notice('Stop the car before entering Photo Mode.',5000);return false;}
    busy=true;photo=true;const token=++generation;photoBar.hidden=false;document.body.classList.add('photo-mode');
    photoBar.querySelector('#photo-state').textContent='Preparing ray tracing…';
    await new Promise(resolve=>setTimeout(resolve,80));
    try{
      traceModule=await import('three-gpu-pathtracer');
      if(token!==generation)return false;
      pathTracer??=new traceModule.WebGLPathTracer(renderer);
      pathTracer.bounces=6;pathTracer.transmissiveBounces=3;pathTracer.filterGlossyFactor=.5;pathTracer.tiles.set(3,3);
      pathTracer.renderScale=coarse?.65:1;pathTracer.renderDelay=100;pathTracer.fadeDuration=250;pathTracer.minSamples=1;pathTracer.dynamicLowRes=true;pathTracer.lowResScale=.2;
      pathTracer.textureSize.set(coarse?1024:2048,coarse?1024:2048);
      if(traceEnvironment){traceEnvironment.dispose();traceEnvironment=null;}
      photoScene=snapshot();pathTracer.setScene(photoScene,camera);lastCamera.copy(camera.matrixWorld);busy=false;
      return true;
    }catch(error){busy=false;leavePhoto();notice('Ray tracing could not start on this GPU. Real-time Ultra remains available.',10000);console.warn('Photo renderer:',error.message);return false;}
  }
  function leavePhoto(){generation++;photo=busy=false;photoBar.hidden=true;document.body.classList.remove('photo-mode');if(pathTracer)pathTracer.reset();cubeClock=10;}
  function render(dt) {
    if(photo&&pathTracer&&!busy){
      camera.updateMatrixWorld();if(!lastCamera.equals(camera.matrixWorld)){pathTracer.updateCamera();lastCamera.copy(camera.matrixWorld);}
      pathTracer.renderSample();photoBar.querySelector('#photo-state').textContent=pathTracer.isCompiling?'Compiling ray-tracing shader…':'Ray-traced photo · '+Math.floor(pathTracer.samples)+' samples';
      return;
    }
    if(!photo)updateProbe(dt);
    if(composer&&hdr&&['high','ultra'].includes(settings.quality))composer.render(dt);else renderer.render(scene,camera);
  }
  return{apply,resize,render,enterPhoto,leavePhoto,get photo(){return photo;},get busy(){return busy;},get samples(){return pathTracer?.samples||0;}};
}
