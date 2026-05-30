/**
 * hopeOS SDK — Hands Module
 * 42-point hand deformation with holographic Fresnel shader.
 * Hands conform to any registered collider (sphere or mesh via BVH).
 *
 * Game integration:
 *   import { RiggedHand, REST_R42, REST_L42 } from './core/hands.js'
 *   const rh = new RiggedHand(REST_R42, scene);
 *   rh.init(positions, normals, uvs, indices);
 *   rh.deform(landmarks3d, colliders);  // landmarks already in scene space
 */
import * as THREE from 'three';
import { colliders as defaultColliders, getFaceNormal } from '../interaction/colliders.js';

// ── Hand deform config ──
const K = 5; // k-nearest landmarks per vertex

// ── 42-point rest poses (21 MediaPipe + 21 computed inner landmarks) ──
export const REST_R42 = [[-0.5444,-0.0146,-0.0642],[-0.5444,0.0861,-0.0661],[-0.5039,0.2035,-0.0832],[-0.4630,0.3090,-0.0951],[-0.4094,0.3828,-0.1013],[-0.3664,0.2333,-0.2469],[-0.3256,0.3046,-0.2561],[-0.2678,0.3497,-0.2329],[-0.1941,0.4165,-0.1704],[-0.3242,0.1728,-0.2354],[-0.2528,0.2412,-0.2539],[-0.1915,0.2954,-0.2142],[-0.1246,0.3386,-0.1585],[-0.2595,0.0978,-0.2171],[-0.2125,0.1275,-0.2089],[-0.1349,0.1732,-0.1740],[-0.0925,0.2225,-0.1185],[-0.2269,0.0154,-0.1584],[-0.1815,0.0349,-0.1444],[-0.1283,0.0696,-0.1028],[-0.0958,0.1168,-0.0554],[-0.6102,-0.0537,-0.2047],[-0.5915,0.1313,-0.1828],[-0.5333,0.2436,-0.1749],[-0.4564,0.3158,-0.1746],[-0.4143,0.3944,-0.1523],[-0.4259,0.2015,-0.3209],[-0.3284,0.3077,-0.3211],[-0.2496,0.3732,-0.2810],[-0.1874,0.4195,-0.2083],[-0.3597,0.1516,-0.3366],[-0.2364,0.2478,-0.3148],[-0.1824,0.3028,-0.2743],[-0.1113,0.3483,-0.2002],[-0.3156,0.0598,-0.3027],[-0.1900,0.1355,-0.2753],[-0.1200,0.1819,-0.2311],[-0.0725,0.2391,-0.1628],[-0.2717,0.0039,-0.2503],[-0.1635,0.0402,-0.2022],[-0.0999,0.0902,-0.1409],[-0.0666,0.1299,-0.0854]];
export const REST_L42 = REST_R42.map(p => [-p[0], p[1], p[2]]);

// ── Utilities ──
function v3a(a) { return a.map(p => new THREE.Vector3(p[0], p[1], p[2])); }

export function buildFrame(lm) {
  const w = lm[0], m = lm[9], i = lm[5], p = lm[17];
  const yV = new THREE.Vector3().subVectors(m, w);
  const s = yV.length();
  if (s < 0.0001) return null;
  const yD = yV.clone().divideScalar(s);
  const ac = new THREE.Vector3().subVectors(i, p);
  const zD = new THREE.Vector3().crossVectors(yD, ac).normalize();
  const xD = new THREE.Vector3().crossVectors(yD, zD).normalize();
  const mt = new THREE.Matrix4().makeBasis(
    xD.multiplyScalar(s), yD.multiplyScalar(s), zD.multiplyScalar(s)
  );
  mt.setPosition(w);
  return mt;
}

