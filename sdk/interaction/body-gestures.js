/**
 * hopeOS SDK — Body Pose Gestures
 * Interprets MediaPipe 33-point pose landmarks into body gestures.
 * Tracks joint angles, relative positions, and temporal patterns.
 *
 * Game integration:
 *   import { BodyGestureDetector } from './interaction/body-gestures.js'
 *   const bg = new BodyGestureDetector();
 *   bg.on('jump', (height, duration) => { ... });
 *   bg.on('squat', (depth) => { ... });
 *   bg.on('dodge', (direction) => { ... });
 *   bg.on('kick', (side, angle) => { ... });
 *   bg.update(poseLandmarks);  // raw 33-pt normalized landmarks, each frame
 *
 * Detected gestures:
 *   jump, squat, leanLeft, leanRight, turnLeft, turnRight,
 *   duck, armRaiseLeft, armRaiseRight, armsRaisedBoth, tpose,
 *   kickLeft, kickRight, runInPlace, headNod, headShake,
 *   handOnFace, handsOnHips
 */

// ── MediaPipe Pose Landmark Indices ──
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_FOOT: 31, RIGHT_FOOT: 32,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_HEEL: 29, RIGHT_HEEL: 30
};
export { LM as POSE_LANDMARKS };

// ── Joint angle calculation (three-point angle in degrees) ──
export function jointAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs(radians * 180.0 / Math.PI);
  if (angle > 180.0) angle = 360 - angle;
  return angle;
}

/** Distance between two landmarks (normalized coords) */
function dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 }; }

const HISTORY_SIZE = 30; // ~0.5s at 60fps

export class BodyGestureDetector {
  constructor(opts = {}) {
    this._listeners = {};
    this._cooldowns = {};
    this._cooldownMs = opts.cooldownMs || 500;

    // Temporal tracking
    this._history = [];        // [{hipMidY, shoulderMidX, hipMidX, noseY, kneeL_Y, kneeR_Y, t}]
    this._calibration = null;  // baseline standing pose (set after ~30 frames)
    this._frameCount = 0;

    // State for duration tracking
    this._jumpStart = 0;
    this._squatStart = 0;
    this._isJumping = false;
    this._isSquatting = false;
  }

  on(gesture, callback) {
    if (!this._listeners[gesture]) this._listeners[gesture] = [];
    this._listeners[gesture].push(callback);
    return this;
  }

  off(gesture, callback) {
    const list = this._listeners[gesture];
    if (list) this._listeners[gesture] = list.filter(cb => cb !== callback);
  }

  _emit(gesture, ...args) {
    const now = performance.now();
    if (this._cooldowns[gesture] && now - this._cooldowns[gesture] < this._cooldownMs) return;
    this._cooldowns[gesture] = now;
    for (const cb of (this._listeners[gesture] || [])) cb(...args);
  }

