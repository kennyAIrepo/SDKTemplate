/**
 * hopeOS SDK — Body Module
 * Pose landmark mapping, holographic body capsule rendering, floor detection.
 *
 * Game integration:
 *   import { BodyTracker } from './core/body.js'
 *   const body = new BodyTracker(scene);
 *   const pts = body.update(poseLandmarks);  // returns 15 mapped body points
 *   body.floorY  // estimated floor Y position
 */
import * as THREE from 'three';
import { mp2s, sH } from './scene.js';

// ── Body segment definitions: [startIdx, endIdx, name, radius] ──
export const BODY_SEGS = [
  [0, 1, 'head', 0.12], [1, 2, 'torso', 0.18],
  [3, 5, 'uarmL', 0.05], [4, 6, 'uarmR', 0.05],
  [5, 7, 'farmL', 0.04], [6, 8, 'farmR', 0.04],
  [9, 11, 'thighL', 0.07], [10, 12, 'thighR', 0.07],
  [11, 13, 'shinL', 0.05], [12, 14, 'shinR', 0.05]
];

const BODY_SHADER_VERT = `
varying vec3 vN, vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const BODY_SHADER_FRAG = `
varying vec3 vN, vV;
void main() {
  float f = pow(1.0 - abs(dot(vN, vV)), 2.0);
  vec3 c = vec3(0.2, 0.5, 0.7) * (0.3 + f * 0.7);
  gl_FragColor = vec4(c, 0.12 + f * 0.15);
}`;

export class BodyTracker {
  constructor(targetScene) {
    this.floorY = -0.8;
    this.torsoZ = 0;
    this.headPos = new THREE.Vector3();
    this.points = new Array(15).fill(null);

    // Visual mesh group
    this.group = new THREE.Group();
    if (targetScene) targetScene.add(this.group);

    const mat = new THREE.ShaderMaterial({
      vertexShader: BODY_SHADER_VERT, fragmentShader: BODY_SHADER_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    });

    this.segMeshes = [];
    for (const seg of BODY_SEGS) {
      const geo = new THREE.CapsuleGeometry(seg[3], 0.1, 4, 8);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.segMeshes.push(mesh);
    }
  }

  /**
   * Update body from raw MediaPipe pose landmarks (33 normalized points).
   * Returns 15 mapped body points in scene space, or null.
   */
  update(poseLandmarks) {
    if (!poseLandmarks) return null;
    const lm = poseLandmarks;
    const pts = this.points;

    // Map to simplified 15-point body skeleton
    pts[0] = mp2s(lm[0]); // nose
    pts[1] = mp2s({ x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2, z: ((lm[11].z || 0) + (lm[12].z || 0)) / 2 }); // shoulder mid
    pts[2] = mp2s({ x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2, z: ((lm[23].z || 0) + (lm[24].z || 0)) / 2 }); // hip mid
    pts[3] = mp2s(lm[11]); pts[4] = mp2s(lm[12]); // shoulders
    pts[5] = mp2s(lm[13]); pts[6] = mp2s(lm[14]); // elbows
    pts[7] = mp2s(lm[15]); pts[8] = mp2s(lm[16]); // wrists
    pts[9] = mp2s(lm[23]); pts[10] = mp2s(lm[24]); // hips
    pts[11] = mp2s(lm[25]); pts[12] = mp2s(lm[26]); // knees
    pts[13] = mp2s(lm[27]); pts[14] = mp2s(lm[28]); // ankles

    // Floor detection from foot landmarks
    const footLMs = [27, 28, 29, 30, 31, 32];
    let maxScreenY = -999;
    for (const fi of footLMs) {
      if (lm[fi]) {
        const sy = -(lm[fi].y - 0.5) * sH;
        if (sy < maxScreenY || maxScreenY === -999) maxScreenY = sy;
      }
    }
    const newFloor = maxScreenY - 0.05;
    this.floorY += (newFloor - this.floorY) * 0.1;

    // Store body reference points
    this.torsoZ = pts[1] ? pts[1].z : 0;
    this.headPos = pts[0] || new THREE.Vector3();

    // Update visual capsule meshes
    this._updateMeshes(pts);

    return pts;
  }

  /** Returns body collision capsule data for physics integration */
  getCollisionCapsules() {
    return BODY_SEGS.map((seg, i) => {
      const a = this.points[seg[0]], b = this.points[seg[1]];
      if (!a || !b) return null;
      return {
        center: new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
        radius: seg[3],
        name: seg[2]
      };
    }).filter(Boolean);
  }

  _updateMeshes(pts) {
    for (let si = 0; si < BODY_SEGS.length; si++) {
      const [a, b] = BODY_SEGS[si];
      if (!pts[a] || !pts[b]) { this.segMeshes[si].visible = false; continue; }
      this.segMeshes[si].visible = true;
      const mid = new THREE.Vector3().addVectors(pts[a], pts[b]).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(pts[b], pts[a]);
      const len = dir.length();
      this.segMeshes[si].position.copy(mid);
      this.segMeshes[si].scale.set(1, len > 0.01 ? len / 0.3 : 1, 1);
      if (len > 0.01) {
        this.segMeshes[si].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      }
    }
  }
}
