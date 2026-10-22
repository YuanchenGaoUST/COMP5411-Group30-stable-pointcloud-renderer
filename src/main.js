import {createCloud,createDemoCloud,parsePointCloud,parseCloudJSON} from './core/cloud.js';
import {buildOctree} from './core/octree.js';
import {StableSelector} from './core/selection.js';
import {makeCamera} from './core/math.js';
import {cameraAt} from './core/camera-paths.js';
import {evaluateImagePair,temporalResidualMetric} from './core/metrics.js';
import {SurfelRenderer} from './render/renderer.js';
import {DEFAULT_SUN,sunlightSettings} from './render/lighting.js';
import {BACKGROUNDS} from './render/backgrounds.js';
import {fetchCatalog} from './core/catalog.js';

const $=id=>document.getElementById(id);
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const labels={uniform:'Uniform',screen:'Screen',geometry:'Geometry',full:'Geometry + contrast'};
const state={cloud:null,tree:null,selector:null,selection:null,busy:false,playing:false,pathTime:0,previousPathTime:0,manual:{yaw:.38,pitch:.21,distance:6},lastSelectionMs:0,lastSelectionAt:-Infinity,lastFrameAt:0,fps:0,frameCount:0,lastFpsAt:performance.now(),results:null,background:'solid',backgroundLoading:false};
let renderer;
try {renderer=new SurfelRenderer($('viewport'));} catch(error){status(error.message,true);throw error;}

function options(){return {budget:Number($('budget').value),mode:$('method').value,dt:1/30,stable:$('stable').checked,temporal:$('stable').checked,emaSeconds:$('stable').checked?.12:0,hysteresis:$('stable').checked?Number($('margin').value)/100:0,swapQuota:$('stable').checked?Number($('quota').value)/100:1};}
function renderingOptions(){return {radiusScale:Number($('radius').value)/10,pointMode:$('primitive').value==='points',colorMode:Number($('colors').value),edl:$('edl').checked,sunlight:sunlightSettings({azimuth:Number($('sun-azimuth').value),elevation:Number($('sun-elevation').value),intensity:Number($('sun-intensity').value)/100}),background:state.background,captureBackground:'legacy-solid'};}
let backgroundRequest=0;
async function changeBackground(id){
  if(state.busy){$('background').value=state.background;return;}
  const request=++backgroundRequest;state.backgroundLoading=true;$('background-note').textContent='Loading backdrop…';
  try{
    await renderer.loadBackground(id);if(request!==backgroundRequest)return;
    state.background=id;$('background').value=id;
    const entry=BACKGROUNDS.find(item=>item.id===id);
    $('background-note').textContent=id==='solid'?'Original solid background · also used for image measurements':`${entry.label} · AI-generated image · display only`;
  }catch(error){
    if(request!==backgroundRequest)return;
    $('background').value=state.background;$('background-note').textContent=`Backdrop unavailable; keeping the current background. ${error.message}`;
  }finally{if(request===backgroundRequest)state.backgroundLoading=false;}
}
$('background').addEventListener('change',()=>changeBackground($('background').value));
changeBackground($('background').value);
function updateSunLabels(){for(const id of ['azimuth','elevation'])$(`sun-${id}-value`).value=`${Number($(`sun-${id}`).value).toFixed(1)}°`;$('sun-intensity-value').value=`${$('sun-intensity').value}%`;}
function resetSun(){for(const id of ['azimuth','elevation'])$(`sun-${id}`).value=DEFAULT_SUN[id];$('sun-intensity').value=DEFAULT_SUN.intensity*100;updateSunLabels();}
for(const id of ['sun-azimuth','sun-elevation','sun-intensity'])$(id).addEventListener('input',updateSunLabels);
$('sun-reset').addEventListener('click',resetSun);resetSun();
function sceneScale(){return Math.max(.12,state.cloud.bounds.radius/1.7);}
function pathCamera(path,time,previousTime,width=renderer.canvas.width,height=renderer.canvas.height,duration=12){const p=cameraAt(path,time,{duration,previousTime,sceneScale:sceneScale()}),center=state.cloud.bounds.center;return {...makeCamera(p.eye.map((v,i)=>v+center[i]),p.target.map((v,i)=>v+center[i]),width,height),radiusScale:renderingOptions().radiusScale,cut:p.cut};}
function currentCamera(){
  if(state.playing)return pathCamera($('path').value,state.pathTime,state.previousPathTime);
  const m=state.manual,c=state.cloud.bounds.center,d=m.distance,eye=[c[0]+Math.sin(m.yaw)*Math.cos(m.pitch)*d,c[1]+Math.sin(m.pitch)*d,c[2]+Math.cos(m.yaw)*Math.cos(m.pitch)*d];
  return {...makeCamera(eye,c,renderer.canvas.width,renderer.canvas.height),radiusScale:renderingOptions().radiusScale};
}
function resize(){if(state.busy)return;const rect=$('viewport').getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5);renderer.resize(rect.width*dpr,rect.height*dpr);state.lastSelectionAt=-Infinity;}
new ResizeObserver(resize).observe($('viewport'));

