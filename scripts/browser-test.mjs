import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.F1_TEST_URL||'http://127.0.0.1:8765/';
const dir='docs/tests';await fs.mkdir(dir,{recursive:true});
const results=[],errors=[],warnings=[],requests=[];
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
let current='boot';
async function instrument(context){
  await context.addInitScript(()=>{if(!localStorage.getItem('f1-highway-preview-settings'))localStorage.setItem('f1-highway-preview-settings',JSON.stringify({quality:'simple',sound:false}));});
  const page=await context.newPage();page.setDefaultTimeout(45000);
  page.on('pageerror',e=>{errors.push({test:current,type:'pageerror',text:e.stack||e.message});console.error('PAGE ERROR',e.message);});
  page.on('console',m=>{if(m.type()==='error'){errors.push({test:current,type:'console',text:m.text()});console.error('CONSOLE',m.text());}else if(m.type()==='warning')warnings.push({test:current,text:m.text()});});
  page.on('response',r=>{if(r.status()>=400){requests.push({url:r.url(),status:r.status()});console.error('HTTP',r.status(),r.url());}});
  page.on('requestfailed',r=>{if(!r.url().startsWith('blob:'))requests.push({url:r.url(),error:r.failure()?.errorText});});
  return page;
}
async function health(page){return page.evaluate(()=>window.__F1.health());}
async function settle(page,ms=500){await page.waitForTimeout(ms);const h=await health(page);assert(!h.failed,'Game entered failure state');assert(h.position.every(Number.isFinite));return h;}
async function shot(page,name){await page.screenshot({path:`${dir}/${name}.png`,timeout:120000});}
async function test(name,fn){current=name;const start=Date.now(),before=errors.length;console.log('START',name);try{const data=await fn();assert.equal(errors.length,before,'Browser errors in this test');results.push({name,passed:true,seconds:(Date.now()-start)/1000,data});console.log('PASS',name);}catch(e){results.push({name,passed:false,seconds:(Date.now()-start)/1000,error:e.stack||e.message});console.error('FAIL',name,e.message);}}
const context=await browser.newContext({viewport:{width:960,height:540},deviceScaleFactor:1});
const page=await instrument(context);
try{
  await test('Self-hosted boot and RB19 loading',async()=>{
    await page.goto(base+'?qa',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__F1Test||document.querySelector('#retry:not([hidden])'),{},{timeout:180000});
    assert(await page.evaluate(()=>!!window.__F1Test),await page.locator('#load-message').textContent());
    await page.waitForFunction(()=>window.__F1.health().model==='standard',{},{timeout:180000});
    await page.locator('#start').click();await settle(page,1500);await shot(page,'01-day');
    return health(page);
  });
  if(!await page.evaluate(()=>!!window.__F1Test))throw new Error('Boot failed; subsequent tests cannot run');
  await test('Keyboard acceleration, wheel spin and reset',async()=>{
    await page.keyboard.down('KeyW');await page.waitForFunction(()=>window.__F1.health().speed>20,{},{timeout:30000});await page.keyboard.up('KeyW');
    const driving=await health(page);assert(driving.wheelAngles.some(x=>Math.abs(x)>1));
    await page.keyboard.press('KeyR');const reset=await settle(page,900);assert(Math.abs(reset.speed)<2);return{driving,reset};
  });
  await test('Settings pause simulation and persist across reload',async()=>{
    await page.locator('#menu').click();const before=await health(page);await page.waitForTimeout(700);const after=await health(page);assert(Math.hypot(...after.position.map((v,i)=>v-before.position[i]))<.001);
    await page.locator('#grip').evaluate(e=>{e.value='1.3';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__F1Test,{},{timeout:180000});assert.equal((await health(page)).settings.grip,1.3);
    await page.locator('#start').click();await page.evaluate(()=>{__F1Test.manual(true);__F1Test.reset();__F1Test.step(240);__F1Test.settings({grip:1});});return health(page);
  });
  await test('All six camera presets render',async()=>{
    const cameras={};for(const camera of ['chase','close','tv','cockpit','nose','top']){await page.evaluate(camera=>__F1Test.settings({camera}),camera);cameras[camera]=(await settle(page,500)).camera;}
    assert(Math.hypot(...cameras.top.map((v,i)=>v-cameras.chase[i]))>5);
    await page.evaluate(()=>__F1Test.settings({camera:'chase'}));return cameras;
  });
  await test('Stationary orbit persists and driving restores the camera',async()=>{
    await settle(page,400);const before=await health(page);await page.mouse.move(480,220);await page.mouse.down();await page.mouse.move(650,250,{steps:10});await page.mouse.up();const orbit=await settle(page,800);assert(orbit.orbit);assert(Math.hypot(...orbit.camera.map((v,i)=>v-before.camera[i]))>.15);
    await page.mouse.wheel(0,-250);const zoom=await settle(page,600);assert(Math.hypot(...zoom.camera.map((v,i)=>v-orbit.camera[i]))>.1);
    await page.evaluate(()=>__F1Test.step(150,{throttle:1}));const driving=await settle(page,700);assert(!driving.orbit);await page.evaluate(()=>{__F1Test.reset();__F1Test.step(240);});return{orbit,zoom,driving};
  });
  await test('Simple Medium High and Ultra render without shader errors',async()=>{
    const modes={};for(const quality of ['simple','medium','high','ultra']){await page.evaluate(quality=>__F1Test.settings({quality}),quality);await settle(page,1200);if(quality==='ultra')await page.waitForFunction(()=>__F1.health().model==='ultra',{},{timeout:240000});modes[quality]=await settle(page,1500);}
    await shot(page,'02-ultra-day');return modes;
  });
  await test('Ultra rain and night lighting',async()=>{
    await page.evaluate(()=>__F1Test.settings({weather:'rain',time:'night'}));const night=await settle(page,2000);await shot(page,'03-ultra-rain-night');
    await page.evaluate(()=>__F1Test.settings({weather:'rain',time:'day'}));const day=await settle(page,2000);await shot(page,'04-ultra-rain-day');return{night,day};
  });
  await test('Snow, fog and sunset graphics',async()=>{
    await page.evaluate(()=>__F1Test.settings({quality:'high',weather:'snow',time:'sunset'}));const snow=await settle(page,1500);await shot(page,'05-snow-sunset');
    await page.evaluate(()=>__F1Test.settings({weather:'fog',time:'day'}));const fog=await settle(page,1000);await shot(page,'06-fog');return{snow,fog};
  });
  await test('Genuine path-traced Photo Mode produces samples and exits',async()=>{
    await page.setViewportSize({width:640,height:400});await page.evaluate(()=>{__F1Test.reset();__F1Test.step(240);__F1Test.settings({quality:'ultra',weather:'clear',time:'day'});});await settle(page,1500);
    const started=await page.evaluate(()=>__F1Test.photo());assert(started,'Ray tracer did not initialise');
    await page.waitForFunction(()=>__F1.health().samples>=2||__F1.health().failed,{},{timeout:300000});const photo=await health(page);assert(photo.photo&&!photo.failed&&photo.samples>=2);await shot(page,'07-ray-traced-photo');
    await page.locator('#photo-close').click();await settle(page,1500);assert(!(await health(page)).photo);await page.setViewportSize({width:960,height:540});return photo;
  });
  await test('Repeated settings changes and resets remain stable',async()=>{
    await page.evaluate(()=>__F1Test.settings({quality:'simple'}));
    for(let i=0;i<10;i++)await page.evaluate(i=>{__F1Test.reset();__F1Test.step(120);__F1Test.settings({weather:i%2?'rain':'clear',camera:i%2?'chase':'tv'});},i);
    const h=await settle(page);assert(h.contacts.every(Boolean));return h;
  });
  await context.close();
  const mobileContext=await browser.newContext({viewport:{width:844,height:390},deviceScaleFactor:1,isMobile:true,hasTouch:true});
  const mobile=await instrument(mobileContext);
  await test('Mobile landscape multitouch pedals and steering',async()=>{
    await mobile.goto(base+'?qa',{waitUntil:'domcontentloaded'});await mobile.waitForFunction(()=>window.__F1Test,{},{timeout:180000});await mobile.locator('#start').tap();await settle(mobile,1300);
    const gas=await mobile.locator('[data-control="throttle"]').boundingBox(),left=await mobile.locator('[data-control="left"]').boundingBox();const cdp=await mobileContext.newCDPSession(mobile);
    const points=[{x:gas.x+gas.width/2,y:gas.y+gas.height/2,id:1},{x:left.x+left.width/2,y:left.y+left.height/2,id:2}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});await mobile.waitForFunction(()=>Math.abs(__F1.health().steer)>.02&&Math.abs(__F1.health().speed)>3,{},{timeout:30000});const h=await health(mobile);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await mobile.locator('#reset').tap();await settle(mobile,800);await shot(mobile,'08-mobile-landscape');return h;
  });
  await test('Mobile portrait settings fit viewport',async()=>{
    await mobile.setViewportSize({width:390,height:844});await mobile.locator('#menu').tap();await mobile.locator('#weather').selectOption('snow');await mobile.locator('#resume').scrollIntoViewIfNeeded();await mobile.locator('#resume').tap();await shot(mobile,'09-mobile-portrait');
    const dimensions=await mobile.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(dimensions.scroll<=dimensions.width);return dimensions;
  });
  await mobileContext.close();
}catch(e){results.push({name:'Suite execution',passed:false,error:e.stack||e.message});console.error(e);try{await shot(page,'failure');}catch{}}
finally{
  await browser.close();
  const report={testedAt:new Date().toISOString(),browser:'Playwright Chromium 1.55.1; Linux; ANGLE SwiftShader software GPU',note:'This checks correctness, not real-device frame rate. iPhone Safari has not been physically tested.',tests:results,errors,warnings,requests};
  await fs.writeFile(`${dir}/browser.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,errors:errors.length,requests:requests.length}));
  if(results.some(r=>!r.passed)||errors.length||requests.length)process.exitCode=1;
}
