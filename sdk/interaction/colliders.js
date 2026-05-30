/**
 * hopeOS SDK — Collider Registry
 * Generic collision system supporting sphere and arbitrary mesh colliders.
 * Hands deform around any registered collider. Games register objects here.
 *
 * Game integration:
 *   import { registerSphere, registerMesh, colliders } from './interaction/colliders.js'
 *   const c = registerSphere(position, radius);  // ball-like objects
 *   const c = await registerMesh(threeMesh);      // any shape — BVH built automatically
 *   c.active = false; // toggle off
 *   removeCollider(c); // fully remove
 */
import * as THREE from 'three';

// ── BVH loader (async — mesh colliders work once this resolves) ──
let MeshBVH = null;
export let bvhReady = false;

const bvhPromise = import('https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.8/+esm')
  .then(m => { MeshBVH = m.MeshBVH; bvhReady = true; console.log('[colliders] MeshBVH loaded'); })
  .catch(e => console.warn('[colliders] BVH not available:', e));

export function awaitBVH() { return bvhPromise; }

// ── Collider store ──
export const colliders = [];

export function registerCollider(c) {
  if (!colliders.includes(c)) colliders.push(c);
  return c;
}

export function removeCollider(c) {
  const i = colliders.indexOf(c);
  if (i >= 0) colliders.splice(i, 1);
}

/** Register a sphere collider (fast path — use for balls, round objects) */
export function registerSphere(center, radius, active = true) {
  return registerCollider({
    type: 'sphere',
    center: center || new THREE.Vector3(),
    radius: radius || 0,
    active
  });
}

/** Register a mesh collider with BVH (conforms to actual geometry) */
export function registerMesh(mesh, active = true) {
  if (!MeshBVH || !mesh.geometry) {
    console.warn('[colliders] BVH not ready or no geometry — mesh collider deferred');
    return null;
  }
  mesh.geometry.boundsTree = new MeshBVH(mesh.geometry);
  mesh.geometry.computeBoundingSphere();
  const bs = mesh.geometry.boundingSphere;
  return registerCollider({
    type: 'mesh',
    mesh,
    bvh: mesh.geometry.boundsTree,
    boundCenter: new THREE.Vector3(),
    boundRadius: bs ? bs.radius : 1,
    active,
    _invMat: new THREE.Matrix4()
  });
}

/** Try to build a mesh collider — if BVH not loaded yet, retry after it loads */
export async function registerMeshAsync(mesh, active = true) {
  await bvhPromise;
  return registerMesh(mesh, active);
}

/** Get face normal from geometry at a given face index */
export function getFaceNormal(geo, faceIndex) {
  const idx = geo.index;
  const pos = geo.getAttribute('position');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  if (idx) {
    a.fromBufferAttribute(pos, idx.getX(faceIndex * 3));
    b.fromBufferAttribute(pos, idx.getX(faceIndex * 3 + 1));
    c.fromBufferAttribute(pos, idx.getX(faceIndex * 3 + 2));
  } else {
    a.fromBufferAttribute(pos, faceIndex * 3);
    b.fromBufferAttribute(pos, faceIndex * 3 + 1);
    c.fromBufferAttribute(pos, faceIndex * 3 + 2);
  }
  return b.sub(a).cross(c.sub(a)).normalize();
}

/** Deactivate all colliders at once */
export function deactivateAll() {
  for (const c of colliders) c.active = false;
}
