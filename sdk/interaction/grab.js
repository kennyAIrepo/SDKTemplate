/**
 * hopeOS SDK — Grab Interaction
 * Pure math utilities for hand interaction: pinch, palm center, grab/throw.
 * No state — all functions are stateless transforms on landmark data.
 *
 * Game integration:
 *   import { isPinch, palmCenter, handQuaternion, GrabState } from './interaction/grab.js'
 *   if (isPinch(rawLandmarks)) { ... }
 *   const grab = new GrabState();
 *   grab.update(sceneHandLandmarks, objectPosition, objectRadius);
 */
import * as THREE from 'three';

const PINCH_THRESHOLD = 0.065;

/** Check if thumb + index fingertip are pinched (normalized landmark space) */
export function isPinch(lm, threshold = PINCH_THRESHOLD) {
  return Math.hypot(
    lm[4].x - lm[8].x,
    lm[4].y - lm[8].y,
    (lm[4].z || 0) - (lm[8].z || 0)
  ) < threshold;
}

/** Midpoint between thumb tip and index tip in scene space */
export function pinchPoint(sl) {
  return new THREE.Vector3(
    (sl[4].x + sl[8].x) / 2,
    (sl[4].y + sl[8].y) / 2,
    (sl[4].z + sl[8].z) / 2
  );
}

/** Palm center from wrist + finger MCPs in scene space */
export function palmCenter(sl) {
  return new THREE.Vector3(
    (sl[0].x + sl[5].x + sl[9].x + sl[17].x) / 4,
    (sl[0].y + sl[5].y + sl[9].y + sl[17].y) / 4,
    (sl[0].z + sl[5].z + sl[9].z + sl[17].z) / 4
  );
}

/** Hand quaternion from landmark frame (scene space) */
export function handQuaternion(sl) {
  const up = new THREE.Vector3().subVectors(sl[9], sl[0]).normalize();
  const across = new THREE.Vector3().subVectors(sl[5], sl[17]).normalize();
  const forward = new THREE.Vector3().crossVectors(up, across).normalize();
  const right = new THREE.Vector3().crossVectors(up, forward).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, forward)
  );
}

/** Count landmarks near a point (for proximity grab detection) */
export function countNearLandmarks(sl, point, maxDist) {
  const checkIndices = [0, 4, 5, 8, 9, 12, 13, 16, 17, 20];
  let n = 0;
  for (const i of checkIndices) {
    if (sl[i].distanceTo(point) < maxDist) n++;
  }
  return n;
}

/** Minimum landmark distance to a point */
export function minLandmarkDist(sl, point) {
  let m = Infinity;
  for (let i = 0; i < 21; i++) {
    const d = sl[i].distanceTo(point);
    if (d < m) m = d;
  }
  return m;
}

/**
 * Reusable grab/throw state machine.
 * Tracks grab state, computes throw velocity on release.
 */
export class GrabState {
  constructor() {
    this.grabbed = false;
    this.handIndex = -1;
    this.offset = new THREE.Vector3();
    this.quatOffset = new THREE.Quaternion();
    this.velHistory = [];
  }

  /**
   * Update grab state. Returns { grabbed, position, quaternion, releaseVelocity }.
   * @param {THREE.Vector3[]} sl - scene-space hand landmarks
   * @param {THREE.Vector3} objPos - current object position
   * @param {THREE.Quaternion} objQuat - current object quaternion
   * @param {number} grabRadius - how close landmarks must be to grab
   * @param {number} minTouchPoints - minimum landmarks touching to initiate grab
   */
  update(sl, objPos, objQuat, grabRadius, minTouchPoints = 4) {
    const result = { grabbed: false, position: null, quaternion: null, releaseVelocity: null };

    if (!sl) {
      if (this.grabbed) return this._release(objPos);
      return result;
    }

    const dist = minLandmarkDist(sl, objPos);
    const touching = countNearLandmarks(sl, objPos, grabRadius);

    if (!this.grabbed && dist < grabRadius && touching >= minTouchPoints) {
      // Initiate grab
      this.grabbed = true;
      this.offset.subVectors(objPos, palmCenter(sl));
      this.quatOffset.copy(handQuaternion(sl)).invert().multiply(objQuat);
      this.velHistory = [];
    }

    if (this.grabbed) {
      const pc = palmCenter(sl);
      const hq = handQuaternion(sl);
      const prevPos = objPos.clone();
      const newPos = pc.clone().add(this.offset);
      const newQuat = hq.clone().multiply(this.quatOffset);

      // Track velocity for throw
      this.velHistory.push(newPos.clone().sub(prevPos));
      if (this.velHistory.length > 5) this.velHistory.shift();

      // Check if hand moved away (release)
      if (dist > grabRadius * 2 || touching < 2) {
        return this._release(objPos);
      }

      result.grabbed = true;
      result.position = newPos;
      result.quaternion = newQuat;
    }

    return result;
  }

  _release(objPos) {
    this.grabbed = false;
    const vel = new THREE.Vector3();
    for (const v of this.velHistory) vel.add(v);
    if (this.velHistory.length > 0) vel.divideScalar(this.velHistory.length).multiplyScalar(60);
    this.velHistory = [];
    return { grabbed: false, position: null, quaternion: null, releaseVelocity: vel };
  }
}
