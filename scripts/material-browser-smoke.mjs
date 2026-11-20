// Actual WebGL checks under SwiftShader, not native GPU performance measurements.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/local/materials');
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
    &&s.drawn===s.selection?.count&&s.drawn<=s.budget&&s.selection.stats.initialized===false;
},dataset);
// Wall-clock CPU timings are not deterministic; image metrics and selection are.
const withoutTimings=value=>Array.isArray(value)?value.map(withoutTimings):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!key.endsWith('Ms')).map(([key,v])=>[key,withoutTimings(v)])):value;

async function chooseMaterial(id){
  await page.selectOption('#material',id);await frames();
  await page.waitForFunction(value=>window.COMP5411.state.materialChoice===value,id);
}

// Store large typed arrays in the browser. Return only comparison summaries.
async function appearance(id,{baseline='original',store=false,png=false}={}){
  return page.evaluate(async({id,baseline,store,png})=>{
    const r=window.COMP5411.renderer,s=window.COMP5411.state;
    const capture=r.capture({viewProjection:new Float32Array(16)}),ids=Array.from(s.selection.ids);
    const input=r.data.slice(0,r.count*12),saved=window.materialSmokeCaptures??={};
    const previous=saved[baseline];
    let foregroundPixels=0,changedForegroundPixels=0,changedBackgroundPixels=0,depthChanges=0,rgbDelta=0;
    const meanRGB=[0,0,0];
    for(let pixel=0;pixel<capture.depth.length;pixel++){
      const foreground=capture.depth[pixel]<1,offset=pixel*4;
      if(foreground){foregroundPixels++;for(let c=0;c<3;c++)meanRGB[c]+=capture.rgba[offset+c];}
      if(previous){
        depthChanges+=Number(capture.depth[pixel]!==previous.capture.depth[pixel]);
        let changed=false;
        for(let c=0;c<3;c++){
          const delta=Math.abs(capture.rgba[offset+c]-previous.capture.rgba[offset+c]);
          changed||=delta>0;if(foreground)rgbDelta+=delta;
        }
        if(changed){if(foreground)changedForegroundPixels++;else changedBackgroundPixels++;}
      }
    }
    const result={id,effectiveMaterial:s.material,choice:s.materialChoice,drawn:s.drawn,budget:s.budget,
      foregroundPixels,changedForegroundPixels,changedBackgroundPixels,depthChanges,
      foregroundMeanRGB:meanRGB.map(v=>v/Math.max(1,foregroundPixels)),
      meanForegroundDifference:rgbDelta/Math.max(1,foregroundPixels*3),
      sameIds:!previous||JSON.stringify(ids)===JSON.stringify(previous.ids),
      sameUploadedAttributes:!previous||(input.length===previous.input.length&&input.every((v,i)=>v===previous.input[i]))};
    if(store)saved[id]={capture,ids,input};
    if(png){
      // The exported PNG must match the displayed canvas, including material and backdrop.
      const gl=r.gl,display=new Uint8Array(capture.rgba.length);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.readBuffer(gl.BACK);
      gl.readPixels(0,0,capture.width,capture.height,gl.RGBA,gl.UNSIGNED_BYTE,display);
      const dataURL=r.canvas.toDataURL('image/png'),img=new Image();img.src=dataURL;await img.decode();
      const canvas=document.createElement('canvas');canvas.width=capture.width;canvas.height=capture.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(img,0,0);
      const decoded=context.getImageData(0,0,capture.width,capture.height).data;let pngMaxDelta=0;
      for(let y=0;y<capture.height;y++)for(let x=0;x<capture.width;x++)for(let c=0;c<4;c++){
        const source=((capture.height-1-y)*capture.width+x)*4+c,target=(y*capture.width+x)*4+c;
        pngMaxDelta=Math.max(pngMaxDelta,Math.abs(decoded[target]-display[source]));
      }
      result.png=dataURL;result.pngMaxDelta=pngMaxDelta;
    }
    return result;
  },{id,baseline,store,png});
}

