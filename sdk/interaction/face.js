/**
 * hopeOS SDK — Face Expression Module
 * Interprets MediaPipe FaceLandmarker's 478 landmarks and 52 blendshapes
 * into game-ready facial expression events.
 *
 * Game integration:
 *   import { FaceExpressionDetector } from './interaction/face.js'
 *   const face = new FaceExpressionDetector();
 *   face.on('blink', (side) => { ... });               // 'left'|'right'|'both'
 *   face.on('eyesClosed', (duration) => { ... });       // eyes shut > threshold
 *   face.on('smile', (intensity) => { ... });           // 0-1
 *   face.on('mouthOpen', (amount) => { ... });          // 0-1
 *   face.on('surprise', (intensity) => { ... });        // brows up + eyes wide
 *   face.on('frown', (intensity) => { ... });           // brows down
 *   face.on('eyesWide', (intensity) => { ... });        // startled
 *   face.on('kiss', (intensity) => { ... });            // lips puckered
 *   face.on('tongueOut', (intensity) => { ... });       // tongue visible
 *   face.on('cheekPuff', (intensity) => { ... });       // cheeks inflated
 *   face.on('lookLeft', (amount) => { ... });           // gaze direction
 *   face.on('lookRight', (amount) => { ... });
 *   face.on('lookUp', (amount) => { ... });
 *   face.on('lookDown', (amount) => { ... });
 *   face.update(faceResult);  // from tracking.js
 *
 * The 52 MediaPipe blendshapes:
 *   _neutral, browDownLeft, browDownRight, browInnerUp, browOuterUpLeft,
 *   browOuterUpRight, cheekPuff, cheekSquintLeft, cheekSquintRight,
 *   eyeBlinkLeft, eyeBlinkRight, eyeLookDownLeft, eyeLookDownRight,
 *   eyeLookInLeft, eyeLookInRight, eyeLookOutLeft, eyeLookOutRight,
 *   eyeLookUpLeft, eyeLookUpRight, eyeSquintLeft, eyeSquintRight,
 *   eyeWideLeft, eyeWideRight, jawForward, jawLeft, jawOpen, jawRight,
 *   mouthClose, mouthDimpleLeft, mouthDimpleRight, mouthFrownLeft,
 *   mouthFrownRight, mouthFunnel, mouthLeft, mouthLowerDownLeft,
 *   mouthLowerDownRight, mouthPressLeft, mouthPressRight, mouthPucker,
 *   mouthRight, mouthRollLower, mouthRollUpper, mouthShrugLower,
 *   mouthShrugUpper, mouthSmileLeft, mouthSmileRight, mouthStretchLeft,
 *   mouthStretchRight, mouthUpperUpLeft, mouthUpperUpRight, noseSneerLeft,
 *   noseSneerRight
 */

const BLINK_THRESHOLD = 0.4;
const EYES_CLOSED_THRESHOLD = 0.6;
const SMILE_THRESHOLD = 0.3;
const MOUTH_OPEN_THRESHOLD = 0.3;
const BROW_THRESHOLD = 0.3;
const EYE_WIDE_THRESHOLD = 0.4;
const PUCKER_THRESHOLD = 0.4;
const GAZE_THRESHOLD = 0.3;

