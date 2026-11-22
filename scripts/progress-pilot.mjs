// Reproducible preliminary image study; no native-GPU speed claim is made.
// Example: PROJECT_URL=http://127.0.0.1:5416 node scripts/progress-pilot.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'results/progress-2026-10-21');
const datasets=process.argv.slice(2).length?process.argv.slice(2):['fixture','jetliner'];
if(datasets.some(id=>!['fixture','jetliner'].includes(id)))throw new Error('Supported inputs: fixture, jetliner');
await fs.mkdir(output,{recursive:true});
const {chromium}=await loadPlaywright();
const browser=await chromium.launch(browserLaunchOptions());
const page=await browser.newPage({viewport:{width:1440,height:1080}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());else if(message.text().startsWith('PILOT_PROGRESS '))console.log(message.text());});
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const hashes={};
for(const filename of ['src/core/selection.js','src/core/octree.js','src/core/metrics.js','src/core/camera-paths.js','src/render/renderer.js','src/render/shaders.js','data/fixture.json','data/models/jetliner.json'])hashes[filename]=crypto.createHash('sha256').update(await fs.readFile(path.join(root,filename))).digest('hex');
const manifest={study:'Preliminary implementation progress study, not the final evaluation',created:new Date().toISOString(),inputs:datasets,path:'orbit',durationSeconds:12,selectionHz:30,captures:361,viewport:{width:320,height:240},budgetRatio:.2,rendering:{pointMode:false,colorMode:0,radiusScale:2,edl:true},selectionSettings:{emaSeconds:.12,hysteresis:.12,swapQuota:.1},scoreWeights:'Unmodified SCORE_WEIGHTS in src/core/selection.js; see SHA-256 snapshot',candidatePolicy:'One shared per-update pool including union-retained IDs across all seven variants',reference:'Same-shader full-density image; not geometric ground truth',environment:{node:process.version,browser:await browser.version(),backend:'Headless Chrome / ANGLE SwiftShader software rasterization'},limitations:['One orbit, one budget, one seed; no statistical or cross-dataset generalization claim.','Fixture is synthetic; Jetliner is an uncolored mesh-derived sample, not a raw scan.','Jetliner has zero color saliency, so Geometry and Full have identical scores.','Readback synchronizes rendering; CPU timings are diagnostic wall time and do not establish native GPU performance.','Temporal metric uses nearest-neighbor reference reprojection and absolute raw-depth tolerance 0.0001.','All image samples and all seven variants are retained without selecting favorable frames.'],hashes};
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
try{
  for(const dataset of datasets){
    const url=new URL(process.env.PROJECT_URL||'http://127.0.0.1:5416/');url.searchParams.set('dataset',dataset);
    await page.goto(url.href,{waitUntil:'networkidle'});
    await page.waitForFunction(id=>{const s=window.COMP5411?.state;return s?.dataset===id&&!s.busy&&!s.loadingDataset&&s.drawn>0;},dataset);
    const state=await page.evaluate(()=>window.COMP5411.state);
    const budget=Math.round(.2*state.count);
    await page.locator('#budget-value').fill(String(budget));await page.locator('#budget-value').dispatchEvent('change');
    await page.selectOption('#path','orbit');await page.selectOption('#primitive','surfels');await page.selectOption('#colors','0');
    await page.locator('#radius').fill('20');await page.locator('#quota').fill('10');await page.locator('#margin').fill('12');await page.locator('#edl').check();await page.locator('#reference').uncheck();
    const renderer=await page.evaluate(()=>{const gl=window.COMP5411.renderer.gl,debug=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:gl.getParameter(gl.RENDERER),unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,vendor:gl.getParameter(gl.VENDOR)};});
    console.log(JSON.stringify({event:'start',dataset,count:state.count,budget,renderer,time:new Date().toISOString()}));
    await page.evaluate(()=>{let last='';new MutationObserver(()=>{const value=document.querySelector('#status').textContent;if(value!==last&&/\d+\/361/.test(value)){last=value;console.log(`PILOT_PROGRESS ${value}`);}}).observe(document.querySelector('#status'),{childList:true,characterData:true,subtree:true});});
    const start=performance.now();
    const result=await page.evaluate(()=>window.COMP5411.runExperiment({samples:361,duration:12,width:320,height:240}));
    result.progressStudyMetadata={dataset,elapsedWallSeconds:(performance.now()-start)/1000,manifest:'manifest.json',renderer};
    await fs.writeFile(path.join(output,`${dataset}.json`),JSON.stringify(result,null,2));
    check(result.records.length===7,'Expected seven variants');
    const countSequences=result.records.map(record=>record.samples.map(sample=>sample.count));
    const commonCounts=countSequences.every(sequence=>sequence.every((count,index)=>count===countSequences[0][index]));
    const rows=result.records.map(record=>{
      const a=record.samples,postInit=a.filter(sample=>!sample.selectionStats.initialized),temporal=a.filter(sample=>Number.isFinite(sample.temporalResidualRgb)&&sample.validPixelCount>0);
      return {mode:record.mode,stable:record.stable,...record.summary,captures:a.length,budgetViolations:a.filter(sample=>sample.count>result.budget).length,quotaViolations:record.stable?a.filter(sample=>sample.selectionStats.swaps>sample.selectionStats.maxSwaps).length:null,meanDiscretionarySwaps:mean(postInit.map(sample=>sample.selectionStats.swaps)),meanTotalTurnover:mean(postInit.map(sample=>sample.selectionStats.turnover)),maxDiscretionarySwaps:Math.max(...postInit.map(sample=>sample.selectionStats.swaps)),quotaCap:record.stable?a[0].selectionStats.maxSwaps:null,mandatoryRemovalTotal:postInit.reduce((n,sample)=>n+sample.selectionStats.mandatoryRemovals,0),validTemporalFrames:temporal.length,validCorrespondencePixels:temporal.reduce((n,sample)=>n+sample.validPixelCount,0),meanValidPixelFraction:mean(temporal.map(sample=>sample.validPixelFraction)),temporalMaskSharedAcrossVariants:result.records.every(other=>other.samples.every((sample,i)=>sample.validPixelCount===a[i].validPixelCount))};
    });
    const maskSamples=result.records[0].samples.slice(1),referenceForegroundPixels=maskSamples.reduce((n,sample)=>n+sample.referenceForegroundPixels,0),validCorrespondencePixels=maskSamples.reduce((n,sample)=>n+sample.validPixelCount,0);
    const summary={dataset,input:result.input,inputCount:result.count,budget:result.budget,path:result.path,viewport:result.viewport,duration:result.duration,captureHz:result.captureHz,commonCounts,referenceForegroundPixelsExcludingInitial:referenceForegroundPixels,validTemporalCorrespondenceCoverageOfReferenceForeground:referenceForegroundPixels?validCorrespondencePixels/referenceForegroundPixels:null,sourceKind:result.cloudMetadata.sourceKind??'synthetic',hasColors:result.cloudMetadata.hasColors??null,elapsedWallSeconds:result.progressStudyMetadata.elapsedWallSeconds,consoleErrors:[...errors],rows};
    await fs.writeFile(path.join(output,`${dataset}-summary.json`),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({event:'complete',...summary},null,2));
    check(commonCounts,'Variant counts differ');check(rows.every(row=>!row.budgetViolations),'Budget violations');check(rows.every(row=>!row.quotaViolations),'Quota violations');check(rows.every(row=>row.temporalMaskSharedAcrossVariants),'Temporal masks differ');check(errors.length===0,'Browser console errors');
  }
}finally{await browser.close();}