// ── Holographic Fresnel shader ──
const HAND_VERT = `
varying vec3 vN, vV, vW;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;

const HAND_FRAG = `
uniform float uTime;
uniform float uGlow;
varying vec3 vN, vV, vW;
void main() {
  float f = pow(1.0 - abs(dot(vN, vV)), 1.8);
  vec3 c = mix(vec3(0.15, 0.4, 0.6), vec3(0.3, 0.7, 0.9), 0.5 + f * 0.5)
          + vec3(0.5, 0.9, 1.0) * f * 0.6;
  c += vec3(0.3, 0.15, 0.0) * uGlow;
  c *= sin(vW.y * 80.0 + uTime * 1.5) * 0.08 + 0.92;
  gl_FragColor = vec4(c, 0.35 + f * 0.35 + uGlow * 0.15);
}`;

// ── RiggedHand class ──
export class RiggedHand {
  constructor(restCoords42, targetScene) {
    this.rv = v3a(restCoords42);
    this.rf = buildFrame(this.rv.slice(0, 21));
    this.rfi = new THREE.Matrix4().copy(this.rf).invert();
    this.rl42 = this.rv.map(p => p.clone().applyMatrix4(this.rfi));
    this.lOff = [];
    for (let i = 0; i < 21; i++) {
      this.lOff.push(new THREE.Vector3().subVectors(this.rl42[21 + i], this.rl42[i]));
    }
    this.mesh = null;
    this.vc = 0;
    this.lv = null;
    this.li = null;
    this.lw = null;
    this.grp = new THREE.Group();
    this.grp.visible = false;
    if (targetScene) targetScene.add(this.grp);
    this.uniforms = { uTime: { value: 0 }, uGlow: { value: 0 } };
  }

  /** Initialize with geometry data (from split GLTF hand model) */
  init(pos, norm, uv, idx) {
    this.vc = pos.length / 3;
    this.lv = new Float32Array(this.vc * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < this.vc; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      v.applyMatrix4(this.rfi);
      this.lv[i * 3] = v.x; this.lv[i * 3 + 1] = v.y; this.lv[i * 3 + 2] = v.z;
    }

    // Compute k-nearest landmark weights per vertex
    this.li = new Uint8Array(this.vc * K);
    this.lw = new Float32Array(this.vc * K);
    for (let vi = 0; vi < this.vc; vi++) {
      const vx = this.lv[vi * 3], vy = this.lv[vi * 3 + 1], vz = this.lv[vi * 3 + 2];
      const d = [];
      for (let li = 0; li < 42; li++) {
        const r = this.rl42[li];
        d.push({ i: li, d: Math.sqrt((vx - r.x) ** 2 + (vy - r.y) ** 2 + (vz - r.z) ** 2) });
      }
      d.sort((a, b) => a.d - b.d);
      let ws = 0;
      for (let k = 0; k < K; k++) { const w = 1 / (d[k].d ** 3 + 0.00001); d[k].w = w; ws += w; }
      for (let k = 0; k < K; k++) { this.li[vi * K + k] = d[k].i; this.lw[vi * K + k] = d[k].w / ws; }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.vc * 3), 3));
    if (norm) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3));
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    if (idx) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: HAND_VERT, fragmentShader: HAND_FRAG,
      uniforms: this.uniforms,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    }));
    this.grp.add(this.mesh);
  }

  /**
   * Deform hand mesh to match tracked landmarks.
   * @param {THREE.Vector3[]} sl - 21 hand landmarks in scene space
   * @param {Array} cols - collider array (defaults to global registry)
   * @returns {THREE.Vector3[]|null} landmarks passed through, or null if hidden
   */
  deform(sl, cols = defaultColliders) {
    if (!this.mesh || !sl) { this.grp.visible = false; return null; }
    const cf = buildFrame(sl);
    if (!cf) { this.grp.visible = false; return null; }
    this.grp.visible = true;

    const ci = new THREE.Matrix4().copy(cf).invert();
    const clf = sl.map(p => p.clone().applyMatrix4(ci));
    const cl = [];
    for (let i = 0; i < 21; i++) cl.push(clf[i]);
    for (let i = 0; i < 21; i++) cl.push(clf[i].clone().add(this.lOff[i]));

    // Compute per-landmark displacement from rest pose
    const dx = new Float32Array(42), dy = new Float32Array(42), dz = new Float32Array(42);
    for (let i = 0; i < 42; i++) {
      let x = cl[i].x - this.rl42[i].x;
      let y = cl[i].y - this.rl42[i].y;
      let z = cl[i].z - this.rl42[i].z;
      const m = Math.sqrt(x * x + y * y + z * z);
      if (m > 1.5) { const s = 1.5 / m; x *= s; y *= s; z *= s; }
      dx[i] = x; dy[i] = y; dz[i] = z;
    }

    const pa = this.mesh.geometry.getAttribute('position').array;
    const v = new THREE.Vector3();
    let cc = 0;
    const _lv = new THREE.Vector3();
    const _tgt = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

    for (let vi = 0; vi < this.vc; vi++) {
      let px = this.lv[vi * 3], py = this.lv[vi * 3 + 1], pz = this.lv[vi * 3 + 2];
      for (let k = 0; k < K; k++) {
        const li = this.li[vi * K + k], w = this.lw[vi * K + k];
        px += dx[li] * w; py += dy[li] * w; pz += dz[li] * w;
      }
      v.set(px, py, pz);
      v.applyMatrix4(cf);

      // ── Multi-collider: iterate all registered colliders ──
      for (let ci2 = 0; ci2 < cols.length; ci2++) {
        const c = cols[ci2];
        if (!c.active) continue;

        if (c.type === 'sphere') {
          // Sphere collision (fast path)
          const d = v.distanceTo(c.center);
          if (d < c.radius) {
            const dir = v.clone().sub(c.center);
            if (dir.length() > 0.0001) {
              dir.normalize().multiplyScalar(c.radius);
              v.copy(c.center).add(dir);
            }
            cc++;
          }
        } else if (c.type === 'mesh' && c.bvh) {
          // BVH mesh collision (conforms to actual geometry)
          c.mesh.updateMatrixWorld();
          c.boundCenter.setFromMatrixPosition(c.mesh.matrixWorld);
          const worldRadius = c.boundRadius * Math.max(
            c.mesh.scale.x, c.mesh.scale.y, c.mesh.scale.z
          );
          if (v.distanceTo(c.boundCenter) > worldRadius + 0.05) continue;

          c._invMat.copy(c.mesh.matrixWorld).invert();
          _lv.copy(v).applyMatrix4(c._invMat);
          _tgt.distance = Infinity;
          const r = c.bvh.closestPointToPoint(_lv, _tgt, 0, 0.08);
          if (r && _tgt.distance < 0.025) {
            const fn = getFaceNormal(c.mesh.geometry, _tgt.faceIndex);
            const toV = _lv.clone().sub(_tgt.point);
            if (toV.dot(fn) < 0) {
              const surfW = _tgt.point.clone().applyMatrix4(c.mesh.matrixWorld);
              const nW = fn.clone().transformDirection(c.mesh.matrixWorld);
              v.copy(surfW).addScaledVector(nW, 0.003);
              cc++;
            }
          }
        }
      }

      pa[vi * 3] = v.x; pa[vi * 3 + 1] = v.y; pa[vi * 3 + 2] = v.z;
    }

    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.uniforms.uGlow.value += ((cc > 20 ? 0.5 : 0) - this.uniforms.uGlow.value) * 0.15;
    return sl;
  }
}
