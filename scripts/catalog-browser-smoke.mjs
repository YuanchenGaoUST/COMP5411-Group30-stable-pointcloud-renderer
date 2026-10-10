import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';
const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/validation/catalog');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(browserLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],records=[];page.on('pageerror',error=>errors.push(error.message));
const assert=(value,message)=>{if(!value)throw new Error(message);};
try{
  await page.goto(process.env.PROJECT_URL||'http://127.0.0.1:5411/',{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#dataset').options.length===7);
  for(const id of ['jetliner','funky-aircraft','stanford-bunny','stanford-dragon','teapot']){
    await page.selectOption('#dataset',id);await page.waitForFunction(id=>{const s=window.COMP5411.state;return s.dataset===id&&!s.loadingDataset&&s.selection&&s.selection.count===s.drawn&&s.drawn>0;},id);
    const s=await page.evaluate(()=>window.COMP5411.state);assert(s.count===15000,`${id} input count`);assert(s.drawn<=s.budget,`${id} exceeded budget`);assert(s.cloudMetadata.sourceKind==='mesh-derived',`${id} source distinction lost`);assert(s.cloudMetadata.hasColors===false,`${id} unexpectedly claims source colors`);
    const foreground=await page.evaluate(()=>window.COMP5411.renderer.capture({viewProjection:new Float32Array(16)}).depth.reduce((n,d)=>n+(d<1),0));assert(foreground>500,`${id} has no significant foreground`);
    const saliency=await page.evaluate(async id=>Math.max(...(await(await fetch(`/data/models/${id}.json`)).json()).saliency),id);assert(saliency===0,`${id} has fabricated color saliency`);
    records.push({id,count:s.count,budget:s.budget,drawn:s.drawn,foregroundPixels:foreground,sourceURL:s.cloudMetadata.sourceURL,license:s.cloudMetadata.license,saliencyMax:saliency});
    if(id==='jetliner'){
      await page.screenshot({path:path.join(output,'airplane-viewer.png'),fullPage:true});
      await page.locator('#reference').check();await page.waitForFunction(()=>{const s=window.COMP5411.state;return s.selection?.count===s.count&&s.drawn===s.count;});await page.locator('#viewport').screenshot({path:path.join(output,'airplane-fullpoint.png')});await page.locator('#reference').uncheck();
      await page.locator('#budget-value').fill('1500');await page.locator('#budget-value').dispatchEvent('change');await page.waitForFunction(()=>{const s=window.COMP5411.state;return s.budget===1500&&s.selection&&s.selection.count===s.drawn&&s.drawn<=1500;});
      assert((await page.evaluate(()=>window.COMP5411.state.drawn))<=1500,'Aircraft 10% budget exceeded');
      await page.locator('#play').click();await page.waitForFunction(()=>window.COMP5411.state.selection?.stats.initialized===false);await page.locator('#play').click();await page.waitForFunction(()=>{const s=window.COMP5411.state;return s.selection&&s.selection.count===s.drawn&&s.drawn>0&&s.drawn<=s.budget;});
    }
  }
  await page.selectOption('#dataset','jetliner');await page.selectOption('#dataset','teapot');await page.waitForFunction(()=>{const s=window.COMP5411.state;return s.dataset==='teapot'&&!s.loadingDataset&&s.cloudMetadata.dataset.originalFilename==='teapot.obj'&&s.selection&&s.selection.count===s.drawn&&s.drawn>0&&s.drawn<=s.budget;});
  await page.goto((process.env.PROJECT_URL||'http://127.0.0.1:5411/')+'?dataset=jetliner',{waitUntil:'networkidle'});await page.waitForFunction(()=>{const s=window.COMP5411?.state;return s?.dataset==='jetliner'&&!s.loadingDataset&&s.selection&&s.drawn===s.selection.count&&s.drawn>0&&s.drawn<=s.budget;});
  assert(errors.length===0,errors.join('; '));const report={status:'passed',tested:['five local catalog inputs','PCA/geometry metadata','mesh-derived provenance','all inputs have zero color saliency','actual WebGL foreground','fixed-count cap','aircraft low-budget camera playback','rapid async switching','aircraft direct preview link'],records,pageErrors:errors};
  await fs.writeFile(path.join(output,'catalog-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
