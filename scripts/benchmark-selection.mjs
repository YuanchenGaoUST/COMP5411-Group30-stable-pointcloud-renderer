// CPU selection profiling only. This never claims GPU time or renderer FPS.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createDemoCloud} from '../src/core/cloud.js';
import {buildOctree} from '../src/core/octree.js';
import {StableSelector} from '../src/core/selection.js';
import {cameraAt} from '../src/core/camera-paths.js';
import {makeCamera} from '../src/core/math.js';
const cloud=createDemoCloud({count:14400,seed:20261010}),tree=buildOctree(cloud),budget=1440,frames=61;
const variants=[];for(const mode of ['uniform','screen','geometry','full'])for(const stable of (mode==='uniform'?[false]:[false,true]))variants.push({mode,stable,selector:new StableSelector(cloud),samples:[]});
for(let frame=0;frame<frames;frame++){
  const time=frame/30,p=cameraAt('orbit',time,{duration:12,previousTime:(frame-1)/30,sceneScale:cloud.bounds.radius/1.7}),center=cloud.bounds.center,camera=makeCamera(p.eye.map((x,i)=>x+center[i]),p.target.map((x,i)=>x+center[i]),640,480);
  const retainedIds=[...new Set(variants.flatMap(v=>Array.from(v.selector.selectedIds)))],begin=performance.now(),candidates=tree.getCandidates(camera,{budget,maxCandidates:4*budget,retainedIds}),candidateMs=performance.now()-begin;
  for(const v of variants){const start=performance.now(),result=v.selector.update(candidates,camera,{budget,mode:v.mode,stable:v.stable,dt:1/30,swapQuota:.1,hysteresis:.12,emaSeconds:.12,restart:p.cut});if(result.count>budget||v.stable&&result.stats.swaps>result.stats.maxSwaps)throw new Error('Count/quota invariant failed');v.samples.push({frame,time,count:result.count,candidateMs,selectionMs:performance.now()-start,...result.stats});}
}
const pctl=(a,q)=>{a=[...a].sort((x,y)=>x-y);return a[Math.floor((a.length-1)*q)];};
const results={kind:'cpu-selection-diagnostic',date:new Date().toISOString(),node:process.version,platform:process.platform,cloud:cloud.name,seed:20261010,count:cloud.count,budget,frames,selectionHz:30,cameraPath:'orbit',notes:['This 2-second prefix is a smoke/profile sequence, not the full planned matrix.','No WebGL rendering or GPU timing occurs here.','First 10 samples are excluded from timing summaries.'],records:variants.map(v=>({mode:v.mode,stable:v.stable,summary:{medianSelectionMs:pctl(v.samples.slice(10).map(s=>s.selectionMs),.5),p95SelectionMs:pctl(v.samples.slice(10).map(s=>s.selectionMs),.95),maxCount:Math.max(...v.samples.map(s=>s.count))},samples:v.samples}))};
const output=path.resolve(process.argv[2]||'results/local/selection-profile.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(results,null,2));console.log(`Wrote ${output}\n${variants.length} variants, ${frames} shared-candidate frames; budget and replacement invariants passed.`);