  /**
   * Feed raw 33-point pose landmarks each frame.
   * Also returns a snapshot of computed body state for direct polling.
   */
  update(lm) {
    if (!lm || lm.length < 33) return null;
    const now = performance.now();
    this._frameCount++;

    // ── Compute key body metrics ──
    const hipMid = midpoint(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]);
    const shoulderMid = midpoint(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
    const shoulderWidth = dist2d(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);

    const state = {
      hipMidY: hipMid.y,
      shoulderMidX: shoulderMid.x,
      shoulderMidY: shoulderMid.y,
      hipMidX: hipMid.x,
      noseY: lm[LM.NOSE].y,
      noseX: lm[LM.NOSE].x,
      shoulderWidth,
      // Joint angles
      leftElbowAngle: jointAngle(lm[LM.LEFT_SHOULDER], lm[LM.LEFT_ELBOW], lm[LM.LEFT_WRIST]),
      rightElbowAngle: jointAngle(lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_ELBOW], lm[LM.RIGHT_WRIST]),
      leftKneeAngle: jointAngle(lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE], lm[LM.LEFT_ANKLE]),
      rightKneeAngle: jointAngle(lm[LM.RIGHT_HIP], lm[LM.RIGHT_KNEE], lm[LM.RIGHT_ANKLE]),
      leftHipAngle: jointAngle(lm[LM.LEFT_SHOULDER], lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE]),
      rightHipAngle: jointAngle(lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_HIP], lm[LM.RIGHT_KNEE]),
      leftShoulderAngle: jointAngle(lm[LM.LEFT_ELBOW], lm[LM.LEFT_SHOULDER], lm[LM.LEFT_HIP]),
      rightShoulderAngle: jointAngle(lm[LM.RIGHT_ELBOW], lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_HIP]),
      // Shoulder tilt (rotation indicator)
      shoulderTilt: lm[LM.LEFT_SHOULDER].y - lm[LM.RIGHT_SHOULDER].y,
      // Body facing (Z-depth difference between shoulders — turn detection)
      shoulderDepthDiff: (lm[LM.LEFT_SHOULDER].z || 0) - (lm[LM.RIGHT_SHOULDER].z || 0),
      t: now
    };

    this._history.push(state);
    if (this._history.length > HISTORY_SIZE) this._history.shift();

    // Calibrate standing baseline from first 30 frames
    if (this._frameCount === 30) {
      this._calibration = { ...state };
    }
    const cal = this._calibration || state;

    // ── Jump: hip Y rises above baseline (Y decreases in normalized coords) ──
    const jumpDelta = cal.hipMidY - state.hipMidY;
    if (jumpDelta > 0.08) {
      if (!this._isJumping) { this._isJumping = true; this._jumpStart = now; }
      const duration = (now - this._jumpStart) / 1000;
      this._emit('jump', jumpDelta, duration);
    } else if (this._isJumping && jumpDelta < 0.03) {
      const duration = (now - this._jumpStart) / 1000;
      this._emit('land', duration);
      this._isJumping = false;
    }

    // ── Squat: hip Y drops below baseline ──
    const squatDelta = state.hipMidY - cal.hipMidY;
    if (squatDelta > 0.06 && state.leftKneeAngle < 140 && state.rightKneeAngle < 140) {
      if (!this._isSquatting) { this._isSquatting = true; this._squatStart = now; }
      const duration = (now - this._squatStart) / 1000;
      this._emit('squat', squatDelta, duration);
    } else if (this._isSquatting) {
      this._emit('standUp');
      this._isSquatting = false;
    }

    // ── Duck: nose drops significantly (quick duck/dodge) ──
    if (this._history.length >= 5) {
      const prev = this._history[this._history.length - 5];
      const noseDrop = state.noseY - prev.noseY;
      if (noseDrop > 0.08) this._emit('duck', noseDrop);
    }

    // ── Lean left/right: shoulder midpoint shifts relative to hip midpoint ──
    const leanX = state.shoulderMidX - state.hipMidX;
    if (Math.abs(leanX) > 0.04) {
      this._emit(leanX < 0 ? 'leanLeft' : 'leanRight', Math.abs(leanX));
    }

    // ── Shoulder tilt (body rotation indicator) ──
    if (Math.abs(state.shoulderTilt) > 0.04) {
      this._emit(state.shoulderTilt > 0 ? 'tiltLeft' : 'tiltRight', Math.abs(state.shoulderTilt));
    }

    // ── Turn: shoulder depth difference (one shoulder closer to camera) ──
    if (Math.abs(state.shoulderDepthDiff) > 0.08) {
      this._emit(state.shoulderDepthDiff > 0 ? 'turnLeft' : 'turnRight', Math.abs(state.shoulderDepthDiff));
    }

    // ── Arm raise: wrist above shoulder ──
    if (lm[LM.LEFT_WRIST].y < lm[LM.LEFT_SHOULDER].y - 0.05) {
      this._emit('armRaiseLeft', lm[LM.LEFT_SHOULDER].y - lm[LM.LEFT_WRIST].y);
    }
    if (lm[LM.RIGHT_WRIST].y < lm[LM.RIGHT_SHOULDER].y - 0.05) {
      this._emit('armRaiseRight', lm[LM.RIGHT_SHOULDER].y - lm[LM.RIGHT_WRIST].y);
    }
    if (lm[LM.LEFT_WRIST].y < lm[LM.LEFT_SHOULDER].y - 0.05 &&
        lm[LM.RIGHT_WRIST].y < lm[LM.RIGHT_SHOULDER].y - 0.05) {
      this._emit('armsRaisedBoth');
    }

    // ── T-pose: arms extended horizontally (shoulder angles ~90°, elbows straight) ──
    if (state.leftShoulderAngle > 70 && state.leftShoulderAngle < 110 &&
        state.rightShoulderAngle > 70 && state.rightShoulderAngle < 110 &&
        state.leftElbowAngle > 150 && state.rightElbowAngle > 150) {
      this._emit('tpose');
    }

    // ── Kick: foot rises significantly above ankle baseline ──
    const leftFootRise = cal.hipMidY - lm[LM.LEFT_ANKLE].y;
    const rightFootRise = cal.hipMidY - lm[LM.RIGHT_ANKLE].y;
    if (leftFootRise > 0.15 && state.leftKneeAngle > 100) {
      this._emit('kickLeft', state.leftKneeAngle);
    }
    if (rightFootRise > 0.15 && state.rightKneeAngle > 100) {
      this._emit('kickRight', state.rightKneeAngle);
    }

    // ── Run in place: alternating knee lifts ──
    if (this._history.length >= 15) {
      let crossings = 0;
      for (let i = 5; i < this._history.length; i++) {
        const prevDiff = this._history[i - 1].hipMidY - 0.5; // rough knee oscillation proxy
        const currDiff = this._history[i].hipMidY - 0.5;
        if (prevDiff * currDiff < 0) crossings++;
      }
      if (crossings >= 4) this._emit('runInPlace', crossings);
    }

    // ── Head nod/shake ──
    if (this._history.length >= 10) {
      let noseYCrossings = 0, noseXCrossings = 0;
      for (let i = 2; i < Math.min(this._history.length, 15); i++) {
        const pdy = this._history[i].noseY - this._history[i - 1].noseY;
        const ppdy = this._history[i - 1].noseY - this._history[i - 2].noseY;
        if (pdy * ppdy < 0 && Math.abs(pdy) > 0.003) noseYCrossings++;
        const pdx = this._history[i].noseX - this._history[i - 1].noseX;
        const ppdx = this._history[i - 1].noseX - this._history[i - 2].noseX;
        if (pdx * ppdx < 0 && Math.abs(pdx) > 0.003) noseXCrossings++;
      }
      if (noseYCrossings >= 3) this._emit('headNod');
      if (noseXCrossings >= 3) this._emit('headShake');
    }

    // ── Hand on face: wrist near nose ──
    if (dist2d(lm[LM.LEFT_WRIST], lm[LM.NOSE]) < 0.08 ||
        dist2d(lm[LM.RIGHT_WRIST], lm[LM.NOSE]) < 0.08) {
      this._emit('handOnFace');
    }

    // ── Hands on hips: wrists near hip joints ──
    if (dist2d(lm[LM.LEFT_WRIST], lm[LM.LEFT_HIP]) < 0.08 &&
        dist2d(lm[LM.RIGHT_WRIST], lm[LM.RIGHT_HIP]) < 0.08) {
      this._emit('handsOnHips');
    }

    return state;
  }

  /** Get current computed body state without triggering events */
  getState() {
    return this._history.length > 0 ? this._history[this._history.length - 1] : null;
  }

  /** Get current joint angles */
  getJointAngles() {
    const s = this.getState();
    if (!s) return null;
    return {
      leftElbow: s.leftElbowAngle, rightElbow: s.rightElbowAngle,
      leftKnee: s.leftKneeAngle, rightKnee: s.rightKneeAngle,
      leftHip: s.leftHipAngle, rightHip: s.rightHipAngle,
      leftShoulder: s.leftShoulderAngle, rightShoulder: s.rightShoulderAngle
    };
  }
}
