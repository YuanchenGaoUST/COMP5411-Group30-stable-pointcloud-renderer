// Actual point-view functionality checks; SwiftShader is not native-GPU profiling.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/local/point-view');
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
    &&s.drawn===s.selection?.count&&s.drawn<=s.budget;
},dataset);
async function chooseView(view){
  await page.locator(view==='points'?'#view-points':'#view-surface').click();
  await page.waitForFunction(value=>window.COMP5411.state.view===value,view);await frames();
  for(const id of ['points','surface'])check(await page.locator(`#view-${id}`).getAttribute('aria-pressed')===String(view===id),`${id}: stale pressed state`);
}
async function capture(label){
  return page.evaluate(label=>{
    const s=window.COMP5411.state,r=window.COMP5411.renderer,c=r.capture({viewProjection:new Float32Array(16)});
    const samples=window.pointViewCaptures??={};
    const result={view:s.view,count:s.count,drawn:s.drawn,budget:s.budget,foreground:c.depth.reduce((n,d)=>n+(d<1),0),ids:Array.from(s.selection.ids)};
    samples[label]={rgba:c.rgba,depth:c.depth,input:r.data.slice(0,r.count*12),ids:result.ids};return result;
  },label);
}
async function layout(){
  return page.evaluate(()=>{
    const ids=['view-points','view-surface','background','material'];
    const canvas=document.getElementById('viewport').getBoundingClientRect();
    return {viewport:innerWidth,document:document.documentElement.scrollWidth,
      controlsWithinViewport:ids.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),
      togglesAboveCanvas:['view-points','view-surface'].every(id=>document.getElementById(id).getBoundingClientRect().bottom<=canvas.top),
      labelPx:parseFloat(getComputedStyle(document.querySelector('label:has(#dataset)')).fontSize),
      canvasWidth:canvas.width,canvasHeight:canvas.height};
  });
}
function checkLayout(value,label){
  check(value.document<=value.viewport&&value.controlsWithinViewport&&value.togglesAboveCanvas,`${label}: horizontal overflow or misplaced controls`);
  check(value.labelPx>=13,`${label}: primary label remains smaller than 13px`);
  check(value.canvasWidth>250&&value.canvasHeight>=300,`${label}: canvas too small`);
}

