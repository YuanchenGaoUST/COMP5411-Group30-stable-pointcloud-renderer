import {SURFEL_VERTEX,SURFEL_FRAGMENT,POST_VERTEX,POST_FRAGMENT} from './shaders.js';

function program(gl,vs,fs){
  const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  const p=gl.createProgram(),v=shader(gl.VERTEX_SHADER,vs),f=shader(gl.FRAGMENT_SHADER,fs);
  gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;
}

export class SurfelRenderer {
  constructor(canvas){
    this.canvas=canvas;this.gl=canvas.getContext('webgl2',{antialias:false,alpha:false,preserveDrawingBuffer:true});
    if(!this.gl)throw new Error('WebGL2 is unavailable. Please try current Chrome, Edge or Firefox with graphics acceleration enabled.');
    const gl=this.gl;this.surfel=program(gl,SURFEL_VERTEX,SURFEL_FRAGMENT);this.post=program(gl,POST_VERTEX,POST_FRAGMENT);
    this.vao=gl.createVertexArray();this.buffer=gl.createBuffer();this.postVAO=gl.createVertexArray();
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for(const [location,size,offset] of [[0,3,0],[1,3,12],[2,3,24],[3,1,36],[4,1,40],[5,1,44]]){
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,48,offset);gl.vertexAttribDivisor(location,1);
    }
    gl.bindVertexArray(null);this.count=0;this.capacity=0;this.data=new Float32Array();this.targets=null;
    this.timerExt=gl.getExtension('EXT_disjoint_timer_query_webgl2');this.pendingQueries=[];this.lastGpuMs=null;this.timerEnabled=true;
    this.resize(1000,650);
  }
  resize(width,height){
    width=Math.max(1,Math.floor(width));height=Math.max(1,Math.floor(height));
    if(this.targets&&width===this.canvas.width&&height===this.canvas.height)return;
    const gl=this.gl;this.canvas.width=width;this.canvas.height=height;
    if(this.targets){for(const t of Object.values(this.targets.textures))gl.deleteTexture(t);gl.deleteFramebuffer(this.targets.geometry);gl.deleteFramebuffer(this.targets.composed);}
    const texture=(internal,format,type)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,format,type,null);return t;};
    const textures={color:texture(gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE),packedDepth:texture(gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE),depth:texture(gl.DEPTH_COMPONENT24,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT),composed:texture(gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE)};
    const geometry=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,geometry);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,textures.color,0);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,textures.packedDepth,0);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,textures.depth,0);gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Geometry framebuffer incomplete');
    const composed=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,composed);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,textures.composed,0);gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Postprocess framebuffer incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);this.targets={textures,geometry,composed};
  }
  upload(cloud,indices){
    if(indices.length>this.capacity){this.capacity=indices.length;this.data=new Float32Array(this.capacity*12);}
    this.count=indices.length;
    for(let j=0;j<indices.length;j++){const i=indices[j],p=i*3,o=j*12;this.data.set(cloud.positions.subarray(p,p+3),o);this.data.set(cloud.normals.subarray(p,p+3),o+3);this.data.set(cloud.colors.subarray(p,p+3),o+6);this.data[o+9]=cloud.radii[i];this.data[o+10]=cloud.geometry[i];this.data[o+11]=cloud.saliency[i];}
    const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,indices.length*12),gl.DYNAMIC_DRAW);
  }
  draw(camera,{radiusScale=1.8,pointMode=false,colorMode=0,edl=true,present=true}={}){
    const gl=this.gl,t=this.targets;
    this.pollTimers();let query=null;
    if(this.timerEnabled&&this.timerExt&&this.pendingQueries.length<8){query=gl.createQuery();gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT,query);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.geometry);gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
    gl.clearBufferfv(gl.COLOR,0,new Float32Array([.025,.055,.095,0]));gl.clearBufferfv(gl.COLOR,1,new Float32Array([1,1,1,0]));gl.clearBufferfv(gl.DEPTH,0,new Float32Array([1]));
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LESS);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);gl.useProgram(this.surfel);gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.surfel,'uViewProjection'),false,camera.viewProjection);gl.uniformMatrix4fv(gl.getUniformLocation(this.surfel,'uView'),false,camera.view);
    gl.uniform1f(gl.getUniformLocation(this.surfel,'uRadiusScale'),radiusScale);gl.uniform1i(gl.getUniformLocation(this.surfel,'uPointMode'),pointMode?1:0);gl.uniform1i(gl.getUniformLocation(this.surfel,'uColorMode'),colorMode);
    gl.drawArraysInstanced(gl.TRIANGLES,0,6,this.count);
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.composed);gl.disable(gl.DEPTH_TEST);gl.bindVertexArray(this.postVAO);gl.useProgram(this.post);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,t.textures.color);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,t.textures.depth);
    gl.uniform1i(gl.getUniformLocation(this.post,'uColor'),0);gl.uniform1i(gl.getUniformLocation(this.post,'uDepth'),1);gl.uniform2f(gl.getUniformLocation(this.post,'uResolution'),this.canvas.width,this.canvas.height);gl.uniform1i(gl.getUniformLocation(this.post,'uEDL'),edl?1:0);gl.drawArrays(gl.TRIANGLES,0,3);
    if(query){gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);this.pendingQueries.push(query);}
    if(present){gl.bindFramebuffer(gl.READ_FRAMEBUFFER,t.composed);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.blitFramebuffer(0,0,this.canvas.width,this.canvas.height,0,0,this.canvas.width,this.canvas.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  pollTimers(){const gl=this.gl;if(!this.timerExt)return;const disjoint=gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);while(this.pendingQueries.length){const q=this.pendingQueries[0];if(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))break;this.pendingQueries.shift();if(!disjoint)this.lastGpuMs=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(q);}if(disjoint)this.lastGpuMs=null;}
  capture(camera){
    const gl=this.gl,width=this.canvas.width,height=this.canvas.height,rgba=new Uint8Array(width*height*4),packed=new Uint8Array(rgba.length),depth=new Float32Array(width*height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.targets.composed);gl.readBuffer(gl.COLOR_ATTACHMENT0);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.targets.geometry);gl.readBuffer(gl.COLOR_ATTACHMENT1);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,packed);
    for(let i=0;i<depth.length;i++)depth[i]=packed[i*4+3]===0?1:(packed[i*4]*65536+packed[i*4+1]*256+packed[i*4+2])/16777215;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);return {rgba,depth,width,height,viewProjection:new Float32Array(camera.viewProjection)};
  }
}
