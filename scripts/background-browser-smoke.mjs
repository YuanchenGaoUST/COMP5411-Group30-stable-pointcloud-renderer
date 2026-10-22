// Real WebGL checks. SwiftShader provides reproducibility, not GPU benchmarks.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/local/backgrounds');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(browserLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const ready=background=>page.waitForFunction(id=>{
  const s=window.COMP5411?.state;
  return s?.dataset==='jetliner'&&!s.loadingDataset&&!s.backgroundLoading&&s.background===id
    &&s.drawn===7500&&s.selection?.stats.initialized===false;
},background);
// CPU wall times are deliberately excluded from deterministic result comparisons.
const withoutTimings=value=>Array.isArray(value)?value.map(withoutTimings):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!key.endsWith('Ms')).map(([key,v])=>[key,withoutTimings(v)])):value;

try{
  const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5411/');url.searchParams.set('dataset','jetliner');
  await page.goto(url.href,{waitUntil:'networkidle'});await ready('studio');
  const options=await page.locator('#background option').evaluateAll(elements=>elements.map(el=>el.value));
  check(JSON.stringify(options)===JSON.stringify(['studio','sky','technical','solid']),'Background choices or their default order changed');
  // Fixed camera + uniform selection avoid conflating EMA convergence with a UI change.
  await page.selectOption('#method','uniform');await page.locator('#stable').uncheck();await ready('studio');await frames();
  const placement=await page.evaluate(()=>{
    const selector=document.getElementById('background').getBoundingClientRect(),canvas=document.getElementById('viewport').getBoundingClientRect();
    return {aboveCanvas:selector.bottom<=canvas.top,defaultValue:document.getElementById('background').value};
  });
  check(placement.aboveCanvas,'Background choice is not visible above the canvas');

  const assets=await page.evaluate(async()=>Promise.all(['studio','sky','technical'].map(async id=>{
    const img=new Image();img.src=`/assets/backgrounds/${id}.jpg`;await img.decode();
    return {id,width:img.naturalWidth,height:img.naturalHeight};
  })));
  check(assets.every(asset=>asset.width>=256&&asset.height>=256),'A background image is absent or unexpectedly tiny');

  const backgrounds=[];
  for(const id of options){
    await page.selectOption('#background',id);await ready(id);await frames();
    const result=await page.evaluate(async id=>{
      const r=window.COMP5411.renderer,s=window.COMP5411.state,gl=r.gl;
      const capture=r.capture({viewProjection:new Float32Array(16)}),display=new Uint8Array(capture.rgba.length);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.readBuffer(gl.BACK);
      gl.readPixels(0,0,capture.width,capture.height,gl.RGBA,gl.UNSIGNED_BYTE,display);
      const ids=Array.from(s.selection.ids),before=window.backgroundSmokeBaseline;
      let changedBackgroundPixels=0,changedForegroundPixels=0,captureChanges=0,depthChanges=0,foregroundPixels=0,backgroundPixels=0;
      const palette=new Set();
      for(let pixel=0;pixel<capture.depth.length;pixel++){
        const offset=pixel*4,foreground=capture.depth[pixel]<1;
        if(foreground)foregroundPixels++;else{backgroundPixels++;if(pixel%17===0)palette.add(`${display[offset]},${display[offset+1]},${display[offset+2]}`);}
        if(before){
          let changed=false;
          for(let channel=0;channel<4;channel++){
            captureChanges+=Number(capture.rgba[offset+channel]!==before.capture.rgba[offset+channel]);
            changed||=display[offset+channel]!==before.display[offset+channel];
          }
          depthChanges+=Number(capture.depth[pixel]!==before.capture.depth[pixel]);
          if(changed){if(foreground)changedForegroundPixels++;else changedBackgroundPixels++;}
        }
      }
      if(!before)window.backgroundSmokeBaseline={capture,display,ids};
      // PNG export must contain the composited image, including the backdrop.
      const png=r.canvas.toDataURL('image/png'),img=new Image();img.src=png;await img.decode();
      const pngCanvas=document.createElement('canvas');pngCanvas.width=capture.width;pngCanvas.height=capture.height;
      const ctx=pngCanvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
      const decoded=ctx.getImageData(0,0,capture.width,capture.height).data;let pngMaxDelta=0;
      for(let y=0;y<capture.height;y++)for(let x=0;x<capture.width;x++)for(let channel=0;channel<4;channel++){
        const source=((capture.height-1-y)*capture.width+x)*4+channel,target=(y*capture.width+x)*4+channel;
        pngMaxDelta=Math.max(pngMaxDelta,Math.abs(decoded[target]-display[source]));
      }
      return {id,png,note:document.getElementById('background-note').textContent.trim(),captureChanges,depthChanges,
        changedBackgroundPixels,changedForegroundPixels,foregroundPixels,backgroundPixels,paletteSize:palette.size,
        sameIds:!before||JSON.stringify(ids)===JSON.stringify(before.ids),drawn:s.drawn,budget:s.budget,
        initialized:s.selection.stats.initialized,pngMaxDelta};
    },id);
    check(result.foregroundPixels>500&&result.backgroundPixels>500,`${id}: foreground or background is absent`);
    check(result.captureChanges===0&&result.depthChanges===0&&result.sameIds,`${id}: background changed experiment capture or selected point IDs`);
    check(result.changedForegroundPixels===0,`${id}: compositing changed foreground colors`);
    check(result.drawn===result.budget&&!result.initialized,`${id}: background reset selection or changed the point budget`);
    check(result.note.length>0,`${id}: background description is absent`);
    check(result.pngMaxDelta<=1,`${id}: PNG export does not match the displayed WebGL image`);
    if(id!=='studio')check(result.changedBackgroundPixels>result.backgroundPixels*.05,`${id}: visible backdrop did not change`);
    if(id!=='solid')check(result.paletteSize>32,`${id}: backdrop has too little variation to be the image`);
    await fs.writeFile(path.join(output,`background-${id}.png`),Buffer.from(result.png.split(',')[1],'base64'));
    delete result.png;backgrounds.push(result);
  }
  await page.selectOption('#background','studio');await ready('studio');await frames();
  await page.screenshot({path:path.join(output,'background-viewer.png'),fullPage:true});

  const experiments=[];
  for(const id of ['studio','sky']){
    await page.selectOption('#background',id);await ready(id);await frames();
    const experiment=await page.evaluate(async()=>{
      const r=window.COMP5411.renderer,draw=r.draw,observed=[];
      r.draw=function(camera,settings){observed.push(settings.background);return draw.call(this,camera,settings);};
      try{
        const task=window.COMP5411.runExperiment({samples:4,duration:.1,modes:['screen'],width:120,height:90});
        const selector=document.getElementById('background'),locked=selector.disabled,result=await task;
        return {locked,unlocked:!selector.disabled,rendering:result.rendering,observed,records:result.records};
      }finally{r.draw=draw;}
    });
    check(experiment.locked&&experiment.unlocked,'Experiment did not lock and restore the background control');
    check(experiment.rendering.background===id&&experiment.rendering.captureBackground==='legacy-solid','Experiment background metadata is missing or incorrect');
    check(experiment.observed.length===12&&experiment.observed.every(value=>value===id),'Experiment did not retain one display background snapshot');
    experiments.push(experiment);
  }
  check(JSON.stringify(withoutTimings(experiments[0].records))===JSON.stringify(withoutTimings(experiments[1].records)),
    'Background choice changed deterministic experiment metrics or selected-point statistics');
  const experiment={compared:['studio','sky'],identicalMetricsAndSelections:true,captureBackground:'legacy-solid',
    controlsLocked:experiments.every(item=>item.locked&&item.unlocked),drawsPerRun:experiments.map(item=>item.observed.length),
    recordsPerRun:experiments.map(item=>item.records.length)};

  await page.setViewportSize({width:390,height:844});await frames();
  const mobile=await page.evaluate(()=>{
    const selector=document.getElementById('background').getBoundingClientRect(),note=document.getElementById('background-note').getBoundingClientRect(),canvas=document.getElementById('viewport').getBoundingClientRect();
    return {viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,selectorLeft:selector.left,selectorRight:selector.right,
      noteLeft:note.left,noteRight:note.right,aboveCanvas:selector.bottom<=canvas.top};
  });
  check(mobile.documentWidth<=mobile.viewportWidth&&mobile.selectorLeft>=0&&mobile.selectorRight<=mobile.viewportWidth
    &&mobile.noteLeft>=0&&mobile.noteRight<=mobile.viewportWidth&&mobile.aboveCanvas,'Background controls overflow or move below the canvas on mobile');
  await page.screenshot({path:path.join(output,'background-mobile.png'),fullPage:true});
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const report={status:'passed',assets,placement,backgrounds,experiment,mobile,consoleErrors:errors,
    backend:'headless Chrome / SwiftShader; functionality checks only'};
  await fs.writeFile(path.join(output,'background-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
