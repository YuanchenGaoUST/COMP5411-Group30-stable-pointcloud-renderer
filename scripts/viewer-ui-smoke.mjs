// Real application checks in an isolated browser. SwiftShader timings are not GPU benchmarks.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/local/viewer-ui');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(browserLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const ready=dataset=>page.waitForFunction(id=>{
  const s=window.COMP5411?.state;
  return s?.dataset===id&&!s.loadingDataset&&!s.backgroundLoading&&!s.busy&&s.drawn>0
    &&s.selection?.count===s.drawn&&s.drawn<=s.budget;
},dataset);
const isOpen=id=>page.locator(`#${id}`).evaluate(el=>el.open);
async function openDetails(id){if(!await isOpen(id))await page.locator(`#${id}>summary`).click();}
async function closeDetails(id){if(await isOpen(id))await page.locator(`#${id}>summary`).click();}
async function expectPlayback(playing){
  check((await page.locator('#play').getAttribute('aria-pressed'))===String(playing),`Playback pressed state is not ${playing}`);
  check((await page.locator('#play').innerText()).trim()===(playing?'Pause path':'Play path'),'Playback button label is stale');
}
async function layout(){
  return page.evaluate(()=>{
    const rect=id=>document.getElementById(id).getBoundingClientRect();
    const canvas=rect('viewport'),background=rect('background'),material=rect('material');
    return {viewport:innerWidth,document:document.documentElement.scrollWidth,headerHeight:document.querySelector('header').getBoundingClientRect().height,
      canvasWidth:canvas.width,canvasHeight:canvas.height,selectorsAboveCanvas:background.bottom<=canvas.top&&material.bottom<=canvas.top,
      selectorsInViewport:[background,material].every(r=>r.left>=0&&r.right<=innerWidth),
      sunlightOverflow:document.querySelector('.sunlight-panel').scrollWidth>document.querySelector('.sunlight-panel').clientWidth};
  });
}
function checkLayout(value,name){
  check(value.document<=value.viewport,`${name}: document has horizontal overflow`);
  check(value.selectorsAboveCanvas&&value.selectorsInViewport,`${name}: presentation selectors misplaced`);
  check(!value.sunlightOverflow,`${name}: sunlight panel overflows`);
  check(value.canvasHeight>=300&&value.canvasWidth>250,`${name}: canvas is too small`);
}

