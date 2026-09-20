import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base='https://lucka643.github.io/F1/';
const expected=await fs.readFile('index.html','utf8');
let published=false;
for(let attempt=0;attempt<24;attempt++){
  try{const response=await fetch(base+'index.html?deploy='+process.env.GITHUB_SHA,{cache:'no-store'});published=response.ok&&(await response.text())===expected;}catch{}
  if(published)break;await new Promise(resolve=>setTimeout(resolve,15000));
}
assert(published,'GitHub Pages has not published the committed index.html within six minutes');
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const errors=[],httpErrors=[];let data;
try{
  const context=await browser.newContext({viewport:{width:960,height:540},deviceScaleFactor:1});
  await context.addInitScript(()=>localStorage.setItem('f1-highway-preview-settings',JSON.stringify({quality:'medium',sound:false})));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('response',r=>{if(r.status()>=400)httpErrors.push({url:r.url(),status:r.status()});});
  await page.goto(base+'?build='+process.env.GITHUB_SHA,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__F1,{},{timeout:240000});
  await page.waitForFunction(()=>__F1.health().model==='standard',{},{timeout:180000});
  await page.locator('#start').click();await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>__F1.health().speed>15,{},{timeout:45000});await page.keyboard.up('KeyW');
  const moving=await page.evaluate(()=>__F1.health());await page.keyboard.press('KeyR');await page.waitForTimeout(1500);
  await page.locator('#menu').click();await page.locator('#quality').selectOption('ultra');await page.locator('#resume').click();
  await page.waitForFunction(()=>__F1.health().model==='ultra',{},{timeout:240000});await page.waitForTimeout(1500);
  const ultra=await page.evaluate(()=>__F1.health());assert(!ultra.failed);assert.equal(ultra.settings.quality,'ultra');assert(moving.speed>15);
  await fs.mkdir('live-check',{recursive:true});await page.screenshot({path:'live-check/live-ultra.png',timeout:120000});
  data={url:base,commit:process.env.GITHUB_SHA,testedAt:new Date().toISOString(),moving,ultra,errors,httpErrors,browser:'Chromium, Linux, software GPU'};
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(httpErrors.length,0,JSON.stringify(httpErrors));
  console.log('PASS deployed Pages: cold loading, RB19, acceleration, respawn, settings, full-resolution Ultra');
}finally{await browser.close();await fs.mkdir('live-check',{recursive:true});await fs.writeFile('live-check/result.json',JSON.stringify(data||{errors,httpErrors},null,2));}