try{
  const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5411/');url.searchParams.set('dataset','jetliner');
  await page.goto(url.href,{waitUntil:'networkidle'});await ready('jetliner');
  const initial=await page.evaluate(()=>window.COMP5411.state);
  check(initial.materialChoice==='auto'&&initial.material==='azure'&&initial.cloudMetadata.hasColors===false,
    'Auto must choose the blue presentation finish for an explicitly uncolored input');
  const choices=await page.locator('#material option').evaluateAll(elements=>elements.map(el=>el.value));
  check(JSON.stringify(choices)===JSON.stringify(['auto','original','azure','copper','jade']),'Material choices are incomplete or their default changed');
  const placement=await page.evaluate(()=>{
    const selector=document.getElementById('material').getBoundingClientRect(),canvas=document.getElementById('viewport').getBoundingClientRect();
    return {aboveCanvas:selector.bottom<=canvas.top};
  });
  check(placement.aboveCanvas,'Material choice is not above the canvas');
  await page.selectOption('#method','uniform');await page.locator('#stable').uncheck();await ready('jetliner');await frames();

  const materials=[];
  for(const id of ['original','azure','copper','jade']){
    await chooseMaterial(id);
    const result=await appearance(id,{store:true,png:true});
    check(result.effectiveMaterial===id&&result.choice===id,`${id}: selected material is not applied`);
    check(result.foregroundPixels>500&&result.drawn===7500,`${id}: missing foreground or changed draw count`);
    check(result.depthChanges===0&&result.sameIds&&result.sameUploadedAttributes,`${id}: material changed geometry, input attributes, or selected IDs`);
    check(result.changedBackgroundPixels===0,`${id}: material altered capture background`);
    check(result.pngMaxDelta<=1,`${id}: PNG export differs from the displayed material`);
    if(id!=='original')check(result.changedForegroundPixels>result.foregroundPixels*.25&&result.meanForegroundDifference>5,
      `${id}: styled appearance did not meaningfully change the foreground`);
    await fs.writeFile(path.join(output,`jetliner-${id}.png`),Buffer.from(result.png.split(',')[1],'base64'));
    delete result.png;materials.push(result);
  }
  // Each finish has a visibly different palette, not just a different label.
  check(materials[1].foregroundMeanRGB[2]>materials[1].foregroundMeanRGB[0],'Azure is not blue-dominant');
  check(materials[2].foregroundMeanRGB[0]>materials[2].foregroundMeanRGB[2],'Copper is not warm-dominant');
  check(materials[3].foregroundMeanRGB[1]>materials[3].foregroundMeanRGB[0],'Jade is not green-dominant');
  await chooseMaterial('original');
  const restored=await appearance('original-restored');
  check(restored.changedForegroundPixels===0&&restored.depthChanges===0&&restored.sameUploadedAttributes,
    'Returning to Original does not restore its exact image');

  await chooseMaterial('azure');
  const highlight=await page.evaluate(async()=>{
    const r=window.COMP5411.renderer,draw=r.draw;
    // Capture the next real viewer camera/settings, then compare the same draw
    // with and without its specular term. No geometry or camera changes occur.
    const observed=await new Promise(resolve=>{
      r.draw=function(camera,settings){
        r.draw=draw;draw.call(this,camera,settings);resolve({camera,settings});
      };
    });
    const {camera,settings}=observed;
    r.draw(camera,{...settings,material:{...settings.material,specularStrength:0}});
    const diffuse=r.capture(camera);r.draw(camera,settings);const styled=r.capture(camera);
    let changedForegroundPixels=0,depthChanges=0;
    for(let p=0;p<styled.depth.length;p++){
      depthChanges+=Number(styled.depth[p]!==diffuse.depth[p]);
      if(styled.depth[p]<1&&[0,1,2].some(c=>styled.rgba[p*4+c]!==diffuse.rgba[p*4+c]))changedForegroundPixels++;
    }
    return {changedForegroundPixels,depthChanges};
  });
  check(highlight.changedForegroundPixels>100&&highlight.depthChanges===0,'The material highlight is absent or changed geometry');

  const diagnostics=[];
  for(const mode of ['1','2']){
    await page.selectOption('#colors',mode);await frames();await chooseMaterial('original');
    await appearance(`diagnostic-${mode}`,{store:true});
    for(const id of ['azure','copper','jade']){
      await chooseMaterial(id);const result=await appearance(id,{baseline:`diagnostic-${mode}`});
      check(result.changedForegroundPixels===0&&result.depthChanges===0,`${id}: material changed diagnostic color mode ${mode}`);
      diagnostics.push({mode,id,identicalImage:true});
    }
  }
  await page.selectOption('#colors','0');await chooseMaterial('azure');
  // The real export button must download a valid rendered image.
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-frame').click();
  const download=await downloadPromise,exportPath=path.join(output,'exported-material-frame.png');
  await download.saveAs(exportPath);const exported=await fs.readFile(exportPath);
  check(exported.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&exported.length>1000,
    'Save frame did not export a valid PNG');
  await page.screenshot({path:path.join(output,'material-viewer.png'),fullPage:true});

  // Auto follows source metadata; an explicit user choice survives input changes.
  await chooseMaterial('auto');await page.selectOption('#dataset','synthetic');await ready('synthetic');
  const colored=await page.evaluate(()=>window.COMP5411.state);
  check(colored.materialChoice==='auto'&&colored.material==='original','Auto overwrote synthetic source colors');
  await chooseMaterial('original');await page.selectOption('#dataset','jetliner');await ready('jetliner');
  const explicit=await page.evaluate(()=>window.COMP5411.state);
  check(explicit.materialChoice==='original'&&explicit.material==='original','Changing inputs overwrote an explicit Original choice');
  await chooseMaterial('auto');await frames();
  check(await page.evaluate(()=>window.COMP5411.state.material==='azure'),'Auto did not restore the uncolored-input finish');

  const experiments=[];
  for(const id of ['original','copper']){
    await chooseMaterial(id);await ready('jetliner');
    const experiment=await page.evaluate(async()=>{
      const r=window.COMP5411.renderer,draw=r.draw,observed=[];
      r.draw=function(camera,settings){observed.push({material:settings.material?.id,edlStrength:settings.edlStrength,sunlight:settings.sunlight});return draw.call(this,camera,settings);};
      try{
        const task=window.COMP5411.runExperiment({samples:4,duration:.1,modes:['screen'],width:120,height:90});
        const controls=['material','background','sun-azimuth','sun-elevation','sun-intensity'];
        const locked=controls.every(id=>document.getElementById(id).disabled),result=await task;
        return {locked,unlocked:controls.every(id=>!document.getElementById(id).disabled),rendering:result.rendering,
          presentationRendering:result.presentationRendering,observed,records:result.records};
      }finally{r.draw=draw;}
    });
    check(experiment.locked&&experiment.unlocked,'Experiment did not lock and restore presentation controls');
    check(experiment.rendering.material?.id==='original'&&experiment.rendering.edlStrength===14,
      'Experiment did not record the original measurement shader and EDL strength');
    check(experiment.presentationRendering?.material?.id===id,'Requested presentation material is missing from experiment metadata');
    check(experiment.observed.length===12&&experiment.observed.every(draw=>draw.material==='original'&&draw.edlStrength===14),
      'An experiment draw used presentation shading');
    check(experiment.observed.every(draw=>JSON.stringify(draw.sunlight)===JSON.stringify(experiment.presentationRendering.sunlight)),
      'Experiment failed to retain the selected sunlight snapshot');
    experiments.push(experiment);
  }
  check(JSON.stringify(withoutTimings(experiments[0].records))===JSON.stringify(withoutTimings(experiments[1].records)),
    'Presentation finish changed deterministic experiment metrics or selection statistics');
  const experiment={compared:['original','copper'],identicalMetricsAndSelections:true,actualMaterial:'original',edlStrength:14,
    requestedMaterials:experiments.map(item=>item.presentationRendering.material.id),controlsLocked:true,
    drawsPerRun:experiments.map(item=>item.observed.length)};
  await chooseMaterial('auto');await ready('jetliner');

  await page.setViewportSize({width:390,height:844});await frames();
  const mobile=await page.evaluate(()=>{
    const selector=document.getElementById('material').getBoundingClientRect(),canvas=document.getElementById('viewport').getBoundingClientRect();
    return {viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,selectorLeft:selector.left,
      selectorRight:selector.right,aboveCanvas:selector.bottom<=canvas.top};
  });
  check(mobile.documentWidth<=mobile.viewportWidth&&mobile.selectorLeft>=0&&mobile.selectorRight<=mobile.viewportWidth&&mobile.aboveCanvas,
    'Material controls overflow or move below the canvas on mobile');
  await page.screenshot({path:path.join(output,'material-mobile.png'),fullPage:true});
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const report={status:'passed',placement,materials,highlight,diagnostics,sourceAwareAuto:{uncolored:'azure',colored:'original',explicitOriginalRetained:true},
    pngExport:{buttonDownload:true,filename:download.suggestedFilename()},experiment,mobile,consoleErrors:errors,
    backend:'headless Chrome / SwiftShader; functionality checks only'};
  await fs.writeFile(path.join(output,'material-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