export class FaceExpressionDetector {
  constructor(opts = {}) {
    this._listeners = {};
    this._cooldowns = {};
    this._cooldownMs = opts.cooldownMs || 300;

    // State tracking
    this._leftEyeClosed = false;
    this._rightEyeClosed = false;
    this._eyesClosedStart = 0;
    this._blendshapes = null;   // latest raw blendshapes map
    this._landmarks = null;      // latest 478 landmarks

    // Composite expression state (readable by game each frame)
    this.state = {
      smiling: false, smileIntensity: 0,
      mouthOpen: false, mouthOpenAmount: 0,
      leftEyeClosed: false, rightEyeClosed: false, bothEyesClosed: false,
      eyesClosedDuration: 0,
      surprised: false, surpriseIntensity: 0,
      frowning: false, frownIntensity: 0,
      lookDirection: { x: 0, y: 0 }, // -1 to 1, left/right and up/down
      kissing: false, kissIntensity: 0,
      cheeksPuffed: false
    };
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

  _emit(name, ...args) {
    const now = performance.now();
    if (this._cooldowns[name] && now - this._cooldowns[name] < this._cooldownMs) return;
    this._cooldowns[name] = now;
    for (const cb of (this._listeners[name] || [])) cb(...args);
  }

  /**
   * Feed face detection result each frame.
   * @param {Object} faceResult - { landmarks: [{x,y,z}...], blendshapes: [{categoryName, score}...] }
   */
  update(faceResult) {
    if (!faceResult) return this.state;
    const now = performance.now();

    if (faceResult.landmarks) this._landmarks = faceResult.landmarks;

    // ── Parse blendshapes into map ──
    if (faceResult.blendshapes) {
      const bs = {};
      for (const b of faceResult.blendshapes) {
        bs[b.categoryName] = b.score;
      }
      this._blendshapes = bs;
    }

    const bs = this._blendshapes;
    if (!bs) return this.state;

    // ── Blink detection ──
    const leftBlink = (bs.eyeBlinkLeft || 0) > BLINK_THRESHOLD;
    const rightBlink = (bs.eyeBlinkRight || 0) > BLINK_THRESHOLD;

    if (leftBlink && !this._leftEyeClosed) this._emit('blink', 'left');
    if (rightBlink && !this._rightEyeClosed) this._emit('blink', 'right');
    if (leftBlink && rightBlink && !(this._leftEyeClosed && this._rightEyeClosed)) {
      this._emit('blink', 'both');
    }

    this._leftEyeClosed = leftBlink;
    this._rightEyeClosed = rightBlink;
    this.state.leftEyeClosed = leftBlink;
    this.state.rightEyeClosed = rightBlink;

    // ── Eyes closed duration ──
    const bothClosed = (bs.eyeBlinkLeft || 0) > EYES_CLOSED_THRESHOLD &&
                       (bs.eyeBlinkRight || 0) > EYES_CLOSED_THRESHOLD;
    if (bothClosed) {
      if (!this.state.bothEyesClosed) this._eyesClosedStart = now;
      this.state.bothEyesClosed = true;
      this.state.eyesClosedDuration = (now - this._eyesClosedStart) / 1000;
      if (this.state.eyesClosedDuration > 0.5) {
        this._emit('eyesClosed', this.state.eyesClosedDuration);
      }
    } else {
      if (this.state.bothEyesClosed && this.state.eyesClosedDuration > 0.3) {
        this._emit('eyesOpened', this.state.eyesClosedDuration);
      }
      this.state.bothEyesClosed = false;
      this.state.eyesClosedDuration = 0;
    }

    // ── Smile ──
    const smileL = bs.mouthSmileLeft || 0;
    const smileR = bs.mouthSmileRight || 0;
    const smile = (smileL + smileR) / 2;
    this.state.smileIntensity = smile;
    this.state.smiling = smile > SMILE_THRESHOLD;
    if (this.state.smiling) this._emit('smile', smile);

    // ── Mouth open ──
    const jaw = bs.jawOpen || 0;
    this.state.mouthOpenAmount = jaw;
    this.state.mouthOpen = jaw > MOUTH_OPEN_THRESHOLD;
    if (this.state.mouthOpen) this._emit('mouthOpen', jaw);

    // ── Surprise (brows up + eyes wide) ──
    const browUp = bs.browInnerUp || 0;
    const eyeWideL = bs.eyeWideLeft || 0;
    const eyeWideR = bs.eyeWideRight || 0;
    const surprise = (browUp + (eyeWideL + eyeWideR) / 2) / 2;
    this.state.surpriseIntensity = surprise;
    this.state.surprised = surprise > 0.35;
    if (this.state.surprised) this._emit('surprise', surprise);

    // ── Eyes wide (without brow — more like startled) ──
    const eyeWide = (eyeWideL + eyeWideR) / 2;
    if (eyeWide > EYE_WIDE_THRESHOLD) this._emit('eyesWide', eyeWide);

    // ── Frown (brows down) ──
    const frown = ((bs.browDownLeft || 0) + (bs.browDownRight || 0)) / 2;
    this.state.frownIntensity = frown;
    this.state.frowning = frown > BROW_THRESHOLD;
    if (this.state.frowning) this._emit('frown', frown);

    // ── Kiss / pucker ──
    const pucker = bs.mouthPucker || 0;
    this.state.kissIntensity = pucker;
    this.state.kissing = pucker > PUCKER_THRESHOLD;
    if (this.state.kissing) this._emit('kiss', pucker);

    // ── Cheek puff ──
    const puff = bs.cheekPuff || 0;
    this.state.cheeksPuffed = puff > 0.4;
    if (this.state.cheeksPuffed) this._emit('cheekPuff', puff);

    // ── Tongue out ──
    // No direct blendshape, but jawOpen + mouthFunnel combo approximates it
    const tongueProxy = (bs.jawOpen || 0) * (bs.mouthFunnel || 0);
    if (tongueProxy > 0.15) this._emit('tongueOut', tongueProxy);

    // ── Gaze direction ──
    const lookLeft = ((bs.eyeLookOutLeft || 0) + (bs.eyeLookInRight || 0)) / 2;
    const lookRight = ((bs.eyeLookOutRight || 0) + (bs.eyeLookInLeft || 0)) / 2;
    const lookUp = ((bs.eyeLookUpLeft || 0) + (bs.eyeLookUpRight || 0)) / 2;
    const lookDown = ((bs.eyeLookDownLeft || 0) + (bs.eyeLookDownRight || 0)) / 2;
    this.state.lookDirection.x = lookRight - lookLeft;  // -1 left, +1 right
    this.state.lookDirection.y = lookUp - lookDown;      // -1 down, +1 up

    if (lookLeft > GAZE_THRESHOLD) this._emit('lookLeft', lookLeft);
    if (lookRight > GAZE_THRESHOLD) this._emit('lookRight', lookRight);
    if (lookUp > GAZE_THRESHOLD) this._emit('lookUp', lookUp);
    if (lookDown > GAZE_THRESHOLD) this._emit('lookDown', lookDown);

    // ── Nose sneer (disgust-like) ──
    const sneer = ((bs.noseSneerLeft || 0) + (bs.noseSneerRight || 0)) / 2;
    if (sneer > 0.4) this._emit('sneer', sneer);

    return this.state;
  }

  /** Get raw blendshape value by name */
  getBlendshape(name) {
    return this._blendshapes ? (this._blendshapes[name] || 0) : 0;
  }

  /** Get all raw blendshapes as a map */
  getAllBlendshapes() {
    return this._blendshapes || {};
  }

  /** Get the 478 face landmarks */
  getLandmarks() {
    return this._landmarks;
  }
}
