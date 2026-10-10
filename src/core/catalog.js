/** Curated local point clouds, not remotely executed code or live CDN assets. */
export function validateCatalog(data) {
  if(data?.version!==1||!Array.isArray(data.datasets))throw new Error('Unsupported dataset catalog');
  const seen=new Set();
  return data.datasets.map(entry=>{
    if(!entry||typeof entry.id!=='string'||!/^[a-z0-9-]+$/.test(entry.id)||seen.has(entry.id))throw new Error('Invalid or duplicate dataset id');
    if(typeof entry.label!=='string'||!entry.label.trim())throw new Error('Dataset label is missing');
    if(typeof entry.path!=='string'||!/^\/data\/models\/[a-z0-9-]+\.json$/.test(entry.path))throw new Error('Dataset path must be a local model JSON');
    if(typeof entry.sourceURL!=='string'||!/^https:\/\//.test(entry.sourceURL))throw new Error('Dataset source URL is missing');
    if(typeof entry.license!=='string'||!entry.license.trim())throw new Error('Dataset license is missing');
    if(!Number.isInteger(entry.count)||entry.count<1||entry.count>100000)throw new Error('Dataset count is outside interactive limits');
    seen.add(entry.id);return Object.freeze({...entry});
  });
}

export async function fetchCatalog(fetcher=globalThis.fetch) {
  const response=await fetcher('/data/catalog.json');
  if(!response.ok)throw new Error('本地模型目录未找到，请运行数据构建脚本。');
  return validateCatalog(await response.json());
}
