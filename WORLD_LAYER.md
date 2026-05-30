# hopeOS L5 — World Layer

The plugin layer that fuses the **spatial template engine** (the one that hosted the
basketball court + art gallery) with the **DEI tracking SDK** (MediaPipe + holo hands +
collision). Drop a GLB at one entry point and it's instantly positioned and playable —
in keyboard *and* spatial (hand) navigation, in two embodiment modes.

```
┌──────────────────────────────────────────────────────────────────┐
│  world.html  — L5 shell: play button, mode switch, instructions   │
├──────────────────────────────────────────────────────────────────┤
│  sdk/world/                                                        │
│   ├── template.js    WorldTemplate  — Rapier physics, GLB host,    │
│   │                  trimesh colliders, shadow auto-fit, the       │
│   │                  kinematic capsule avatar + step()/look()/jump │
│   ├── avatar-nav.js  AvatarNavigator — keyboard OR gesture →       │
│   │                  unified movement intent                       │
│   └── embodiment.js  EmbodimentManager — first-person vs           │
│                      body-embedded; FP hand remapping; SAM2 hook   │
├──────────────────────────────────────────────────────────────────┤
│  sdk/core + sdk/interaction  (existing DEI SDK, unchanged)         │
└──────────────────────────────────────────────────────────────────┘
```

## Dropping in a new scene

In `world.html`, change the one config block:

```js
const WORLD_CONFIG = {
  modelUrl: './worlds/my_scene.glb',   // any GLB
  scale:    10.0,                       // Meshy ~1m models → room size
  offset:   { x: 0, y: 3.3, z: 0 },     // lift so floor sits at Y≈0
  spawn:    { x: 0, y: 1.5, z: 0 },     // avatar start, inside the space
};
```

The template auto-generates trimesh colliders from every mesh (walls/floor become
solid), fits the sun's shadow frustum to the model bounds, and drops the avatar capsule
at `spawn`. Same pipeline as the court/gallery — now one line.

## Embodiment modes

**First-Person POV** (`firstPerson`) — the camera is the avatar's eyes. Holo hands float
in front, backs toward camera, fingers extending into the scene (classic VR/FPS). Because
MediaPipe is selfie-mirrored, FP mode double-mirrors: it un-flips X and swaps handedness
so your real left hand drives the on-screen left hand. Hands are predicted holo meshes —
never flesh. The remap takes each landmark's offset from the wrist, flips Z so fingers
point away from the camera, scales, anchors it in camera-local space
(`forward + down + side`), then transforms by the camera world matrix. The holo-hand
shader, collision-conforming and grab logic are reused unchanged — only the input
coordinates differ.

**See Yourself** (`bodyEmbedded`) — the holo body skeleton + hands are placed in the
navigable scene and viewed from a 3rd-person follow camera: "there I am, in the gallery."
Tracking, collision, and grab work as in the AR overlay, just inside the templated space.
An optional SAM2 silhouette provider (`samProvider.segment(frame) → {texture,…}`) can
billboard the actual segmented body image in place of the skeleton; without it, the
skeleton is the fallback. SAM2 is expected to run in a separate worker (ONNX Runtime Web /
WebGPU) — the hook is in `EmbodimentManager.updateBodySilhouette()`.

## Gesture navigation scheme

One-handed, based on bare-hand VR locomotion research (continuous look + discrete
locomotion gesture, with center deadzones for comfort). The dominant hand is a
pointer-joystick with two channels:

**LOOK** (continuous, always live when a hand is tracked) — hand *position* steers the
camera like a joystick:

| Hand position | Result |
|---|---|
| left third of frame | turn (yaw) left |
| right third | turn right |
| high | look (pitch) up |
| low | look down |
| center (deadzone) | hold still |

**LOCOMOTION** (the hand *shape* sets the walk state):

| Gesture | Action |
|---|---|
| ☝️ Point (index out, others curled) | walk forward in look direction |
| 🖐️ Open palm (all 5 spread) | sprint forward |
| ✊ Fist (all curled) | stop |
| ☝️⬆️ Index jabbed sharply up | jump |
| relaxed / unknown | coast to a stop (damped) |

Separating *where the hand is* (look) from *hand shape* (move) keeps the two channels
from fighting each other. All thresholds live in `NAV_DEFAULTS` in `avatar-nav.js`
(`yawSensitivity`, `deadzoneX`, `jabVelocity`, …) for tuning.

**Keyboard fallback** (`keyboard`) — WASD move, mouse look (pointer-lock on canvas
click), Space jump, Shift sprint. Identical `intent` output, so the world template can't
tell which input drove it.

## Frame flow (per tick, inside the SDK loop)

```
1. nav.update(dt, frame)          → intent {forward,strafe,yawDelta,pitchDelta,jump,sprint}
2. world.step(dt, intent)         → physics, collision, gravity, character controller
3. embody.updateCamera(world,cam) → eyes (FP) or follow (body-embedded)
4. embody.resolveHands(frame,…)   → remapped landmarks → RiggedHand.deform()
5. render
```

Because both keyboard and gesture emit the same `intent` shape, and both embodiment
modes resolve to the same `deform()` call, adding scenes or input methods never touches
the template.

## Files

```
dei-sdk/
├── world.html                    ← L5 shell (play + modes + loop)
├── worlds/
│   └── indoor_gallery.glb        ← drop scenes here
└── sdk/world/
    ├── template.js
    ├── avatar-nav.js
    └── embodiment.js
```
