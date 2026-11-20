import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const han=/\p{Script=Han}/u;

test('viewer declares English and all built-in interface sources are English',async()=>{
  const page=await read('index.html');
  assert.match(page,/<html\s+lang="en">/);
  const files=['index.html','src/main.js','src/styles.css','src/core/catalog.js','src/core/cloud.js','src/render/renderer.js','scripts/serve.py','scripts/build_model_catalog.py'];
  for(const path of files)assert.equal(han.test(await read(path)),false,`${path} contains non-English interface text`);
});

test('built-in dataset names and visible provenance remain English',async()=>{
  const catalog=JSON.parse(await read('data/catalog.json'));
  for(const entry of catalog.datasets){
    assert.equal(han.test(entry.label),false,`${entry.id} label is not English`);
    const cloud=JSON.parse(await read(entry.path.slice(1)));
    for(const text of [cloud.name,cloud.metadata?.source,cloud.metadata?.license])assert.equal(han.test(text??''),false,`${entry.id} has non-English visible metadata`);
  }
  for(const path of (await readdir(new URL('data/',root))).filter(name=>name.endsWith('.json')&&name!=='catalog.json')){
    const cloud=JSON.parse(await read(`data/${path}`));
    for(const text of [cloud.name,cloud.metadata?.source])assert.equal(han.test(text??''),false,`${path} has non-English visible metadata`);
  }
});
