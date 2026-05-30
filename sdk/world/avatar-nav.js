/**
 * hopeOS SDK — Avatar Navigator
 * ═══════════════════════════════════════════════════════════════
 *
 * Produces a single unified "movement intent" each frame that drives
 * WorldTemplate.step(). Two input modes, identical output shape:
 *
 *   intent = { forward, strafe, yawDelta, pitchDelta, jump, sprint }
 *
 * Modes:
 *   'keyboard' — classic WASD + mouse-look (fallback)
 *   'gesture'  — bare-hand control (default for spatial)
 *
 * ── GESTURE SCHEME (one-handed, VR-convention based) ───────────────
 * The dominant hand is a pointer-joystick. Two channels:
 *
 *  LOOK (continuous, always active when a hand is tracked):
 *    Hand position on screen steers the camera, joystick-style.
 *      • hand on LEFT third   → yaw left   (turn left)
 *      • hand on RIGHT third  → yaw right  (turn right)
 *      • hand HIGH            → pitch up   (look up)
 *      • hand LOW             → pitch down (look down)
 *    Center deadzone so a resting hand doesn't drift.
 *
 *  LOCOMOTION (discrete gesture sets the walk state):
 *    • POINT  (index out, others curled)  → WALK forward (look dir)
 *    • OPEN   (all 5 fingers spread)      → SPRINT forward
 *    • FIST   (all curled)                → STOP
 *    • JAB UP (index flicked sharply up)  → JUMP
 *    • relaxed / unknown                  → coast to stop
 *
 * Rationale: research on bare-hand VR locomotion (Schäfer et al.)
 * shows one-handed continuous schemes are comfortable and learnable;
 * separating "where the hand is" (look) from "hand shape" (move) keeps
 * the two channels from interfering.
 */

import * as THREE from 'three';

const NAV_DEFAULTS = {
  yawSensitivity:   1.8,    // rad/sec at full deflection
  pitchSensitivity: 1.2,
  deadzoneX:        0.12,   // normalized screen deadzone (half-width)
  deadzoneY:        0.12,
  restY:            0.42,   // hands rest slightly above center → neutral pitch
  jabVelocity:      0.9,    // index-tip upward speed (norm/sec) to fire jump
  mouseSensitivity: 0.002,
};

export class AvatarNavigator {
  constructor(opts = {}) {
    this.cfg = { ...NAV_DEFAULTS, ...opts };
    this.mode = opts.mode || 'gesture';

    // Keyboard state
    this.keys = {};
    this._mouseYaw = 0;
    this._mousePitch = 0;
    this._pointerLocked = false;

    // Gesture state
    this._prevIndexTipY = null;
    this._prevT = performance.now();
    this._walkState = 'stop'; // stop | walk | sprint
    this._lastGesture = 'none';
  }

  setMode(mode) { this.mode = mode; }

  // ── Keyboard wiring (call once) ──
  attachKeyboard(domElement) {
    document.addEventListener('keydown', e => { this.keys[e.code] = true; });
    document.addEventListener('keyup',   e => { this.keys[e.code] = false; });
    if (domElement) {
      domElement.addEventListener('click', () => {
        if (this.mode === 'keyboard') domElement.requestPointerLock();
      });
      document.addEventListener('pointerlockchange', () => {
        this._pointerLocked = document.pointerLockElement === domElement;
      });
      document.addEventListener('mousemove', e => {
        if (!this._pointerLocked || this.mode !== 'keyboard') return;
        this._mouseYaw   -= e.movementX * this.cfg.mouseSensitivity;
        this._mousePitch -= e.movementY * this.cfg.mouseSensitivity;
      });
    }
  }

  /**
   * Compute movement intent for this frame.
   * @param {number} dt
   * @param {Object} frame - hopeOS frame state { hands, handedness, handCount, sceneLandmarks }
   * @returns intent object
   */
  update(dt, frame) {
    if (this.mode === 'keyboard') return this._keyboardIntent(dt);
    return this._gestureIntent(dt, frame);
  }

