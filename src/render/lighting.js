// World-space direction from the surface toward the sun. Preserve the original
// vector exactly at the default/reset position for existing image experiments.
const ORIGINAL_DIRECTION=Object.freeze([.4,.8,.65]);
export const DEFAULT_SUN=Object.freeze({
  azimuth:Math.atan2(.4,.65)*180/Math.PI,
  elevation:Math.atan2(.8,Math.hypot(.4,.65))*180/Math.PI,
  intensity:1,
});

export function sunlightSettings({azimuth=DEFAULT_SUN.azimuth,elevation=DEFAULT_SUN.elevation,intensity=DEFAULT_SUN.intensity}={}){
  const a=azimuth*Math.PI/180,e=elevation*Math.PI/180;
  // HTML range values may round their decimal representation on assignment.
  const direction=Math.abs(azimuth-DEFAULT_SUN.azimuth)<1e-10&&Math.abs(elevation-DEFAULT_SUN.elevation)<1e-10
    ? [...ORIGINAL_DIRECTION]
    : [Math.sin(a)*Math.cos(e),Math.sin(e),Math.cos(a)*Math.cos(e)];
  // Two-sided shading is insensitive to the sign ambiguity of PCA normals.
  return {azimuth,elevation,intensity,direction,ambient:.42,diffuse:.58,model:'two-sided-diffuse',castShadows:false};
}

export const DEFAULT_LIGHTING=Object.freeze(sunlightSettings());
