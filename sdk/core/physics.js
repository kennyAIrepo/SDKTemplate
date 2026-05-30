/**
 * hopeOS SDK — Physics Module
 * Cannon-es physics world with auto-floor and body collision capsules.
 *
 * Game integration:
 *   import { PhysicsWorld } from './core/physics.js'
 *   const phys = await PhysicsWorld.create();
 *   const body = phys.addSphere(0.6, position, radius);
 *   phys.step(dt);
 */

export class PhysicsWorld {
  constructor() {
    this.CANNON = null;
    this.world = null;
    this.floorBody = null;
    this.bodyBodies = [];
    this.ready = false;
  }

  static async create(gravity = -6.0) {
    const pw = new PhysicsWorld();
    try {
      pw.CANNON = await import('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm');
      pw.world = new pw.CANNON.World({ gravity: new pw.CANNON.Vec3(0, gravity, 0) });
      pw.world.broadphase = new pw.CANNON.NaiveBroadphase();

      // Floor
      const floorMat = new pw.CANNON.Material('floor');
      pw.floorBody = new pw.CANNON.Body({ mass: 0, material: floorMat, shape: new pw.CANNON.Plane() });
      pw.floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      pw.floorBody.position.set(0, -0.8, 0);
      pw.world.addBody(pw.floorBody);

      // Reusable materials
      pw._floorMat = floorMat;
      pw._ballMat = new pw.CANNON.Material('ball');
      pw._bodyMat = new pw.CANNON.Material('body');
      pw.world.addContactMaterial(new pw.CANNON.ContactMaterial(floorMat, pw._ballMat, { restitution: 0.75, friction: 0.4 }));
      pw.world.addContactMaterial(new pw.CANNON.ContactMaterial(pw._bodyMat, pw._ballMat, { restitution: 0.5, friction: 0.3 }));

      pw.ready = true;
      console.log('[physics] Ready');
    } catch (e) {
      console.error('[physics] Init failed:', e);
    }
    return pw;
  }

  /** Update floor Y from body tracker */
  setFloorY(y) {
    if (this.floorBody) this.floorBody.position.y = y;
  }

  /** Create body collision capsules from body segment definitions */
  initBodyCapsules(segments) {
    for (const seg of segments) {
      const b = new this.CANNON.Body({
        mass: 0, type: this.CANNON.Body.KINEMATIC, material: this._bodyMat
      });
      b.addShape(new this.CANNON.Sphere(seg[3]));
      this.world.addBody(b);
      this.bodyBodies.push(b);
    }
  }

  /** Update body capsule positions from tracked body points */
  updateBodyCapsules(segments, bodyPoints) {
    if (!bodyPoints) return;
    for (let i = 0; i < segments.length && i < this.bodyBodies.length; i++) {
      const [a, b] = segments[i];
      if (!bodyPoints[a] || !bodyPoints[b]) continue;
      const mid = bodyPoints[a].clone().add(bodyPoints[b]).multiplyScalar(0.5);
      this.bodyBodies[i].position.set(mid.x, mid.y, mid.z);
    }
  }

  /** Add a sphere physics body (for throwable objects) */
  addSphere(mass, position, radius) {
    const body = new this.CANNON.Body({
      mass, shape: new this.CANNON.Sphere(radius), material: this._ballMat
    });
    body.position.set(position.x, position.y, position.z);
    this.world.addBody(body);
    return body;
  }

  /** Step physics simulation */
  step(dt) {
    if (this.ready && this.world) this.world.step(1 / 60, dt, 3);
  }
}