  // ── Keyboard intent ──
  _keyboardIntent(dt) {
    let forward = 0, strafe = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    forward += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  forward -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) strafe  += 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  strafe  -= 1;

    const yawDelta = this._mouseYaw; this._mouseYaw = 0;
    const pitchDelta = this._mousePitch; this._mousePitch = 0;

    return {
      forward, strafe, yawDelta, pitchDelta,
      jump: !!this.keys['Space'],
      sprint: !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']),
    };
  }

  // ── Gesture intent ──
  _gestureIntent(dt, frame) {
    const intent = { forward: 0, strafe: 0, yawDelta: 0, pitchDelta: 0, jump: false, sprint: false };
    if (!frame || !frame.handCount) {
      this._walkState = 'stop';
      this._lastGesture = 'none';
      this._prevIndexTipY = null;
      return intent;
    }

    // Use the first tracked hand as the controller hand
    const hand = frame.hands[0];
    if (!hand) return intent;

    // ── LOOK channel: hand position steers camera ──
    const wrist = hand[0];
    // wrist.x/y are normalized 0..1 (already selfie-mirrored upstream)
    const dx = wrist.x - 0.5;
    const dy = wrist.y - this.cfg.restY;

    if (Math.abs(dx) > this.cfg.deadzoneX) {
      const mag = (Math.abs(dx) - this.cfg.deadzoneX) / (0.5 - this.cfg.deadzoneX);
      intent.yawDelta = -Math.sign(dx) * mag * this.cfg.yawSensitivity * dt;
      // hand on left (dx<0) → turn left (positive yaw in our YXZ convention)
    }
    if (Math.abs(dy) > this.cfg.deadzoneY) {
      const mag = (Math.abs(dy) - this.cfg.deadzoneY) / (0.5 - this.cfg.deadzoneY);
      intent.pitchDelta = -Math.sign(dy) * mag * this.cfg.pitchSensitivity * dt;
      // hand high (dy<0) → look up
    }

    // ── LOCOMOTION channel: classify hand gesture ──
    const g = this._classify(hand);
    this._lastGesture = g;

    if (g === 'fist') this._walkState = 'stop';
    else if (g === 'open') this._walkState = 'sprint';
    else if (g === 'point') this._walkState = 'walk';
    // 'relaxed'/'unknown' → keep previous state but decay handled by template damping

    if (this._walkState === 'walk') intent.forward = 1;
    else if (this._walkState === 'sprint') { intent.forward = 1; intent.sprint = true; }

    // ── JUMP: sharp upward index jab ──
    const indexTip = hand[8];
    if (this._prevIndexTipY !== null) {
      const vUp = (this._prevIndexTipY - indexTip.y) / dt; // +ve = moving up (y decreases up)
      if (vUp > this.cfg.jabVelocity && (g === 'point' || g === 'open')) {
        intent.jump = true;
      }
    }
    this._prevIndexTipY = indexTip.y;

    return intent;
  }

  /**
   * Classify a hand into a locomotion gesture from its 21 landmarks.
   * Returns 'fist' | 'open' | 'point' | 'relaxed'.
   */
  _classify(lm) {
    // A finger is "extended" if tip is farther from wrist than its PIP joint.
    const wrist = lm[0];
    const ext = (tipI, pipI) => {
      const dTip = Math.hypot(lm[tipI].x - wrist.x, lm[tipI].y - wrist.y);
      const dPip = Math.hypot(lm[pipI].x - wrist.x, lm[pipI].y - wrist.y);
      return dTip > dPip * 1.05;
    };
    const index  = ext(8, 6);
    const middle = ext(12, 10);
    const ring   = ext(16, 14);
    const pinky  = ext(20, 18);

    const extendedCount = [index, middle, ring, pinky].filter(Boolean).length;

    if (extendedCount === 0) return 'fist';
    if (extendedCount >= 4) return 'open';
    if (index && !middle && !ring && !pinky) return 'point';
    return 'relaxed';
  }

  /** Current human-readable gesture (for HUD) */
  get currentGesture() { return this._lastGesture; }
  get walkState() { return this._walkState; }
}
