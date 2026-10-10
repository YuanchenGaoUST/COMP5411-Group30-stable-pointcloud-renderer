// Column-major matrices, column vectors, WebGL NDC z in [-1,1].
export function perspective(fov, aspect, near = 0.03, far = 30) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
export function normalize(v) { const d = Math.hypot(...v) || 1; return v.map(x => x/d); }
export function cross(a,b) { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
export function dot(a,b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
export function lookAt(eye, target, up = [0,1,0]) {
  const z=normalize(eye.map((v,i)=>v-target[i])), x=normalize(cross(up,z)), y=cross(z,x);
  return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
}
export function multiply(a,b) {
  const out = new Float32Array(16);
  for (let c=0;c<4;c++) for (let r=0;r<4;r++) for (let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
  return out;
}
export function makeCamera(eye, target, width, height) {
  const view=lookAt(eye,target), projection=perspective(Math.PI/4,width/height);
  return {eye,position:eye,target,view,projection,viewProjection:multiply(projection,view),width,height,forward:normalize(target.map((v,i)=>v-eye[i]))};
}
