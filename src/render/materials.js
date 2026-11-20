// Artistic shading presets, not recovered source colors or measured materials.
// Original retains the legacy rendering path for reproducible image comparisons.
const preset=definition=>Object.freeze({...definition,baseColor:Object.freeze(definition.baseColor),specularColor:Object.freeze(definition.specularColor)});
export const MATERIALS=Object.freeze([
  preset({id:'original',label:'Original input',baseColor:[1,1,1],specularColor:[0,0,0],specularStrength:0,exponent:24,edlStrength:14,model:'original-two-sided-diffuse'}),
  preset({id:'azure',label:'Blue enamel',baseColor:[.17,.48,.74],specularColor:[.73,.85,.96],specularStrength:.30,exponent:22,edlStrength:4,model:'artistic-two-sided-diffuse-blinn-phong'}),
  preset({id:'copper',label:'Warm copper',baseColor:[.66,.37,.20],specularColor:[1,.70,.46],specularStrength:.25,exponent:28,edlStrength:4.5,model:'artistic-two-sided-diffuse-blinn-phong'}),
  preset({id:'jade',label:'Jade satin',baseColor:[.19,.57,.43],specularColor:[.63,.91,.77],specularStrength:.24,exponent:20,edlStrength:3.5,model:'artistic-two-sided-diffuse-blinn-phong'}),
]);
export const ORIGINAL_MATERIAL=MATERIALS[0];
export function materialSettings(id='original'){
  const material=MATERIALS.find(item=>item.id===id);
  if(!material)throw new RangeError(`Unknown material: ${id}`);
  return material;
}
