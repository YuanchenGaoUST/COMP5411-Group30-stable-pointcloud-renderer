export const SURFEL_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aRadius;
layout(location=4) in float aGeometry;
layout(location=5) in float aSaliency;
uniform mat4 uViewProjection;
uniform mat4 uView;
uniform float uRadiusScale;
uniform int uPointMode;
out vec2 vDisk;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPosition;
out float vGeometry;
out float vSaliency;
void main() {
  vec2 corners[6] = vec2[6](vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  vec2 corner=corners[gl_VertexID];
  vec3 n=normalize(aNormal);
  vec3 tangent=normalize(cross(abs(n.y)<0.9?vec3(0,1,0):vec3(1,0,0),n));
  vec3 bitangent=cross(n,tangent);
  if (uPointMode==1) {
    tangent=vec3(uView[0][0],uView[1][0],uView[2][0]);
    bitangent=vec3(uView[0][1],uView[1][1],uView[2][1]);
  }
  vec3 world=aPosition+(tangent*corner.x+bitangent*corner.y)*aRadius*uRadiusScale;
  gl_Position=uViewProjection*vec4(world,1.);
  vDisk=corner; vNormal=n; vColor=aColor; vWorldPosition=world; vGeometry=aGeometry; vSaliency=aSaliency;
}`;
export const SURFEL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vDisk;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPosition;
in float vGeometry;
in float vSaliency;
uniform int uColorMode;
uniform vec3 uLightDirection;
uniform float uAmbientLight;
uniform float uSunStrength;
uniform bool uStyledMaterial;
uniform vec3 uCameraPosition;
uniform vec3 uMaterialBaseColor;
uniform vec3 uMaterialSpecularColor;
uniform float uMaterialSpecularStrength;
uniform float uMaterialExponent;
layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outDepth;
void main() {
  if (dot(vDisk,vDisk)>1.0) discard;
  vec3 base=vColor;
  if(uColorMode==1) base=mix(vec3(.05,.4,.7),vec3(1.,.63,.16),clamp(vGeometry,0.,1.));
  if(uColorMode==2) base=mix(vec3(.05,.4,.7),vec3(1.,.63,.16),clamp(vSaliency,0.,1.));
  float light=uAmbientLight+uSunStrength*abs(dot(normalize(vNormal),normalize(uLightDirection)));
  outColor=vec4(base*light,1.);
  if(uStyledMaterial&&uColorMode==0){
    // A broad, sun-driven highlight improves shape readability. Orient the
    // shading normal toward the viewer to tolerate PCA normal sign ambiguity.
    vec3 toCamera=uCameraPosition-vWorldPosition;
    vec3 viewDirection=toCamera*inversesqrt(max(dot(toCamera,toCamera),1e-10));
    vec3 n=normalize(vNormal);
    if(dot(n,viewDirection)<0.) n=-n;
    vec3 lightDirection=normalize(uLightDirection);
    vec3 halfVector=lightDirection+viewDirection;
    vec3 halfDirection=halfVector*inversesqrt(max(dot(halfVector,halfVector),1e-10));
    float highlight=pow(max(dot(n,halfDirection),0.),uMaterialExponent)
      *max(dot(n,lightDirection),0.)*uSunStrength*uMaterialSpecularStrength;
    outColor=vec4(uMaterialBaseColor*light+uMaterialSpecularColor*highlight,1.);
  }
  // Store raw depth in an RGBA8 attachment for portable readPixels.
  float d=floor(gl_FragCoord.z*16777215.0+.5);
  outDepth=vec4(floor(d/65536.),mod(floor(d/256.),256.),mod(d,256.),255.)/255.;
}`;
export const POST_VERTEX = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUV=p;gl_Position=vec4(p*2.-1.,0.,1.); }
`;
export const POST_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform bool uEDL;
uniform float uEDLStrength;
out vec4 outColor;
float viewDepth(float d){float n=.03,f=30.;return 2.*n*f/(f+n-(d*2.-1.)*(f-n));}
void main(){
  vec4 c=texture(uColor,vUV);float d=texture(uDepth,vUV).r;
  if(!uEDL||d>=.999999){outColor=c;return;}
  vec2 offsets[4]=vec2[4](vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1));
  float center=log(max(viewDepth(d),1e-6)),response=0.;
  for(int i=0;i<4;i++){
    float neighbor=texture(uDepth,vUV+offsets[i]*2./uResolution).r;
    if(neighbor<.999999) response+=max(0.,center-log(max(viewDepth(neighbor),1e-6)));
  }
  outColor=vec4(c.rgb*exp(-response*uEDLStrength),c.a);
}`;

// This pass only writes to the visible canvas. The composed framebuffer remains
// the original solid-background image used by capture() and evaluation metrics.
export const DISPLAY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBackground;
uniform vec2 uBackgroundScale;
out vec4 outColor;
void main(){
  vec4 scene=texture(uScene,vUV);
  vec2 backgroundUV=(vUV-.5)*uBackgroundScale+.5;
  vec3 background=texture(uBackground,backgroundUV).rgb;
  outColor=vec4(mix(background,scene.rgb,scene.a),1.);
}`;
