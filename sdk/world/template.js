/**
 * hopeOS SDK — World Template (L5 Plugin Layer)
 * ═══════════════════════════════════════════════════════════════
 *
 * The drop-in spatial scene engine. Give it a GLB URL and it:
 *   - loads & auto-centers the scene
 *   - generates Rapier trimesh colliders from every mesh (walls/floor)
 *   - auto-fits the sun's shadow camera to the model bounds
 *   - creates a kinematic capsule character controller (the avatar)
 *   - exposes move()/look()/jump() so any navigator (keyboard OR gesture)
 *     can drive the avatar identically
 *
 * This is the SAME engine that hosted the basketball court and art gallery,
 * refactored into an SDK module so the next scene is literally one line:
 *
 *   const world = await WorldTemplate.create({
 *     scene, renderer,
 *     modelUrl: './worlds/my_scene.glb',
 *     scale: 10, spawn: { x: 0, y: 1.5, z: 0 }
 *   });
 *
 * Coordinate system: right-hand Y-up (matches Three.js + Unity).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';

const DEFAULTS = {
  gravity:        { x: 0, y: -9.81, z: 0 },
  capsuleRadius:  0.3,
  capsuleHalfH:   0.55,
  eyeHeight:      1.6,
  moveSpeed:      3.2,
  sprintSpeed:    6.0,
  jumpSpeed:      5.0,
  spawn:          { x: 0, y: 1.5, z: 0 },
  scale:          1.0,
  offset:         { x: 0, y: 0, z: 0 },
  shadowMapSize:  2048,
  groundDamping:  10.0,
  airDamping:     2.0,
};

export class WorldTemplate {
  constructor() {
    this.scene = null;
    this.renderer = null;
    this.world = null;            // Rapier world
    this.charController = null;
    this.playerBody = null;
    this.playerCollider = null;
    this.model = null;
    this.sun = null;
    this.cfg = { ...DEFAULTS };

    // Avatar kinematic state (driven by navigator)
    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.bounds = new THREE.Box3();
  }

  static async create(opts = {}) {
    const w = new WorldTemplate();
    w.scene = opts.scene;
    w.renderer = opts.renderer;
    w.cfg = { ...DEFAULTS, ...opts };

    // Init Rapier
    await RAPIER.init();
    w.world = new RAPIER.World(w.cfg.gravity);

    // Renderer shadow setup
    if (w.renderer) {
      w.renderer.shadowMap.enabled = true;
      w.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    w._setupLights();

    // Invisible floor fallback (in case the GLB has no floor mesh)
    w._createStaticBox({ x: 0, y: -0.05, z: 0 }, { x: 50, y: 0.05, z: 50 });

    // Load the scene model
    if (w.cfg.modelUrl) await w._loadModel(w.cfg.modelUrl);

    // Build the avatar
    w._setupCharacter();

    return w;
  }

  // ── Lighting + shadows ──
  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x99aacc, 0x445533, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e6, 1.6);
    sun.position.set(20, 35, 15);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.cfg.shadowMapSize, this.cfg.shadowMapSize);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  _fitShadowToBounds(box) {
    const sun = this.sun;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const half = maxDim * 0.65;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = maxDim * 3;
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
  }

  // ── Model loading + collider extraction ──
  async _loadModel(url) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);

    return new Promise((resolve) => {
      loader.load(url, (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(this.cfg.scale);
        model.position.set(this.cfg.offset.x, this.cfg.offset.y, this.cfg.offset.z);
        model.traverse((c) => {
          if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
            if (c.material) c.material.side = THREE.FrontSide;
          }
        });
        this.scene.add(model);
        this.model = model;

        this._extractColliders(model);
        this.bounds.setFromObject(model);
        this._fitShadowToBounds(this.bounds);

        console.log('[world] scene loaded, bounds:', this.bounds.min.toArray().map(n => n.toFixed(1)), '→', this.bounds.max.toArray().map(n => n.toFixed(1)));
        resolve();
      }, undefined, (err) => {
        console.warn('[world] model load failed, using empty floor:', err);
        resolve();
      });
    });
  }

  /** Generate static Rapier trimesh colliders from every mesh (Unity MeshCollider equivalent) */
  _extractColliders(model) {
    let count = 0;
    model.traverse((c) => {
      if (!c.isMesh || !c.geometry) return;
      const geo = c.geometry.clone();
      c.updateWorldMatrix(true, false);
      geo.applyMatrix4(c.matrixWorld);
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const verts = new Float32Array(pos.array);
      let idx;
      if (geo.index) idx = new Uint32Array(geo.index.array);
      else { idx = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) idx[i] = i; }
      if (verts.length < 9 || idx.length < 3) return;
      try {
        const cd = RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.8);
        this.world.createCollider(cd);
        count++;
      } catch (e) { /* skip degenerate */ }
    });
    console.log('[world] generated', count, 'trimesh colliders');
  }

  _createStaticBox(pos, half) {
    const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
    const body = this.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.8);
    this.world.createCollider(cd, body);
    return body;
  }

  // ── Character controller (the avatar capsule) ──
  _setupCharacter() {
    const { spawn, capsuleHalfH, capsuleRadius } = this.cfg;
    const bd = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z);
    this.playerBody = this.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.capsule(capsuleHalfH, capsuleRadius).setFriction(0);
    this.playerCollider = this.world.createCollider(cd, this.playerBody);

    this.charController = this.world.createCharacterController(0.01);
    this.charController.setSlideEnabled(true);
    this.charController.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.charController.setMinSlopeSlideAngle(30 * Math.PI / 180);
    this.charController.enableAutostep(0.35, 0.2, true);
    this.charController.enableSnapToGround(0.3);
    this.charController.setApplyImpulsesToDynamicBodies(true);
  }

  // ── PUBLIC NAVIGATION API (driven by keyboard OR gesture navigator) ──

  /**
   * Drive the avatar one physics tick.
   * @param {Object} intent - { forward, strafe, yawDelta, pitchDelta, jump, sprint }
   *   forward/strafe: -1..1 movement axes
   *   yawDelta/pitchDelta: radians to add to look this frame
   *   jump: boolean (one-shot)
   *   sprint: boolean
   */
  step(dt, intent = {}) {
    // ── Apply look ──
    this.yaw += intent.yawDelta || 0;
    this.pitch += intent.pitchDelta || 0;
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));

    // ── Movement direction in world space (relative to yaw) ──
    const forwardVec = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    forwardVec.y = 0; forwardVec.normalize();
    const rightVec = new THREE.Vector3().crossVectors(forwardVec, new THREE.Vector3(0, 1, 0)).normalize();

    const speed = intent.sprint ? this.cfg.sprintSpeed : this.cfg.moveSpeed;
    const wish = new THREE.Vector3();
    wish.addScaledVector(forwardVec, (intent.forward || 0));
    wish.addScaledVector(rightVec, (intent.strafe || 0));
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    // Horizontal velocity with damping
    const damp = this.grounded ? this.cfg.groundDamping : this.cfg.airDamping;
    this.velocity.x += (wish.x - this.velocity.x) * Math.min(1, damp * dt);
    this.velocity.z += (wish.z - this.velocity.z) * Math.min(1, damp * dt);

    // Gravity
    this.velocity.y += this.cfg.gravity.y * dt;

    // Jump
    if (intent.jump && this.grounded) {
      this.velocity.y = this.cfg.jumpSpeed;
      this.grounded = false;
    }

    // Character controller resolves collisions
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.charController.computeColliderMovement(this.playerCollider, desired);
    const corrected = this.charController.computedMovement();
    this.grounded = this.charController.computedGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    const p = this.playerBody.translation();
    this.playerBody.setNextKinematicTranslation({
      x: p.x + corrected.x, y: p.y + corrected.y, z: p.z + corrected.z
    });

    this.world.step();
  }

  /** Get the avatar eye transform — apply to the SDK camera */
  applyToCamera(camera) {
    const p = this.playerBody.translation();
    camera.position.set(p.x, p.y + this.cfg.eyeHeight, p.z);
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  getAvatarPosition() {
    const p = this.playerBody.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  /** Forward direction the avatar is facing (for placing held objects, raycasts) */
  getForward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    );
  }
}
