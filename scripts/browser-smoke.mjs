// Isolated headless Chromium smoke test; no user browser profile is touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright,browserLaunchOptions} from './browser-runtime.mjs';
const {chromium}=await loadPlaywright();
const output=path.resolve(process.argv[2]||'results/validation');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch(browserLaunchOptions());
const errors=[],page=await browser.newPage({viewport:{width:1440,height:1080}});page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
function check(condition,message){if(!condition)throw new Error(message);}
const waitForSelection=()=>page.waitForFunction(()=>{const s=window.COMP5411?.state;return s?.selection&&!s.busy&&!s.loadingDataset&&s.drawn>0&&s.selection.count===s.drawn&&s.selection.stats.budget===s.budget;});
try {
  await page.goto(process.env.PROJECT_URL||'http://127.0.0.1:5411/',{waitUntil:'networkidle'});await waitForSelection();
  const initial=await page.evaluate(()=>window.COMP5411.state);check(initial.drawn<=initial.budget,'Initial point budget exceeded');
  const pixels=await page.evaluate(()=>{const r=window.COMP5411.renderer,c=r.capture({viewProjection:new Float32Array(16)});return c.depth.reduce((n,d)=>n+(d<1),0);});check(pixels>500,'Renderer has no substantial foreground');
  await page.screenshot({path:path.join(output,'viewer.png'),fullPage:true});
  await page.locator('#budget-value').fill('1000');await page.locator('#budget-value').dispatchEvent('change');await waitForSelection();
  for(const method of ['uniform','screen','geometry','full']){await page.selectOption('#method',method);await waitForSelection();const s=await page.evaluate(()=>window.COMP5411.state);check(s.drawn<=1000&&s.drawn>0,`Count invalid for ${method}`);}
  await page.locator('#stable').uncheck();await waitForSelection();check((await page.evaluate(()=>window.COMP5411.state.selection.stats.temporalEnabled))===false,'Stable-off not honored');
  await page.locator('#stable').check();await page.locator('#quota').fill('0');await page.locator('#quota').dispatchEvent('change');await waitForSelection();check((await page.evaluate(()=>window.COMP5411.state.selection.stats.swaps))===0,'Zero quota permits swaps');
  await page.selectOption('#primitive','points');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));await page.selectOption('#primitive','surfels');
  await page.locator('#edl').uncheck();await page.locator('#edl').check();
  await page.locator('#fixture').click();await page.waitForFunction(()=>window.COMP5411.state.count===8192);await waitForSelection();check((await page.evaluate(()=>window.COMP5411.state.cloudMetadata.preprocessorRecommended))===false,'Offline features not recognized');
  await page.locator('#play').click();await page.waitForFunction(()=>window.COMP5411.state.selection?.stats.initialized===false);await page.locator('#play').click();await waitForSelection();
  await page.locator('#quota').fill('10');await page.locator('#quota').dispatchEvent('change');await waitForSelection();
  const experiment=await page.evaluate(()=>window.COMP5411.runExperiment({samples:13,duration:.4,width:160,height:120}));
  check(experiment.records.length===7,'Expected seven method/stability variants');
  for(const record of experiment.records){check(record.summary.maxCount<=experiment.budget,'Experiment budget exceeded');check(Number.isFinite(record.summary.maeRgb),'Image error is not finite');if(record.stable)for(const sample of record.samples)check(sample.selectionStats.swaps<=sample.selectionStats.maxSwaps,'Replacement quota exceeded');}
  const counts=experiment.records.map(r=>r.samples.map(s=>s.count));check(counts.every(c=>c.every((n,i)=>n===counts[0][i])),'Methods have different counts despite common candidates');
  await fs.writeFile(path.join(output,'browser-diagnostic.json'),JSON.stringify(experiment,null,2));
  await page.screenshot({path:path.join(output,'viewer-experiment.png'),fullPage:true});
  await page.selectOption('#path','cut');const cut=await page.evaluate(()=>window.COMP5411.runExperiment({samples:13,duration:.4,modes:['full'],width:120,height:90}));
  for(const r of cut.records){check(r.samples.some(s=>s.excludedByCut===true&&s.temporalResidualRgb===null),'Cut crossing was not excluded from temporal metric');check(r.samples.some(s=>Math.abs(s.time-.2)<1e-7&&s.selectionStats.initialized),'Selector did not restart at cut');}
  await fs.writeFile(path.join(output,'browser-cut-diagnostic.json'),JSON.stringify(cut,null,2));
  const report={status:'passed',initial:{count:initial.count,budget:initial.budget,drawn:initial.drawn,foregroundPixels:pixels},tested:['WebGL2 shaders/framebuffers','foreground rendered','hard count cap across modes','stable on/off','zero replacement quota','surfel/point sprite','EDL on/off','offline PCA fixture','camera playback','common-candidate seven-way experiment','RGB/temporal readback','camera-cut restart and reference-mask exclusion'],consoleErrors:errors,renderer:'headless Chrome / SwiftShader; diagnostic timings are not native GPU performance'};
  check(errors.length===0,`Browser errors: ${errors.join('; ')}`);await fs.writeFile(path.join(output,'browser-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
