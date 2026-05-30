/**
 * hopeOS SDK — Entry Point
 * Wires all modules together. Exposes window.hopeOS as the public API.
 *
 * Usage:
 *   import { HopeOS } from './sdk/hopeos.js';
 *   const hope = await HopeOS.init({
 *     canvas: document.getElementById('c'),
 *     bgVideo: document.getElementById('bgVid'),
 *     detectionVideo: document.getElementById('vid')
 *   });
 *
 *   // Access hands
 *   hope.hands.right  // RiggedHand instance
 *   hope.hands.left   // RiggedHand instance
 *
 *   // Gesture events
 *   hope.gestures.on('punch', (side, velocity) => { ... });
 *   hope.gestures.on('swipeLeft', (side, speed) => { ... });
 *
 *   // Spawn objects (auto-collider, auto-centering)
 *   const sword = await hope.loadModel('sword.glb', { collider: 'mesh', scale: 0.4 });
 *
 *   // Voice commands
 *   hope.voice.register('attack', /\b(attack|strike)\b/, () => { ... });
 *
 *   // Game loop
 *   hope.onFrame((dt, frame) => {
 *     // frame.hands, frame.handedness, frame.pose
 *     // your game logic here
 *   });
 *   hope.start();
 */

import * as THREE from 'three';
import { initScene, scene, camera, renderer, render, mp2s, updateScreenMapping } from './core/scene.js';
import { initCamera, initTracking } from './core/tracking.js';
import { RiggedHand, REST_R42, REST_L42 } from './core/hands.js';
import { BodyTracker, BODY_SEGS } from './core/body.js';
import { PhysicsWorld } from './core/physics.js';
import { colliders, registerSphere, registerMesh, registerMeshAsync, deactivateAll, awaitBVH } from './interaction/colliders.js';
import { GestureDetector } from './interaction/gestures.js';
import { BodyGestureDetector } from './interaction/body-gestures.js';
import { FaceExpressionDetector } from './interaction/face.js';
import { FireEffect } from './interaction/effects.js';
import { VoiceCommander } from './interaction/voice.js';
import { loadModel, splitHandModel } from './assets/loader.js';
import { isPinch, pinchPoint, palmCenter, handQuaternion, GrabState } from './interaction/grab.js';

// Resolves to sdk/assets/ using this module's own URL — works regardless of
// where the game's HTML is served from.
const SDK_ASSETS = new URL('./assets/', import.meta.url).href;

export class HopeOS {
  constructor() {
    this.scene = scene;
    this.camera = camera;
    this.renderer = null;
    this.clock = new THREE.Clock();

    // Core systems
    this.tracker = null;
    this.body = null;
    this.physics = null;
    this.gestures = new GestureDetector();          // hand gestures
    this.bodyGestures = new BodyGestureDetector();   // body pose gestures
    this.face = new FaceExpressionDetector();         // face expressions
    this.fire = null;
    this.voice = null;

    // Hands
    this.hands = { right: null, left: null };
    this._rightHand = null;
    this._leftHand = null;

    // Frame state (updated each frame, readable by game)
    this.frame = {
      hands: null, handedness: [], handCount: 0,
      pose: null, poseWorld: null,
      face: null,  // { landmarks, blendshapes }
      sceneLandmarks: [null, null], // scene-space hand landmarks
      bodyPoints: null,
      dt: 0, elapsed: 0
    };

    // Game callbacks
    this._frameCallbacks = [];
    this._running = false;
  }

  /**
   * Initialize the full hopeOS stack.
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas - Three.js render target
   * @param {HTMLVideoElement} opts.bgVideo - background video (camera feed display)
   * @param {HTMLVideoElement} opts.detectionVideo - detection video (lower-res for MediaPipe)
   * @param {string} opts.handModelUrl - URL to holo hand GLB model
   * @param {string} opts.apiKey - OpenAI API key for voice commands (optional)
   */
  static async init(opts = {}) {
    const hope = new HopeOS();

    // Scene
    initScene(opts.canvas);
    hope.renderer = renderer;

    // Camera + tracking
    if (opts.bgVideo && opts.detectionVideo) {
      await initCamera(opts.bgVideo, opts.detectionVideo);
      hope.tracker = await initTracking(opts.detectionVideo, {
        numHands: opts.numHands || 2
      });
    }

    // Body tracker
    hope.body = new BodyTracker(scene);

    // Physics
    hope.physics = await PhysicsWorld.create();
    hope.physics.initBodyCapsules(BODY_SEGS);

    // Hands — defaults to the SDK's bundled model; games can override via opts.handModelUrl
    const handUrl = opts.handModelUrl || SDK_ASSETS + 'holo_hands_model.glb';
    try {
      const handData = await splitHandModel(handUrl);
      hope._rightHand = new RiggedHand(REST_R42, scene);
      hope._leftHand = new RiggedHand(REST_L42, scene);
      hope._rightHand.init(handData.right.positions, handData.right.normals, handData.right.uvs, handData.right.indices);
      hope._leftHand.init(handData.left.positions, handData.left.normals, handData.left.uvs, handData.left.indices);
      hope.hands.right = hope._rightHand;
      hope.hands.left = hope._leftHand;
    } catch (e) {
      console.warn('[hopeOS] Hand model not loaded — tracking works, no hand mesh:', e.message);
    }

    // Fire effect
    hope.fire = new FireEffect(scene);

    // Voice (optional)
    if (opts.apiKey) {
      hope.voice = new VoiceCommander(opts.apiKey, {
        model: opts.whisperModel || 'gpt-4o-transcribe'
      });
    }

    // Wait for BVH to be ready
    await awaitBVH();

    // Expose globally for debugging and interop
    window.hopeOS = hope;
    console.log('[hopeOS] SDK initialized');

    return hope;
  }

