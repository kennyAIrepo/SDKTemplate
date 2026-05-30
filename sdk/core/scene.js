/**
 * hopeOS SDK — Scene Module
 * Three.js scene, camera, renderer, coordinate mapping.
 * 
 * Game integration: import { scene, camera, mp2s } from './core/scene.js'
 * Everything in the SDK renders into this scene. Games add their own objects here too.
 */
import * as THREE from 'three';

// ── Config (camera geometry determines coordinate mapping) ──
export const CAM_FOV = 50;
export const CAM_Z = 2.0;

// ── Scene graph ──
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(CAM_FOV, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0, CAM_Z);

// ── Renderer (created lazily when init is called) ──
export let renderer = null;

// ── Screen-space mapping (normalized MediaPipe coords → Three.js world) ──
export let sW = 1, sH = 1;

export function updateScreenMapping() {
  const aspect = innerWidth / innerHeight;
  const halfH = Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2)) * CAM_Z;
  sW = halfH * aspect * 2;
  sH = halfH * 2;
}

/** Convert normalized MediaPipe landmark {x,y,z} to Three.js Vector3 in scene space */
export function mp2s(lm) {
  return new THREE.Vector3(
    (lm.x - 0.5) * sW,
    -(lm.y - 0.5) * sH,
    -(lm.z || 0) * sH * 1.2
  );
}

// ── Lighting (default setup, games can modify) ──
function setupLights() {
  scene.add(new THREE.AmbientLight(0x506070, 1.0));
  const key = new THREE.DirectionalLight(0xfff8f0, 2.5);
  key.position.set(2, 3, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x5577aa, 0.8);
  fill.position.set(-2, 1, 3);
  scene.add(fill);
}

/** Initialize renderer on a canvas element. Call once. */
export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0, 0);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.6;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  setupLights();
  updateScreenMapping();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    updateScreenMapping();
  });

  return { scene, camera, renderer };
}

/** Render one frame */
export function render() {
  if (renderer) renderer.render(scene, camera);
}