try{
  const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5411/');url.searchParams.set('dataset','jetliner');
  await page.goto(url.href,{waitUntil:'networkidle'});await ready('jetliner');await frames();
  const initial=await page.evaluate(()=>window.COMP5411.state);
  check(initial.count===15000&&initial.budget===7500,'Aircraft input or preview budget changed');
  check(initial.material==='azure'&&initial.materialChoice==='auto','Source-aware default material changed');
  check(await page.locator('.live-dot').count()===0,'Decorative live badge remains');
  const disclosureIds=['quickstart','stability-options','input-details'];
  check(await page.locator('#display-notes, #background-note, #material-note').count()===0,'Removed display notes remain in the interface');
  for(const id of disclosureIds)check(!await isOpen(id),`${id} should start collapsed`);
  const desktop=await layout();checkLayout(desktop,'desktop');check(desktop.headerHeight<=100,'Header still dominates the page');
  await page.screenshot({path:path.join(output,'viewer-desktop.png'),fullPage:true});

  // Native disclosure controls must work from the keyboard, not just with a mouse.
  await page.locator('#quickstart>summary').focus();await page.keyboard.press('Enter');
  check(await isOpen('quickstart'),'How to use cannot be expanded from the keyboard');
  const guide=await page.locator('#quickstart').innerText();
  check(/budget/i.test(guide)&&/reference/i.test(guide)&&/compar/i.test(guide),'Quick guide omits essential usage or the reference distinction');
  await page.keyboard.press('Enter');check(!await isOpen('quickstart'),'How to use cannot be collapsed from the keyboard');
  await openDetails('input-details');
  check(await page.locator('#feature-note').isVisible(),'Input feature caveat is not accessible');
  check(/no source colors/i.test(await page.locator('#feature-note').innerText()),'Uncolored-input limitation was removed');
  check((await page.locator('#dataset-source').innerText()).length>0,'Input provenance was removed');
  await closeDetails('input-details');
  const attribution=await fs.readFile(new URL('../docs/AI_USAGE.md',import.meta.url),'utf8');
  check(/AI-generated decorative backgrounds/i.test(attribution),'Backdrop attribution is missing from project documentation');
  check(/Original material/i.test(attribution),'Measurement material policy is missing from project documentation');

  await page.locator('#budget-value').fill('3000');await page.locator('#budget-value').dispatchEvent('change');
  await page.waitForFunction(()=>window.COMP5411.state.budget===3000&&window.COMP5411.state.drawn<=3000);
  const methods=[];
  for(const method of ['uniform','screen','geometry','full']){
    await page.selectOption('#method',method);await ready('jetliner');await frames();
    const s=await page.evaluate(()=>window.COMP5411.state);
    check(s.drawn>0&&s.drawn<=3000,`${method}: invalid drawn count`);methods.push({method,drawn:s.drawn});
  }
  await openDetails('stability-options');
  check(await page.locator('#quota').isVisible()&&await page.locator('#margin').isVisible(),'Advanced stability controls cannot be reached');
  await page.locator('#quota').fill('0');await page.locator('#quota').dispatchEvent('change');
  await page.waitForFunction(()=>window.COMP5411.state.selection?.stats.swaps===0);
  check((await page.locator('#quota-value').innerText()).trim()==='0%','Advanced quota value does not update');
  await page.locator('#quota').fill('10');await page.locator('#quota').dispatchEvent('change');await closeDetails('stability-options');

  await expectPlayback(false);await page.locator('#play').click();await expectPlayback(true);
  await page.locator('#play').click();await expectPlayback(false);
  await page.locator('#play').click();await expectPlayback(true);
  await page.locator('#viewport').click({position:{x:120,y:100}});await expectPlayback(false);
  await page.locator('#play').click();await page.locator('#viewport').hover();await page.mouse.wheel(0,60);await frames();await expectPlayback(false);
  await page.locator('#play').click();await page.locator('#reset').click();await expectPlayback(false);
  await page.locator('#play').click();await page.selectOption('#dataset','synthetic');await ready('synthetic');await expectPlayback(false);
  check((await page.evaluate(()=>window.COMP5411.state.material))==='original','Colored scene lost its source colors');
  await page.selectOption('#dataset','jetliner');await ready('jetliner');await frames();

  const pngPromise=page.waitForEvent('download');await page.locator('#export-frame').click();
  const pngDownload=await pngPromise,pngPath=path.join(output,'saved-frame.png');await pngDownload.saveAs(pngPath);
  const png=await fs.readFile(pngPath);
  check(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&png.length>1000,'Save frame failed');
  await page.locator('#play').click();await expectPlayback(true);
  const experiment=await page.evaluate(async()=>{
    const ids=['dataset','budget','method','stable','quota','margin','background','material','sun-azimuth','play','reset','experiment'];
    const task=window.COMP5411.runExperiment({samples:4,duration:.1,width:120,height:90});
    const locked=ids.every(id=>document.getElementById(id).disabled);
    const stopped=document.getElementById('play').getAttribute('aria-pressed')==='false';
    const result=await task;
    return {locked,stopped,unlocked:ids.every(id=>!document.getElementById(id).disabled),
      records:result.records.map(r=>({mode:r.mode,stable:r.stable,maxCount:r.summary.maxCount,maeRgb:r.summary.maeRgb})),
      material:result.rendering.material.id,budget:result.budget};
  });
  check(experiment.locked&&experiment.unlocked&&experiment.stopped,'Experiment did not lock controls, stop playback, and restore controls');
  check(experiment.records.length===7&&experiment.material==='original','Experiment variants or measurement policy changed');
  check(experiment.records.every(r=>Number.isFinite(r.maeRgb)&&r.maxCount<=experiment.budget),'Experiment produced invalid metrics/counts');
  await expectPlayback(false);
  check(await page.locator('#result-table tbody tr').count()===7,'Result table is missing variants');
  const desktopResults=await layout();checkLayout(desktopResults,'desktop results');
  await page.screenshot({path:path.join(output,'viewer-desktop-results.png'),fullPage:true});
  const jsonPromise=page.waitForEvent('download');await page.locator('#export-results').click();
  const jsonDownload=await jsonPromise,jsonPath=path.join(output,'exported-results.json');await jsonDownload.saveAs(jsonPath);
  check(JSON.parse(await fs.readFile(jsonPath,'utf8')).records.length===7,'Results JSON export is invalid');

  await page.setViewportSize({width:390,height:844});await frames();
  const mobileResults=await layout();checkLayout(mobileResults,'mobile results');
  await page.screenshot({path:path.join(output,'viewer-mobile-results.png'),fullPage:true});
  for(const id of disclosureIds)await openDetails(id);
  const mobileExpanded=await layout();checkLayout(mobileExpanded,'mobile expanded disclosures');
  check(await page.locator('#quota').isVisible()&&await page.locator('#feature-note').isVisible(),'Mobile disclosure content is inaccessible');
  await page.screenshot({path:path.join(output,'viewer-mobile-expanded.png'),fullPage:true});
  await page.goto(url.href,{waitUntil:'networkidle'});await ready('jetliner');await frames();
  const mobile=await layout();checkLayout(mobile,'mobile');
  await page.screenshot({path:path.join(output,'viewer-mobile.png'),fullPage:true});
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const report={status:'passed',initial:{count:initial.count,budget:initial.budget,material:initial.material},desktop,mobile,desktopResults,mobileResults,mobileExpanded,
    keyboardGuide:true,accessibleAdvancedControls:true,provenanceRetained:true,methods,
    playbackFeedback:['play/pause','canvas pointer','canvas wheel','reset','dataset change','experiment'],experiment,
    exports:{png:pngDownload.suggestedFilename(),json:jsonDownload.suggestedFilename()},consoleErrors:errors,
    backend:'headless Chrome / SwiftShader; functionality checks only, not native GPU performance'};
  await fs.writeFile(path.join(output,'viewer-ui-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