function manualCameraDefaults(cloud){return {distance:Math.max(cloud.bounds.radius*(cloud.metadata.sourceKind==='mesh-derived'?2:2.65),.6),yaw:cloud.metadata.preview?.yaw??.38,pitch:cloud.metadata.preview?.pitch??.21};}
function setCloud(cloud){
  if(!cloud.count)throw new Error('The point cloud is empty. Choose a valid input.');
  state.cloud=cloud;state.tree=buildOctree(cloud);state.selector=new StableSelector(cloud);state.selection=null;state.lastSelectionAt=-Infinity;state.playing=false;state.pathTime=0;
  state.manual=manualCameraDefaults(cloud);
  $('scene-name').textContent=cloud.name;$('budget').max=cloud.count;$('budget-value').max=cloud.count;
  $('budget').value=Math.max(1,Math.round(cloud.count*(cloud.metadata.preview?.budgetRatio??.2)));$('budget-value').value=$('budget').value;
  $('dataset-info').textContent=`${cloud.count.toLocaleString()} points · ${cloud.metadata.source||'local input'} · persistent source IDs`;
  $('feature-note').textContent=cloud.metadata.preprocessorRecommended?'Offline features missing: preview only; run preprocess.py for experiments.':'Normals and features provided; see dataset metadata for their sources.';
  if(cloud.metadata.sourceKind==='mesh-derived'&&cloud.metadata.hasColors===false)$('feature-note').textContent='PCA normals and geometry computed · No source colors: s = 0, so Full equals Geometry on this input.';
  $('dataset-source').replaceChildren();
  if(cloud.metadata.sourceURL){const a=document.createElement('a');a.href=cloud.metadata.sourceURL;a.target='_blank';a.rel='noopener';a.textContent='Model source';$('dataset-source').append(a,document.createTextNode(` · ${cloud.metadata.license||'See source for license'} · ${cloud.metadata.sourceKind==='mesh-derived'?'sampled from a mesh surface':'point cloud input'}`));}
  if(cloud.metadata.preprocessorRecommended)$('primitive').value='points';else $('primitive').value='surfels';
  state.results=null;$('export-results').disabled=true;$('result-table').replaceChildren();updateLabels();
  status(cloud.metadata.preprocessorRecommended?'Raw point cloud loaded. Missing normals and geometry use preview fallbacks; preprocess offline before formal experiments.':'Scene loaded. Lower the point budget and play a camera path to inspect the changes.');
}
function updateLabels(){const b=Number($('budget').value);$('budget-fraction').textContent=`${(100*b/Math.max(1,state.cloud?.count||1)).toFixed(1)}% of input · submitted instances ≤ B`;$('quota-value').value=`${$('quota').value}%`;$('margin-value').value=`${$('margin').value}%`;$('radius-value').value=`${(Number($('radius').value)/10).toFixed(1)}×`;}
function resetSelection(){state.selector?.reset?.();state.selector=new StableSelector(state.cloud);state.lastSelectionAt=-Infinity;state.selection=null;}
for(const id of ['method','stable','quota','margin','reference'])$(id).addEventListener('change',()=>{if(!state.busy)resetSelection();updateLabels();});
for(const id of ['quota','margin','radius'])$(id).addEventListener('input',updateLabels);
$('budget').addEventListener('input',()=>{$('budget-value').value=$('budget').value;updateLabels();resetSelection();});
$('budget-value').addEventListener('change',()=>{$('budget').value=Math.max(1,Math.min(state.cloud.count,Number($('budget-value').value)||1));$('budget-value').value=$('budget').value;updateLabels();resetSelection();});
let catalog=[],datasetRequest=0;
async function loadDataset(id){
  if(state.busy)return;const request=++datasetRequest;state.loadingDataset=true;$('experiment').disabled=true;
  try{
    if(id==='synthetic'){setCloud(createDemoCloud());$('dataset').value=id;return;}
    const entry=catalog.find(item=>item.id===id),url=id==='fixture'?'/data/fixture.json':entry?.path;
    if(!url)throw new Error('Unknown dataset.');status('Loading and indexing the point cloud…');
    const response=await fetch(url);if(!response.ok)throw new Error(`Local dataset file not found: ${url}`);
    const cloud=parseCloudJSON(await response.text());if(request!==datasetRequest)return;
    if(entry&&cloud.count!==entry.count)throw new Error('Point count does not match the catalog. Rebuild the dataset.');setCloud(cloud);$('dataset').value=id;
  }catch(error){if(request===datasetRequest)status(`Dataset loading failed: ${error.message}`,true);}
  finally{if(request===datasetRequest){state.loadingDataset=false;$('experiment').disabled=false;}}
}
$('dataset').addEventListener('change',()=>loadDataset($('dataset').value));
$('demo').addEventListener('click',()=>loadDataset('synthetic'));
$('fixture').addEventListener('click',()=>loadDataset('fixture'));
$('file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file||state.busy)return;
  try{if(file.size>30*1024*1024)throw new Error('The preview limit is 30 MB. Preprocess offline or use a subset first.');status('Reading the local point cloud…');const text=await file.text(),cloud=file.name.endsWith('.json')?parseCloudJSON(text):parsePointCloud(text,{name:file.name});
    // Keep source IDs, normals and scalar features; normalize geometry and radius together.
    const span=Math.max(...cloud.bounds.max.map((v,i)=>v-cloud.bounds.min[i])),scale=span>0?2/span:1;
    const positions=Float32Array.from(cloud.positions,(v,i)=>(v-cloud.bounds.center[i%3])*scale),radii=Float32Array.from(cloud.radii,v=>v*scale);
    datasetRequest++;setCloud(createCloud({...cloud,positions,radii,metadata:{...cloud.metadata,importNormalizationScale:scale}}));$('dataset').value='';state.loadingDataset=false;$('experiment').disabled=false;
  }catch(error){status(`Loading failed: ${error.message}`,true);}event.target.value='';
});
$('play').addEventListener('click',()=>{if(state.busy)return;state.playing=!state.playing;state.previousPathTime=state.pathTime;resetSelection();});
$('path').addEventListener('change',()=>{state.pathTime=0;state.previousPathTime=0;resetSelection();});
$('reset').addEventListener('click',()=>{if(state.busy)return;state.pathTime=0;state.previousPathTime=0;state.manual=manualCameraDefaults(state.cloud);resetSelection();});
let dragging=null;
$('viewport').addEventListener('pointerdown',event=>{if(state.busy)return;state.playing=false;dragging=[event.clientX,event.clientY];$('viewport').setPointerCapture(event.pointerId);});
$('viewport').addEventListener('pointermove',event=>{if(!dragging)return;state.manual.yaw+=(event.clientX-dragging[0])*.006;state.manual.pitch=Math.max(-1.4,Math.min(1.4,state.manual.pitch+(event.clientY-dragging[1])*.006));dragging=[event.clientX,event.clientY];});
$('viewport').addEventListener('pointerup',()=>dragging=null);
$('viewport').addEventListener('wheel',event=>{event.preventDefault();if(state.busy)return;state.playing=false;state.manual.distance=Math.max(.18,Math.min(18,state.manual.distance*Math.exp(event.deltaY*.001)));},{passive:false});
$('viewport').addEventListener('dblclick',()=>$('reset').click());

