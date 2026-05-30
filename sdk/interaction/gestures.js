/**
 * hopeOS SDK — Gesture Recognition
 * Detects gestures from MediaPipe hand/pose landmarks.
 * Implements the Kinect gesture vocabulary: swipe, punch, jump, squat, wave.
 *
 * Game integration:
 *   import { GestureDetector } from './interaction/gestures.js'
 *   const gd = new GestureDetector();
 *   gd.on('swipeLeft', (hand, speed) => { ... });
 *   gd.on('punch', (hand, velocity) => { ... });
 *   gd.update(handLandmarks, poseLandmarks);  // call each frame
 */
import * as THREE from 'three';

const SWIPE_SPEED_THRESHOLD = 0.25;   // normalized coords per second
const PUNCH_SPEED_THRESHOLD = 0.15;
const JUMP_THRESHOLD = 0.12;          // hip Y delta
const SQUAT_THRESHOLD = 0.08;
const FRAME_BUFFER = 8;               // frames of history

export class GestureDetector {
  constructor() {
    this._listeners = {};
    this._handHistory = [[], []]; // per hand: [{x,y,z,t}...]
    this._poseHistory = [];       // [{hipY, t}...]
    this._cooldowns = {};         // gesture → timestamp of last fire
    this._cooldownMs = 400;       // ms between re-fires of same gesture
  }

  /** Subscribe to gesture events */
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
    const list = this._listeners[gesture];
    if (list) for (const cb of list) cb(...args);
  }

  /**
   * Feed tracking data each frame.
   * @param {Array} hands - array of raw landmark arrays [{x,y,z}...]
   * @param {Array} handedness - ['Left','Right'] per hand
   * @param {Array} poseLandmarks - 33 raw pose landmarks
   */
  update(hands, handedness, poseLandmarks) {
    const now = performance.now();

    // ── Hand gesture detection ──
    if (hands) {
      for (let h = 0; h < Math.min(hands.length, 2); h++) {
        const lm = hands[h];
        if (!lm) continue;
        const wrist = lm[0];
        const side = handedness?.[h] || 'Right';
        const hist = this._handHistory[h];

        hist.push({ x: wrist.x, y: wrist.y, z: wrist.z || 0, t: now });
        if (hist.length > FRAME_BUFFER) hist.shift();
        if (hist.length < 3) continue;

        const oldest = hist[0], newest = hist[hist.length - 1];
        const dt = (newest.t - oldest.t) / 1000;
        if (dt < 0.05) continue;

        const dx = (newest.x - oldest.x) / dt;
        const dy = (newest.y - oldest.y) / dt;
        const speed = Math.sqrt(dx * dx + dy * dy);

        // Swipe detection (horizontal dominant movement)
        if (Math.abs(dx) > SWIPE_SPEED_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) this._emit('swipeLeft', side, Math.abs(dx));
          else this._emit('swipeRight', side, Math.abs(dx));
        }

        // Punch detection (forward Z movement + high speed)
        const dz = ((newest.z || 0) - (oldest.z || 0)) / dt;
        if (Math.abs(dz) > PUNCH_SPEED_THRESHOLD && speed > 0.1) {
          this._emit('punch', side, new THREE.Vector3(dx, dy, dz));
        }

        // Fist detection (all fingertips curled toward palm)
        const palmY = (lm[0].y + lm[5].y + lm[17].y) / 3;
        const tips = [lm[8], lm[12], lm[16], lm[20]];
        const mcps = [lm[5], lm[9], lm[13], lm[17]];
        let fistScore = 0;
        for (let f = 0; f < 4; f++) {
          const tipToMcp = Math.hypot(tips[f].x - mcps[f].x, tips[f].y - mcps[f].y);
          if (tipToMcp < 0.06) fistScore++;
        }
        if (fistScore >= 3) this._emit('fist', side);

        // Open hand detection
        if (fistScore === 0) this._emit('openHand', side);

        // Wave (oscillating X with hand above shoulder zone)
        if (hist.length >= FRAME_BUFFER && wrist.y < 0.35) {
          let zeroCrossings = 0;
          for (let i = 2; i < hist.length; i++) {
            const prevDx = hist[i - 1].x - hist[i - 2].x;
            const currDx = hist[i].x - hist[i - 1].x;
            if (prevDx * currDx < 0) zeroCrossings++;
          }
          if (zeroCrossings >= 3) this._emit('wave', side);
        }
      }
    }

    // ── Pose gesture detection ──
    if (poseLandmarks) {
      const hipY = (poseLandmarks[23].y + poseLandmarks[24].y) / 2;
      this._poseHistory.push({ hipY, t: now });
      if (this._poseHistory.length > FRAME_BUFFER * 2) this._poseHistory.shift();

      if (this._poseHistory.length >= 4) {
        const baseline = this._poseHistory[0].hipY;
        const current = hipY;
        const delta = current - baseline;

        // Jump (hip rises — Y decreases in normalized coords)
        if (delta < -JUMP_THRESHOLD) this._emit('jump', Math.abs(delta));

        // Squat (hip drops — Y increases)
        if (delta > SQUAT_THRESHOLD) this._emit('squat', delta);
      }

      // Lean detection (shoulder midpoint offset from hip midpoint)
      const shoulderMidX = (poseLandmarks[11].x + poseLandmarks[12].x) / 2;
      const hipMidX = (poseLandmarks[23].x + poseLandmarks[24].x) / 2;
      const lean = shoulderMidX - hipMidX;
      if (Math.abs(lean) > 0.05) {
        this._emit(lean < 0 ? 'leanLeft' : 'leanRight', Math.abs(lean));
      }
    }
  }
}
