/**
 * hopeOS SDK — Asset Loader
 * GLTF model loading with auto-centering, scaling, and optional collider setup.
 *
 * Game integration:
 *   import { loadModel } from './assets/loader.js'
 *   const obj = await loadModel('sword.glb', scene, { scale: 0.5, collider: 'mesh' });
 *   obj.group   // THREE.Group
 *   obj.mixer   // AnimationMixer (if animations exist)
 *   obj.collider // collider object (if requested)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { registerSphere, registerMeshAsync } from '../interaction/colliders.js';

const loader = new GLTFLoader();

/**
 * Load a GLTF/GLB model.
 * @param {string} url - path to .glb/.gltf
 * @param {THREE.Scene} targetScene - scene to add the model to
 * @param {Object} opts - options
 * @param {number} opts.scale - target max dimension (auto-scales to fit)
 * @param {string} opts.collider - 'sphere' | 'mesh' | null
 * @param {boolean} opts.visible - initial visibility (default true)
 * @param {boolean} opts.doubleSided - force double-sided materials
 * @returns {Promise<{group, mixer, anims, collider, rawScene, boundingSize}>}
 */
/** Minimal placeholder returned when a GLB is missing — same interface as a real load. */
function makePlaceholder(targetScene, opts) {
  const s = opts.scale || 0.2;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(s * 0.5, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x334455, wireframe: true })
  ));
  group.visible = false;
  if (targetScene) targetScene.add(group);
  return {
    group, mixer: null, anims: {}, collider: null,
    rawScene: group, boundingSize: new THREE.Vector3(s, s, s),
    isPlaceholder: true
  };
}

export function loadModel(url, targetScene, opts = {}) {
  return new Promise((resolve) => {
    loader.load(url, async (gltf) => {
      const group = new THREE.Group();
      const m = gltf.scene;

      // Auto-center and scale
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const targetScale = opts.scale ? opts.scale / maxDim : 1;

      m.position.set(-center.x, -center.y, -center.z);
      group.add(m);
      group.scale.setScalar(targetScale);
      group.visible = opts.visible !== false;

      if (opts.doubleSided !== false) {
        m.traverse(c => {
          if (c.isMesh && c.material) c.material.side = THREE.DoubleSide;
        });
      }

      if (targetScene) targetScene.add(group);

      // Animations
      let mixer = null;
      const anims = {};
      if (gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(m);
        for (const clip of gltf.animations) {
          anims[clip.name] = clip;
        }
      }

      // Collider
      let collider = null;
      if (opts.collider === 'sphere') {
        const radius = maxDim * targetScale / 2;
        collider = registerSphere(new THREE.Vector3(), radius, false);
      } else if (opts.collider === 'mesh') {
        // Find first mesh for BVH
        let targetMesh = null;
        m.traverse(c => { if (c.isMesh && !targetMesh) targetMesh = c; });
        if (targetMesh) {
          collider = await registerMeshAsync(targetMesh, false);
        }
      }

      resolve({
        group, mixer, anims, collider, rawScene: m,
        boundingSize: size.clone().multiplyScalar(targetScale)
      });
    }, null, (err) => {
      console.warn(`[loader] "${url}" not found — placeholder active. Drop the real GLB into assets/ to replace it.`);
      resolve(makePlaceholder(targetScene, opts));
    });
  });
}

/**
 * Split a hand model into left/right halves by X position.
 * Returns geometry data for RiggedHand.init().
 */
export function splitHandModel(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      let sg = null;
      gltf.scene.traverse(c => { if (c.isMesh) sg = c.geometry; });
      if (!sg) { reject(new Error('No mesh found')); return; }

      const box = new THREE.Box3().setFromObject(gltf.scene);
      const ct = box.getCenter(new THREE.Vector3());
      const ap = sg.getAttribute('position').array;
      const an = sg.getAttribute('normal')?.array;
      const au = sg.getAttribute('uv')?.array;
      const ai = sg.index ? Array.from(sg.index.array) : null;
      const vc = sg.getAttribute('position').count;

      // Center positions
      const cp = new Float32Array(ap.length);
      for (let i = 0; i < vc; i++) {
        cp[i * 3] = ap[i * 3] - ct.x;
        cp[i * 3 + 1] = ap[i * 3 + 1] - ct.y;
        cp[i * 3 + 2] = ap[i * 3 + 2] - ct.z;
      }

      // Split by X
      const lv = [], rv = [];
      const lm = new Int32Array(vc).fill(-1), rm = new Int32Array(vc).fill(-1);
      for (let i = 0; i < vc; i++) {
        if (cp[i * 3] < 0) { rm[i] = rv.length; rv.push(i); }
        else { lm[i] = lv.length; lv.push(i); }
      }

      function extract(vl, vm) {
        const n = vl.length;
        const p = new Float32Array(n * 3);
        const nr = an ? new Float32Array(n * 3) : null;
        const uv = au ? new Float32Array(n * 2) : null;
        for (let i = 0; i < n; i++) {
          const o = vl[i];
          p[i * 3] = cp[o * 3]; p[i * 3 + 1] = cp[o * 3 + 1]; p[i * 3 + 2] = cp[o * 3 + 2];
          if (nr) { nr[i * 3] = an[o * 3]; nr[i * 3 + 1] = an[o * 3 + 1]; nr[i * 3 + 2] = an[o * 3 + 2]; }
          if (uv) { uv[i * 2] = au[o * 2]; uv[i * 2 + 1] = au[o * 2 + 1]; }
        }
        let idx = null;
        if (ai) {
          const t = [];
          for (let i = 0; i < ai.length; i += 3) {
            const a = vm[ai[i]], b = vm[ai[i + 1]], c = vm[ai[i + 2]];
            if (a >= 0 && b >= 0 && c >= 0) t.push(a, b, c);
          }
          idx = new Uint32Array(t);
        }
        return { positions: p, normals: nr, uvs: uv, indices: idx };
      }

      resolve({
        right: extract(rv, rm),
        left: extract(lv, lm)
      });
    }, null, reject);
  });
}
