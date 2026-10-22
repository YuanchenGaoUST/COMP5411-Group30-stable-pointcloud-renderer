import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCatalog,fetchCatalog} from '../src/core/catalog.js';
const valid={version:1,datasets:[{id:'jetliner',label:'Jumbo Jet',path:'/data/models/jetliner.json',sourceURL:'https://opengameart.org/content/jumbo-jetwide-body',license:'CC0-1.0',count:15000}]};
test('catalog retains provenance and rejects duplicate ids and unsafe paths',()=>{
  assert.equal(validateCatalog(valid)[0].license,'CC0-1.0');
  assert.throws(()=>validateCatalog({...valid,datasets:[...valid.datasets,...valid.datasets]}),/duplicate/);
  for(const path of ['https://untrusted.invalid/a.json','/data/models/../secret.json','/data/models/a.js'])assert.throws(()=>validateCatalog({version:1,datasets:[{...valid.datasets[0],path}]}),/local/);
});
test('catalog requires actual count, license and source URL',()=>{
  for(const replacement of [{count:100001},{count:0},{license:''},{sourceURL:'javascript:alert(1)'}])assert.throws(()=>validateCatalog({version:1,datasets:[{...valid.datasets[0],...replacement}]}));
});
test('catalog fetch loads local JSON and explains missing assets',async()=>{
  assert.equal((await fetchCatalog(async url=>{assert.equal(url,'/data/catalog.json');return {ok:true,json:async()=>valid};})).length,1);
  await assert.rejects(fetchCatalog(async()=>({ok:false})),/catalog not found/);
});
