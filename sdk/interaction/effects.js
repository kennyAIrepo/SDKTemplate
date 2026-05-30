/**
 * hopeOS SDK — Effects Module
 * Volumetric fire (ray-marched simplex noise) and hand glow control.
 *
 * Game integration:
 *   import { FireEffect } from './interaction/effects.js'
 *   const fire = new FireEffect(scene);
 *   fire.active = true;
 *   fire.update(sceneHandLandmarks, dt);
 */
import * as THREE from 'three';

// ── Fire gradient texture (procedural 1D) ──
function createFireGradient() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.0, '#000000'); g.addColorStop(0.15, '#200800');
  g.addColorStop(0.3, '#801000'); g.addColorStop(0.45, '#e03000');
  g.addColorStop(0.6, '#ff6000'); g.addColorStop(0.75, '#ffa020');
  g.addColorStop(0.88, '#ffdd60'); g.addColorStop(1.0, '#fffff0');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const FIRE_VERT = `varying vec3 vWorldPos;void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);vWorldPos=(modelMatrix*vec4(position,1.0)).xyz;}`;

const FIRE_FRAG = `
uniform vec3 color;uniform float time;uniform float seed;
uniform mat4 invModelMatrix;uniform vec3 scale;
uniform vec4 noiseScale;uniform float magnitude;uniform float lacunarity;uniform float gain;
uniform sampler2D fireTex;
varying vec3 vWorldPos;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
  vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;
  vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float turbulence(vec3 p){float sum=0.,freq=1.,amp=1.;for(int i=0;i<3;i++){sum+=abs(snoise(p*freq))*amp;freq*=lacunarity;amp*=gain;}return sum;}
vec4 samplerFire(vec3 p,vec4 sc){
  vec2 st=vec2(sqrt(dot(p.xz,p.xz)),p.y);
  if(st.x<=0.||st.x>=1.||st.y<=0.||st.y>=1.)return vec4(0.);
  p.y-=(seed+time)*sc.w;p*=sc.xyz;
  st.y+=sqrt(st.y)*magnitude*turbulence(p);
  if(st.y<=0.||st.y>=1.)return vec4(0.);
  return texture2D(fireTex,st);
}
vec3 localize(vec3 p){return(invModelMatrix*vec4(p,1.)).xyz;}
void main(){
  vec3 rayPos=vWorldPos;vec3 rayDir=normalize(rayPos-cameraPosition);
  float rayLen=0.0288*length(scale.xyz);
  vec4 col=vec4(0.);
  for(int i=0;i<20;i++){rayPos+=rayDir*rayLen;vec3 lp=localize(rayPos);lp.y+=0.5;lp.xz*=2.;col+=samplerFire(lp,noiseScale);}
  col.a=col.r;gl_FragColor=col;
}`;

function createFireMesh(targetScene) {
  const mat = new THREE.ShaderMaterial({
    defines: { ITERATIONS: '20', OCTIVES: '3' },
    uniforms: {
      fireTex: { value: createFireGradient() },
      color: { value: new THREE.Color(0xeeeeee) },
      time: { value: 0 }, seed: { value: Math.random() * 19.19 },
      invModelMatrix: { value: new THREE.Matrix4() },
      scale: { value: new THREE.Vector3(1, 1, 1) },
      noiseScale: { value: new THREE.Vector4(1, 2, 1, 0.3) },
      magnitude: { value: 1.3 }, lacunarity: { value: 2.0 }, gain: { value: 0.5 }
    },
    vertexShader: FIRE_VERT, fragmentShader: FIRE_FRAG,
    transparent: true, depthWrite: false, depthTest: false
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  m.visible = false;
  if (targetScene) targetScene.add(m);
  return m;
}

export class FireEffect {
  constructor(targetScene) {
    this.active = false;
    this.rightMesh = createFireMesh(targetScene);
    this.leftMesh = createFireMesh(targetScene);
    this._time = 0;
  }

  /** Update fire on both hands. sls = [rightSceneLandmarks, leftSceneLandmarks] */
  update(rightSl, leftSl, dt) {
    if (!this.active) {
      this.rightMesh.visible = false;
      this.leftMesh.visible = false;
      return;
    }
    this._time += dt * 0.8;
    this._updateMesh(this.rightMesh, rightSl);
    this._updateMesh(this.leftMesh, leftSl);
  }

  _updateMesh(fm, sl) {
    if (!sl || !this.active) { fm.visible = false; return; }
    fm.visible = true;
    const w = sl[0], m9 = sl[9], i5 = sl[5], pk = sl[17];
    const cx = (w.x + m9.x + i5.x + pk.x) / 4;
    const cy = (w.y + m9.y + i5.y + pk.y) / 4;
    const cz = (w.z + m9.z + i5.z + pk.z) / 4;
    const handSize = Math.sqrt((m9.x - w.x) ** 2 + (m9.y - w.y) ** 2 + (m9.z - w.z) ** 2);
    const s = handSize * 1.8;
    fm.position.set(cx, cy + s * 0.3, cz);
    fm.scale.set(s, s * 1.4, s);
    fm.updateMatrixWorld();
    fm.material.uniforms.invModelMatrix.value.copy(fm.matrixWorld).invert();
    fm.material.uniforms.scale.value.copy(fm.scale);
    fm.material.uniforms.time.value = this._time;
  }
}
