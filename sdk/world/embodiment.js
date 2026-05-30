/**
 * hopeOS SDK — Embodiment Manager
 * ═══════════════════════════════════════════════════════════════
 *
 * Controls HOW the user inhabits the world template. Two modes:
 *
 * ── MODE 1: 'bodyEmbedded' (you SEE yourself in the scene) ──────────
 *   The holo-body skeleton + holo hands are placed into the navigable
 *   3D scene and viewed from a 3rd-person follow camera — "there I am,
 *   standing in the gallery." Optional SAM2 silhouette billboard can
 *   replace the skeleton with the actual segmented body image
 *   (integration hook provided; SAM2 runs as a separate worker).
 *   Tracking + collision + grab all work as in the AR overlay, just
 *   set inside the templated space.
 *
 * ── MODE 2: 'firstPerson' (you ARE the avatar) ─────────────────────
 *   The camera sits at the avatar's eyes. Holo hands float in front,
 *   backs toward camera, extending into the scene — classic VR/FPS.
 *   MediaPipe is selfie-mirrored, so we DOUBLE-mirror: un-flip X and
 *   swap handedness so your real left hand drives the on-screen left
 *   hand in first-person. Hands are predicted holo meshes, never flesh.
 *
 * The holo-hand RENDERING is reused unchanged — we only transform the
 * landmark coordinates we feed into RiggedHand.deform(). That keeps the
 * Fresnel shader, collision-conforming, and grab logic identical.
 */

import * as THREE from 'three';

const EMB_DEFAULTS = {
  // First-person hand placement (camera-local meters)
  fpForward:    -0.42,    // hands sit this far in front of the eyes (−Z = forward)
  fpDown:       -0.18,    // and slightly below eye line
  fpSideSpread:  0.13,    // left/right hand horizontal offset
  fpHandScale:   1.15,    // size multiplier for hands in FP
  invertHandedness: true, // swap L/R for first-person (double-mirror)

  // Body-embedded follow camera
  followDistance: 2.4,
  followHeight:   1.4,
  followYaw:      0,      // look at avatar from behind by default
};

export class EmbodimentManager {
  constructor(opts = {}) {
    this.cfg = { ...EMB_DEFAULTS, ...opts };
    this.mode = opts.mode || 'firstPerson';
    this.samProvider = opts.samProvider || null; // optional SAM2 silhouette source
  }

  setMode(mode) { this.mode = mode; }

  /**
   * Transform raw frame hand landmarks into the placement for the current mode.
   * Returns { handsSceneLandmarks: [r, l], handednessOut, showBody }.
   *
   * @param frame  hopeOS frame { hands, handedness, handCount, sceneLandmarks }
   * @param world  WorldTemplate (for avatar position + look)
   * @param camera the SDK camera (already positioned by world.applyToCamera)
   */
  resolveHands(frame, world, camera) {
    if (this.mode === 'firstPerson') {
      return this._firstPersonHands(frame, camera);
    }
    // bodyEmbedded: hands stay in their natural scene-space placement,
    // body is shown, camera is a 3rd-person follow (handled in updateCamera).
    return {
      handsSceneLandmarks: frame.sceneLandmarks,
      handednessOut: frame.handedness,
      showBody: true,
    };
  }

  /**
   * First-person: re-anchor each hand in front of the camera.
   *
   * Math: take each landmark's offset from the wrist in the mirror scene
   * frame, flip it to face forward, scale it, add a camera-local anchor
   * (forward + down + side), then transform by the camera world matrix.
   */
  _firstPersonHands(frame, camera) {
    const out = [null, null];
    const handednessOut = [];
    const camPos = camera.position;
    const camQuat = camera.quaternion;

    for (let h = 0; h < Math.min(frame.handCount, 2); h++) {
      const sl = frame.sceneLandmarks[h];
      if (!sl) { handednessOut[h] = frame.handedness[h]; continue; }

      // Determine which side this hand sits on (with optional double-mirror swap)
      let side = frame.handedness[h]; // 'Left' | 'Right'
      if (this.cfg.invertHandedness) side = side === 'Left' ? 'Right' : 'Left';
      handednessOut[h] = side;
      const sideSign = side === 'Right' ? 1 : -1;

      // Camera-local anchor for this hand
      const anchor = new THREE.Vector3(
        sideSign * this.cfg.fpSideSpread,
        this.cfg.fpDown,
        this.cfg.fpForward
      );

      // Wrist is the hand origin in the mirror scene frame
      const wrist = sl[0];
      const transformed = new Array(sl.length);
      for (let i = 0; i < sl.length; i++) {
        // Offset of landmark from wrist, scaled
        const off = new THREE.Vector3(
          (sl[i].x - wrist.x) * this.cfg.fpHandScale,
          (sl[i].y - wrist.y) * this.cfg.fpHandScale,
          // Flip Z so fingers extend AWAY from the camera (into the scene)
          -(sl[i].z - wrist.z) * this.cfg.fpHandScale
        );
        // Camera-local position = anchor + offset
        const local = anchor.clone().add(off);
        // To world: rotate by camera orientation, translate to camera position
        local.applyQuaternion(camQuat).add(camPos);
        transformed[i] = local;
      }
      out[h] = transformed;
    }

    return { handsSceneLandmarks: out, handednessOut, showBody: false };
  }

  /**
   * Position the camera for the current mode.
   *   firstPerson  → eyes of the avatar (world.applyToCamera already did this)
   *   bodyEmbedded → 3rd-person follow behind the avatar
   */
  updateCamera(world, camera) {
    if (this.mode === 'firstPerson') {
      world.applyToCamera(camera); // eyes
      return;
    }
    // Body-embedded follow camera
    const avatar = world.getAvatarPosition();
    const yaw = world.yaw + this.cfg.followYaw;
    const back = new THREE.Vector3(
      Math.sin(yaw) * this.cfg.followDistance,
      0,
      Math.cos(yaw) * this.cfg.followDistance
    );
    camera.position.set(
      avatar.x + back.x,
      avatar.y + this.cfg.followHeight,
      avatar.z + back.z
    );
    camera.lookAt(avatar.x, avatar.y + 0.8, avatar.z);
  }

  /**
   * SAM2 silhouette hook. If a samProvider is supplied (a worker that returns
   * a segmented RGBA body mask per frame), this billboards it into the scene
   * at the avatar position for the body-embedded "see yourself" effect.
   * Without a provider, body-embedded mode falls back to the holo skeleton.
   */
  async updateBodySilhouette(world, frame) {
    if (this.mode !== 'bodyEmbedded' || !this.samProvider) return null;
    // samProvider.segment(videoFrame) → { texture, width, height } | null
    return this.samProvider.segment(frame);
  }
}