try{
  const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5411/');url.searchParams.set('dataset','jetliner');url.searchParams.delete('view');
  await page.goto(url.href,{waitUntil:'networkidle'});await ready('jetliner');await frames();
  check(await page.locator('#display-notes,#background-note,#material-note').count()===0,'Removed display-note elements remain in the DOM');
  check(!/Display notes/.test(await page.locator('body').innerText()),'Display notes text is still visible');
  check(await page.evaluate(()=>window.COMP5411.state.view==='surface'),'Default view should preserve the surface view');
  const desktop=await layout();checkLayout(desktop,'desktop');
  await page.selectOption('#method','uniform');await page.locator('#stable').uncheck();await ready('jetliner');await frames();
  const surface=await capture('surface');
  await page.screenshot({path:path.join(output,'surface-desktop.png'),fullPage:true});
  await chooseView('points');
  check(await page.locator('#point-size').isVisible(),'Point-size control is not reachable');
  check(await page.locator('#primitive').isDisabled()&&await page.locator('#radius').isDisabled()&&await page.locator('#edl').isDisabled(),'Surface-only controls remain active in point view');
  for(const id of ['sun-azimuth','sun-elevation','sun-intensity','sun-reset'])check(await page.locator(`#${id}`).isDisabled(),`${id}: light controls should be inactive in unlit point view`);
  await page.locator('#point-size').fill('2');await page.locator('#point-size').dispatchEvent('input');await frames();
  const points=await capture('points');
  check(points.drawn===surface.drawn&&points.budget===surface.budget&&JSON.stringify(points.ids)===JSON.stringify(surface.ids),'Switching point view changed point selection or budget');
  const dataPreserved=await page.evaluate(()=>{
    const {surface,points}=window.pointViewCaptures;
    return surface.input.length===points.input.length&&surface.input.every((v,i)=>v===points.input[i]);
  });
  check(dataPreserved,'Point view modified uploaded point attributes');
  check(points.foreground>500&&points.foreground<surface.foreground*.85,'Point view does not visibly resolve smaller point footprints');
  await page.screenshot({path:path.join(output,'point-cloud-desktop.png'),fullPage:true});
  await page.locator('#viewport').screenshot({path:path.join(output,'point-cloud-frame.png')});
  await page.locator('#point-size').fill('6');await page.locator('#point-size').dispatchEvent('input');await frames();
  const larger=await capture('larger');
  check(larger.foreground>points.foreground*1.3&&JSON.stringify(larger.ids)===JSON.stringify(points.ids),'Point-size control does not enlarge dots independently of selection');
  await page.locator('#point-size').fill('2');await page.locator('#point-size').dispatchEvent('input');await frames();
  await page.locator('#reference').check();await page.waitForFunction(()=>{const s=window.COMP5411.state;return s.drawn===s.count;});
  const reference=await page.evaluate(()=>({view:window.COMP5411.state.view,drawn:window.COMP5411.state.drawn,count:window.COMP5411.state.count}));
  check(reference.view==='points'&&reference.drawn===15000,'Point view cannot display the full input reference');
  await page.locator('#reference').uncheck();await ready('jetliner');
  await chooseView('surface');
  check(await page.locator('#primitive').isEnabled()&&await page.locator('#sun-azimuth').isEnabled(),'Returning to surface did not restore controls');
  const restored=await capture('surface-restored');
  const restoration=await page.evaluate(()=>{
    const a=window.pointViewCaptures.surface,b=window.pointViewCaptures['surface-restored'];
    return {sameImage:a.rgba.length===b.rgba.length&&a.rgba.every((v,i)=>v===b.rgba[i]),sameDepth:a.depth.length===b.depth.length&&a.depth.every((v,i)=>v===b.depth[i])};
  });
  check(restoration.sameImage&&restoration.sameDepth&&restored.drawn===surface.drawn,'Returning to surface did not restore the original image');
  await chooseView('points');
  const pngPromise=page.waitForEvent('download');await page.locator('#export-frame').click();
  const pngDownload=await pngPromise,pngPath=path.join(output,'saved-point-cloud.png');await pngDownload.saveAs(pngPath);
  const png=await fs.readFile(pngPath);check(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&png.length>1000,'Point-view PNG export failed');

  const experiment=await page.evaluate(async()=>{
    const ids=['view-points','view-surface','point-size','background','material','dataset'],r=window.COMP5411.renderer,draw=r.draw,observed=[];
    r.draw=function(camera,settings){observed.push({rawPoints:settings.rawPoints,material:settings.material?.id,edlStrength:settings.edlStrength});return draw.call(this,camera,settings);};
    try{
      const task=window.COMP5411.runExperiment({samples:4,duration:.1,modes:['screen'],width:120,height:90});
      const locked=ids.every(id=>document.getElementById(id).disabled),result=await task;
      return {locked,unlocked:ids.every(id=>!document.getElementById(id).disabled),view:window.COMP5411.state.view,
        sunStillDisabled:document.getElementById('sun-azimuth').disabled,requestedRawPoints:result.presentationRendering.rawPoints,
        rawPoints:result.rendering.rawPoints,material:result.rendering.material.id,edlStrength:result.rendering.edlStrength,
        records:result.records.length,observed};
    }finally{r.draw=draw;}
  });
  check(experiment.locked&&experiment.unlocked&&experiment.sunStillDisabled&&experiment.view==='points','Comparison did not restore point-view controls');
  check(experiment.rawPoints===false&&experiment.requestedRawPoints===true&&experiment.material==='original'&&experiment.edlStrength===14,'Comparison policy or requested point-view metadata is wrong');
  check(experiment.records===2&&experiment.observed.length===12&&experiment.observed.every(x=>x.rawPoints===false&&x.material==='original'),'Comparisons did not consistently use the surface measurement path');
  const jsonPromise=page.waitForEvent('download');await page.locator('#export-results').click();
  const jsonDownload=await jsonPromise,jsonPath=path.join(output,'point-view-experiment.json');await jsonDownload.saveAs(jsonPath);
  check(JSON.parse(await fs.readFile(jsonPath,'utf8')).presentationRendering.rawPoints===true,'Point-view choice was lost from downloaded experiment JSON');

  // Isolated renderer: no app animation, no selection confound, and no normal/radius dependence.
  const direct=await page.evaluate(async()=>{
    const {SurfelRenderer}=await import('/src/render/renderer.js'),{makeCamera}=await import('/src/core/math.js');
    const {materialSettings}=await import('/src/render/materials.js'),{sunlightSettings}=await import('/src/render/lighting.js');
    const canvas=document.createElement('canvas'),r=new SurfelRenderer(canvas);r.timerEnabled=false;r.resize(128,128);
    const cloud={positions:new Float32Array([-.45,0,0,0,0,0,.45,0,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),
      colors:new Float32Array([1,0,0,0,1,0,0,0,1]),radii:new Float32Array([.02,.05,.1]),geometry:new Float32Array([0,.5,1]),saliency:new Float32Array([1,.5,0])};
    const ids=new Uint32Array([0,1,2]),camera=makeCamera([0,0,3],[0,0,0],128,128),settings={rawPoints:true,pointSize:4,material:materialSettings('original'),edl:true};
    const render=(options={},cam=camera)=>{r.upload(cloud,ids);r.draw(cam,{...settings,...options});return r.capture(cam);};
    const base=render(),same=(a,b)=>a.rgba.every((v,i)=>v===b.rgba[i])&&a.depth.every((v,i)=>v===b.depth[i]);
    cloud.normals.set([1,0,0,0,1,0,0,0,-1]);cloud.radii.set([2,3,4]);
    const alteredGeometry=render();
    const alteredLight=render({sunlight:sunlightSettings({azimuth:230,elevation:5,intensity:0}),edl:false,radiusScale:5});
    const small=render({pointSize:2}),large=render({pointSize:6}),distant=render({},makeCamera([0,0,6],[0,0,0],128,128));
    const foreground=c=>c.depth.reduce((n,d)=>n+(d<1),0);
    const colors=new Set();for(let i=0;i<base.depth.length;i++)if(base.depth[i]<1)colors.add(Array.from(base.rgba.slice(i*4,i*4+3)).join(','));
    const depthValues=Array.from(new Set(Array.from(base.depth).filter(d=>d<1)));
    const error=r.gl.getError();r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    return {normalAndRadiusInvariant:same(base,alteredGeometry),sunAndEDLInvariant:same(base,alteredLight),foreground:foreground(base),
      small:foreground(small),large:foreground(large),distant:foreground(distant),colors:[...colors].sort(),depthValues,error};
  });
  check(direct.normalAndRadiusInvariant&&direct.sunAndEDLInvariant,'Raw point rendering depends on normals, world radii, sunlight, or EDL');
  check(direct.large>direct.small*3&&Math.abs(direct.distant-direct.foreground)<=6,'Point footprint is not controlled in screen pixels');
  check(JSON.stringify(direct.colors)===JSON.stringify(['0,0,255','0,255,0','255,0,0']),'Original point colors are not preserved without shading');
  check(direct.depthValues.length===1&&direct.error===0,'Point centers do not share center depth or WebGL reported an error');

  await page.setViewportSize({width:390,height:844});await frames();const mobile=await layout();checkLayout(mobile,'mobile point view');
  await page.screenshot({path:path.join(output,'point-cloud-mobile.png'),fullPage:true});
  url.searchParams.set('view','points');await page.goto(url.href,{waitUntil:'networkidle'});await ready('jetliner');await frames();
  check(await page.evaluate(()=>window.COMP5411.state.view==='points'),'Point-view deep link did not load');
  await page.selectOption('#dataset','synthetic');await ready('synthetic');
  check(await page.evaluate(()=>window.COMP5411.state.view==='points'&&window.COMP5411.state.material==='original'),'Dataset switch reset point view or overwrote colored-input defaults');
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const report={status:'passed',desktop,mobile,displayNotesRemoved:true,selectionAndAttributesPreserved:true,
    surface:{drawn:surface.drawn,foreground:surface.foreground},points:{drawn:points.drawn,foreground:points.foreground},largerPointForeground:larger.foreground,
    reference,restoration,experiment,direct,deepLinkAndDatasetPersistence:true,exports:{png:pngDownload.suggestedFilename(),json:jsonDownload.suggestedFilename()},
    consoleErrors:errors,backend:'headless Chrome / SwiftShader; functionality checks only, not native GPU performance'};
  await fs.writeFile(path.join(output,'point-view-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