  // ── Public API: Model loading ──

  async loadModel(url, opts = {}) {
    return loadModel(url, scene, opts);
  }

  // ── Public API: Frame callbacks ──

  /** Register a callback that runs every frame: fn(dt, frame) */
  onFrame(fn) {
    this._frameCallbacks.push(fn);
    return this;
  }

  /** Start the render loop */
  start() {
    this._running = true;
    this._loop();
  }

  stop() { this._running = false; }

  // ── Public API: Utilities (re-exported for game convenience) ──

  get mp2s() { return mp2s; }
  get colliders() { return colliders; }
  get THREE() { return THREE; }

  registerSphere(center, radius) { return registerSphere(center, radius); }
  registerMesh(mesh) { return registerMesh(mesh); }
  async registerMeshAsync(mesh) { return registerMeshAsync(mesh); }
  deactivateAllColliders() { deactivateAll(); }

  // Grab utilities
  isPinch(lm) { return isPinch(lm); }
  pinchPoint(sl) { return pinchPoint(sl); }
  palmCenter(sl) { return palmCenter(sl); }
  handQuaternion(sl) { return handQuaternion(sl); }
  createGrabState() { return new GrabState(); }

  // ── Internal: main loop ──

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(() => this._loop());

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    // Update hand shader time
    if (this._rightHand) this._rightHand.uniforms.uTime.value = elapsed;
    if (this._leftHand) this._leftHand.uniforms.uTime.value = elapsed;

    // ── Detection ──
    let trackFrame = { hands: null, handedness: [], handCount: 0, pose: null, poseWorld: null };
    if (this.tracker) {
      trackFrame = this.tracker.detect();
    }

    // ── Body ──
    let bodyPoints = null;
    if (trackFrame.pose || this.frame.pose) {
      // Use latest pose (pose runs every 4 frames, persist last)
      const pose = trackFrame.pose || this.frame.pose;
      bodyPoints = this.body.update(pose);
      this.physics.setFloorY(this.body.floorY);
      this.physics.updateBodyCapsules(BODY_SEGS, bodyPoints);
    }

    // ── Convert hand landmarks to scene space ──
    const sls = [null, null];
    if (trackFrame.hands) {
      for (let h = 0; h < Math.min(trackFrame.handCount, 2); h++) {
        if (trackFrame.hands[h]) {
          sls[h] = trackFrame.hands[h].map(mp2s);
        }
      }
    }

    // ── Gestures (hand) ──
    this.gestures.update(trackFrame.hands, trackFrame.handedness, trackFrame.pose || this.frame.pose);

    // ── Body gestures (pose-based: jump, squat, lean, turn, kick...) ──
    const poseForGestures = trackFrame.pose || this.frame.pose;
    if (poseForGestures) {
      this.bodyGestures.update(poseForGestures);
    }

    // ── Face expressions (blink, smile, surprise, eyes closed...) ──
    if (trackFrame.face) {
      this.face.update(trackFrame.face);
    }

    // ── Update frame state ──
    this.frame.hands = trackFrame.hands;
    this.frame.handedness = trackFrame.handedness;
    this.frame.handCount = trackFrame.handCount;
    if (trackFrame.pose) this.frame.pose = trackFrame.pose;
    if (trackFrame.poseWorld) this.frame.poseWorld = trackFrame.poseWorld;
    if (trackFrame.face) this.frame.face = trackFrame.face;
    this.frame.sceneLandmarks = sls;
    this.frame.bodyPoints = bodyPoints;
    this.frame.dt = dt;
    this.frame.elapsed = elapsed;

    // ── Physics FIRST (so positions are current for game callbacks) ──
    this.physics.step(dt);

    // ── Game callbacks (update ball/object positions + colliders) ──
    for (const fn of this._frameCallbacks) fn(dt, this.frame);

    // ── Hand deformation AFTER game callbacks ──
    // (collider positions are now current — hands conform correctly)
    // Skipped when a world/embodiment layer controls hands externally.
    if (!this.externalHandControl) {
      let rOK = false, lOK = false;
      for (let h = 0; h < Math.min(trackFrame.handCount, 2); h++) {
        if (!sls[h]) continue;
        const isR = trackFrame.handedness[h] === 'Right';
        if (isR && !rOK && this._rightHand) { this._rightHand.deform(sls[h]); rOK = true; }
        else if (!isR && !lOK && this._leftHand) { this._leftHand.deform(sls[h]); lOK = true; }
      }
      if (!rOK && this._rightHand) this._rightHand.grp.visible = false;
      if (!lOK && this._leftHand) this._leftHand.grp.visible = false;
    }

    // ── Render ──
    render();
  }
}

// Re-export modules for direct access
export { RiggedHand, REST_R42, REST_L42 } from './core/hands.js';
export { BodyTracker, BODY_SEGS } from './core/body.js';
export { PhysicsWorld } from './core/physics.js';
export { GestureDetector } from './interaction/gestures.js';
export { BodyGestureDetector, POSE_LANDMARKS, jointAngle } from './interaction/body-gestures.js';
export { FaceExpressionDetector } from './interaction/face.js';
export { FireEffect } from './interaction/effects.js';
export { VoiceCommander } from './interaction/voice.js';
export { GrabState, isPinch, pinchPoint, palmCenter, handQuaternion } from './interaction/grab.js';
export { colliders, registerSphere, registerMesh, registerMeshAsync } from './interaction/colliders.js';
export { loadModel, splitHandModel } from './assets/loader.js';
export { scene, camera, mp2s } from './core/scene.js';
