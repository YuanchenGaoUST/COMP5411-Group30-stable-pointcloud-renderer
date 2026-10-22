// Real WebGL integration checks; SwiftShader results are not GPU benchmarks.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/local/sunlight');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(browserLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try{
  const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5411/');url.searchParams.set('dataset','jetliner');
  await page.goto(url.href,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>{const s=window.COMP5411?.state;return s?.dataset==='jetliner'&&!s.loadingDataset&&s.drawn===7500&&s.selection?.stats.initialized===false;});
  await page.evaluate(()=>{
    const r=window.COMP5411.renderer;
    window.sunlightBefore={image:r.capture({viewProjection:new Float32Array(16)}),ids:Array.from(window.COMP5411.state.selection.ids)};
  });
  await page.screenshot({path:path.join(output,'sunlight-default.png'),fullPage:true});
  for(const [id,value] of [['sun-azimuth','130'],['sun-elevation','12'],['sun-intensity','65']]){
    await page.locator(`#${id}`).fill(value);await page.locator(`#${id}`).dispatchEvent('input');
  }
  await frames();
  const interaction=await page.evaluate(()=>{
    const r=window.COMP5411.renderer,b=window.sunlightBefore,a=r.capture({viewProjection:new Float32Array(16)}),s=window.COMP5411.state;
    return {changedChannels:a.rgba.reduce((n,v,i)=>n+(v!==b.image.rgba[i]),0),depthChanges:a.depth.reduce((n,v,i)=>n+(v!==b.image.depth[i]),0),sameIds:JSON.stringify(Array.from(s.selection.ids))===JSON.stringify(b.ids),drawn:s.drawn,budget:s.budget,selectionReset:s.selection.stats.initialized,labels:['sun-azimuth-value','sun-elevation-value','sun-intensity-value'].map(id=>document.getElementById(id).value)};
  });
  check(interaction.changedChannels>1000,'Sun controls did not visibly change the render');
  check(interaction.depthChanges===0&&interaction.sameIds&&!interaction.selectionReset,'Sun controls changed geometry or selected points');
  check(interaction.drawn===interaction.budget,'Sun controls changed the budget');
  check(interaction.labels.join(',')==='130.0°,12.0°,65%','Sun labels do not follow controls');
  await page.screenshot({path:path.join(output,'sunlight-adjusted.png'),fullPage:true});
  await page.locator('#sun-reset').click();await frames();
  const reset=await page.evaluate(()=>{
    const r=window.COMP5411.renderer,a=r.capture({viewProjection:new Float32Array(16)}),b=window.sunlightBefore.image;
    return {changedChannels:a.rgba.reduce((n,v,i)=>n+(v!==b.rgba[i]),0),direction:Array.from(r.gl.getUniform(r.surfel,r.gl.getUniformLocation(r.surfel,'uLightDirection')))};
  });
  check(reset.changedChannels===0,'Reset failed to restore the original image');
  check(JSON.stringify(reset.direction)===JSON.stringify(Array.from(new Float32Array([.4,.8,.65]))),'Default range values did not preserve the original light direction');

  // Compare the default shader against the actual pre-change fixed-light GLSL.
  const compatibility=await page.evaluate(async()=>{
    const {SurfelRenderer}=await import('/src/render/renderer.js');
    const {SURFEL_VERTEX,SURFEL_FRAGMENT}=await import('/src/render/shaders.js');
    const {parseCloudJSON}=await import('/src/core/cloud.js');
    const {makeCamera}=await import('/src/core/math.js');
    const {sunlightSettings}=await import('/src/render/lighting.js');
    const cloud=parseCloudJSON(await (await fetch('/data/models/jetliner.json')).text());
    const r=new SurfelRenderer(document.createElement('canvas'));r.resize(320,240);r.timerEnabled=false;
    const camera=makeCamera([3,2,4],cloud.bounds.center,320,240),gl=r.gl;
    const uiLight=sunlightSettings({azimuth:Number(document.getElementById('sun-azimuth').value),elevation:Number(document.getElementById('sun-elevation').value),intensity:Number(document.getElementById('sun-intensity').value)/100});
    r.upload(cloud,Uint32Array.from({length:cloud.count},(_,i)=>i));r.draw(camera,{sunlight:uiLight});const current=r.capture(camera);
    const legacy=SURFEL_FRAGMENT.replace('float light=uAmbientLight+uSunStrength*abs(dot(normalize(vNormal),normalize(uLightDirection)));','float light=.42+.58*abs(dot(normalize(vNormal),normalize(vec3(.4,.8,.65))));');
    if(legacy===SURFEL_FRAGMENT)throw new Error('Legacy shader replacement failed');
    const program=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,SURFEL_VERTEX],[gl.FRAGMENT_SHADER,legacy]]){
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program,shader);gl.deleteShader(shader);
    }
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    r.surfel=program;r.draw(camera);const old=r.capture(camera);
    const result={maxChannelDelta:current.rgba.reduce((n,v,i)=>Math.max(n,Math.abs(v-old.rgba[i])),0),depthChanges:current.depth.reduce((n,v,i)=>n+(v!==old.depth[i]),0),foreground:current.depth.reduce((n,v)=>n+(v<1),0)};
    gl.getExtension('WEBGL_lose_context')?.loseContext();return result;
  });
  check(compatibility.foreground>100&&compatibility.maxChannelDelta<=1&&compatibility.depthChanges===0,'Default light differs materially from the original shader');

  for(const [id,value] of [['sun-azimuth','120'],['sun-elevation','30'],['sun-intensity','60']])await page.locator(`#${id}`).fill(value);
  const experiment=await page.evaluate(async()=>{
    const r=window.COMP5411.renderer,draw=r.draw,observed=[];
    r.draw=function(camera,settings){observed.push(JSON.stringify(settings.sunlight));return draw.call(this,camera,settings);};
    try{
      const task=window.COMP5411.runExperiment({samples:4,duration:.1,modes:['screen'],width:120,height:90});
      const controls=[...document.querySelectorAll('.sunlight-controls input,.sunlight-controls button')];
      const locked=controls.every(el=>el.disabled),result=await task;
      return {locked,unlocked:controls.every(el=>!el.disabled),sunlight:result.rendering.sunlight,allDrawsMatchExport:observed.every(s=>s===JSON.stringify(result.rendering.sunlight)),draws:observed.length,records:result.records.length};
    }finally{r.draw=draw;}
  });
  check(experiment.locked&&experiment.unlocked,'Experiment did not lock and restore sunlight controls');
  check(experiment.allDrawsMatchExport&&experiment.draws===12&&experiment.records===2,'Experiment did not share one captured lighting configuration');
  check(experiment.sunlight.azimuth===120&&experiment.sunlight.elevation===30&&experiment.sunlight.intensity===.6,'Exported sun settings differ from UI');
  await page.setViewportSize({width:390,height:844});await frames();
  const mobile=await page.locator('.sunlight-panel').evaluate(el=>({width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth}));
  check(!mobile.overflow,'Sun controls overflow on a mobile screen');
  await page.locator('.sunlight-panel').screenshot({path:path.join(output,'sunlight-mobile.png')});
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
  const report={status:'passed',interaction,reset,compatibility,experiment,mobile,consoleErrors:errors,backend:'headless Chrome / SwiftShader; functionality checks only'};
  await fs.writeFile(path.join(output,'sunlight-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