function tick(now){
  requestAnimationFrame(tick);if(!state.cloud||state.busy)return;
  const dt=Math.min(.1,(now-state.lastFrameAt)/1000||1/60);state.lastFrameAt=now;
  if(state.playing){state.previousPathTime=state.pathTime;state.pathTime+=dt;if(state.pathTime>12){state.pathTime%=12;resetSelection();}}
  const camera=currentCamera();
  if(camera.cut)state.pendingCut=true;
  if(now-state.lastSelectionAt>=1000/30||!state.selection){
    const begin=performance.now();
    if($('reference').checked){state.selection={indices:Uint32Array.from({length:state.cloud.count},(_,i)=>i),count:state.cloud.count,stats:{}};}
    else {const candidates=state.tree.getCandidates(camera,{budget:options().budget,maxCandidates:Math.max(options().budget*4,256),retainedIds:state.selector.selectedIds||[]});state.selection=state.selector.update(candidates,camera,{...options(),dt:Number.isFinite(state.lastSelectionAt)?Math.min(.2,(now-state.lastSelectionAt)/1000):1/30,restart:!!state.pendingCut});state.pendingCut=false;}
    state.lastSelectionMs=performance.now()-begin;state.lastSelectionAt=now;renderer.upload(state.cloud,state.selection.indices);
  }
  renderer.draw(camera,renderingOptions());state.frameCount++;
  if(now-state.lastFpsAt>500){state.fps=state.frameCount*1000/(now-state.lastFpsAt);state.frameCount=0;state.lastFpsAt=now;
    $('count-stat').textContent=`${renderer.count.toLocaleString()} / ${$('reference').checked?'REF':Number($('budget').value).toLocaleString()}`;$('fps-stat').textContent=state.fps.toFixed(1);$('selection-stat').textContent=`${state.lastSelectionMs.toFixed(2)} ms`;
    const s=state.selection.stats;$('turnover-stat').textContent=`${s.discretionarySwaps??s.swaps??0} / ${s.mandatoryRemovals??0}`;$('gpu-stat').textContent=renderer.lastGpuMs==null?'Unavailable':`${renderer.lastGpuMs.toFixed(2)} ms`;
  }
}
function download(name,blob){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-frame').addEventListener('click',()=>{$('viewport').toBlob(blob=>blob&&download('comp5411-frame.png',blob));});
$('export-results').addEventListener('click',()=>state.results&&download('comp5411-experiment.json',new Blob([JSON.stringify(state.results,null,2)],{type:'application/json'})));

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const mean=values=>{const finite=values.filter(Number.isFinite);return finite.length?finite.reduce((a,b)=>a+b,0)/finite.length:null;};
const percentile=(values,q)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.floor((a.length-1)*q)]:null;};
async function runExperiment({samples=61,duration=2,modes=['uniform','screen','geometry','full'],width=320,height=240}={}){
  if(state.busy)throw new Error('Experiment already running');if(state.loadingDataset)throw new Error('Wait for the point cloud to finish loading.');if(state.backgroundLoading)throw new Error('Wait for the background to finish loading.');
  if(!Number.isInteger(samples)||samples<2||samples>500||!Number.isFinite(duration)||duration<=0)throw new Error('Use 2–500 samples and a positive duration.');
  const locked=Array.from(document.querySelectorAll('aside input, aside select, aside button, #background, .sunlight-controls input, .sunlight-controls button, .experiment-controls select, .experiment-controls button')).map(element=>({element,disabled:element.disabled}));
  for(const {element} of locked)element.disabled=true;state.busy=true;state.playing=false;
  const oldSize=[renderer.canvas.width,renderer.canvas.height],settings=renderingOptions(),budget=Number($('budget').value),path=$('path').value,records=[],selectionSettings={emaSeconds:.12,hysteresis:Number($('margin').value)/100,swapQuota:Number($('quota').value)/100};
  try{
    renderer.resize(width,height);renderer.timerEnabled=false;
    const variants=[];
    for(const mode of modes)for(const stable of (mode==='uniform'?[false]:[false,true]))variants.push({mode,stable,selector:new StableSelector(state.cloud),samplesOut:[],previous:null,selection:null,selectionMs:0});
    const all=Uint32Array.from({length:state.cloud.count},(_,i)=>i);let selectionTick=0,previousCaptureTime=null;
    for(let sample=0;sample<samples;sample++){
      const t=sample*duration/Math.max(1,samples-1);
      // Advance all variants in lockstep. Their union-retained IDs enter ONE
      // shared pool, so candidate discovery cannot favor an individual method.
      for(;selectionTick/30<=t+1e-7;selectionTick++){
        const step=selectionTick/30,camera=pathCamera(path,step,(selectionTick-1)/30,width,height,duration),retainedIds=new Set(variants.flatMap(v=>Array.from(v.selector.selectedIds))),begin=performance.now();
        const candidates=state.tree.getCandidates(camera,{budget,maxCandidates:Math.max(budget*4,256),retainedIds:Array.from(retainedIds)}),candidateMs=performance.now()-begin;
        for(const v of variants){const start=performance.now();v.selection=v.selector.update(candidates,camera,{budget,mode:v.mode,stable:v.stable,dt:1/30,...selectionSettings,restart:!!camera.cut});v.selectionMs=performance.now()-start;v.candidateMs=candidateMs;}
      }
      const camera=pathCamera(path,t,previousCaptureTime,width,height,duration);renderer.upload(state.cloud,all);renderer.draw(camera,{...settings,present:false});const reference=renderer.capture(camera);
      for(const v of variants){
        renderer.upload(state.cloud,v.selection.indices);renderer.draw(camera,{...settings,present:true});const budgetImage=renderer.capture(camera);
        const pair=evaluateImagePair({referenceRGBA:reference.rgba,budgetRGBA:budgetImage.rgba,referenceDepth:reference.depth,budgetDepth:budgetImage.depth,width,height});
        const current={referenceRGBA:reference.rgba,budgetRGBA:budgetImage.rgba,referenceDepth:reference.depth,viewProjection:camera.viewProjection};
        const temporal=v.previous?temporalResidualMetric({previous:v.previous,current,width,height,cut:camera.cut}):{temporalResidualRgb:null,validPixelCount:0,validPixelFraction:0};
        v.samplesOut.push({time:t,count:v.selection.count,selectionMs:v.selectionMs,candidateMs:v.candidateMs,...pair,...temporal,selectionStats:v.selection.stats});v.previous=current;
      }
      previousCaptureTime=t;if(sample%3===0){status(`Experiment ${sample+1}/${samples}: ${variants.length} variants share a candidate pool / ${path} path`);await nextFrame();}
    }
    for(const v of variants){const a=v.samplesOut,valid=a.filter(x=>Number.isFinite(x.temporalResidualRgb)&&x.validPixelCount>0),n=valid.reduce((s,x)=>s+x.validPixelCount,0);
      records.push({mode:v.mode,stable:v.stable,summary:{maeRgb:mean(a.map(x=>x.maeRgb)),foregroundHoleRate:mean(a.map(x=>x.foregroundHoleRate)),silhouetteMismatchRate:mean(a.map(x=>x.silhouetteMismatchRate)),temporalResidualRgb:n?valid.reduce((s,x)=>s+x.temporalResidualRgb*x.validPixelCount,0)/n:null,selectionMedianMs:percentile(a.map(x=>x.selectionMs),.5),selectionP95Ms:percentile(a.map(x=>x.selectionMs),.95),candidateMedianMs:percentile(a.map(x=>x.candidateMs),.5),minCount:Math.min(...a.map(x=>x.count)),maxCount:Math.max(...a.map(x=>x.count))},samples:a});
    }
    state.results={version:1,kind:'browser-diagnostic',date:new Date().toISOString(),input:state.cloud.name,count:state.cloud.count,cloudMetadata:state.cloud.metadata,featureSources:state.cloud.metadata.featureSources,viewport:{width,height},budget,path,duration,captureHz:(samples-1)/duration,selectionHz:30,selectionSettings,rendering:settings,environment:{userAgent:navigator.userAgent,renderer:renderer.gl.getParameter(renderer.gl.RENDERER)},notes:['Synthetic inputs do not establish generalization to real scans.','Readback synchronizes GPU. Selection timings are CPU wall time, not FPS or GPU performance.','Full-point image is a same-shader reference, not geometric ground truth.','All variants advance at fixed 30Hz using the same candidate pool, including union-retained IDs.','Temporal residual is weighted by valid reference correspondences; cuts are excluded.','Octree traversal is a prototype: streaming, per-level footprints and large-scale optimization remain pending.'],records};
    $('export-results').disabled=false;renderResults(state.results);status('Comparison complete. Export per-frame JSON; results apply only to the current input and settings.');return state.results;
  }finally{renderer.timerEnabled=true;renderer.resize(...oldSize);state.busy=false;for(const {element,disabled} of locked)element.disabled=disabled;$('export-results').disabled=!state.results;resetSelection();}
}
function renderResults(results){
  const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');for(const s of ['Method','Stable','RGB MAE','Holes','Temporal','CPU p50']){const th=document.createElement('th');th.textContent=s;tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');
  for(const record of results.records){const tr=document.createElement('tr'),s=record.summary;for(const v of [labels[record.mode],record.stable?'on':'off',s.maeRgb?.toFixed(4)??'—',s.foregroundHoleRate==null?'—':`${(s.foregroundHoleRate*100).toFixed(1)}%`,s.temporalResidualRgb?.toFixed(4)??'—',`${s.selectionMedianMs?.toFixed(2)} ms`]){const td=document.createElement('td');td.textContent=v;tr.append(td);}body.append(tr);}table.append(body);$('result-table').replaceChildren(table);
}
$('experiment').addEventListener('click',()=>runExperiment().catch(error=>status(error.message,true)));
setCloud(createDemoCloud());resize();requestAnimationFrame(tick);
fetchCatalog().then(entries=>{catalog=entries;for(const entry of entries){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.label;$('dataset').append(option);}const requested=new URLSearchParams(location.search).get('dataset');if(requested&&(entries.some(e=>e.id===requested)||requested==='fixture'||requested==='synthetic'))loadDataset(requested);}).catch(error=>status(error.message,true));
// Read-only diagnostics + explicit experiment hook for reproducible automation.
window.COMP5411={get state(){return {count:state.cloud.count,budget:Number($('budget').value),drawn:renderer.count,selection:state.selection,cloudMetadata:state.cloud.metadata,busy:state.busy,loadingDataset:!!state.loadingDataset,dataset:$('dataset').value,gpuMs:renderer.lastGpuMs,background:state.background,backgroundLoading:state.backgroundLoading};},runExperiment,renderer};
