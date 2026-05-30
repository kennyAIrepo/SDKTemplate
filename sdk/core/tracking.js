/**
 * hopeOS SDK — Tracking Module
 * Camera access + MediaPipe hand/pose landmark detection.
 * Returns raw normalized landmark data — no Three.js dependency.
 *
 * Game integration:
 *   const tracker = await initTracking(videoEl, { numHands: 2 });
 *   const frame = tracker.detect();  // { hands, handedness, pose }
 */

const NOISE = 0.003;
const stH = [null, null];

function stabilize(raw, idx) {
  if (!stH[idx]) { stH[idx] = raw.map(p => ({ x: p.x, y: p.y, z: p.z })); return stH[idx]; }
  for (let j = 0; j < raw.length; j++) {
    if (Math.hypot(raw[j].x - stH[idx][j].x, raw[j].y - stH[idx][j].y) > NOISE) {
      stH[idx][j] = { x: raw[j].x, y: raw[j].y, z: raw[j].z };
    }
  }
  return stH[idx];
}

export async function initTracking(videoEl, opts = {}) {
  const V = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm');
  const fs = await V.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
  );

  const handLandmarker = await V.HandLandmarker.createFromOptions(fs, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numHands: opts.numHands || 2,
    minHandDetectionConfidence: opts.handConfidence || 0.5,
    minTrackingConfidence: opts.trackingConfidence || 0.5
  });

  const poseLandmarker = await V.PoseLandmarker.createFromOptions(fs, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  // Face Landmarker (optional — 478 landmarks + 52 blendshapes)
  let faceLandmarker = null;
  if (opts.enableFace !== false) {
    try {
      faceLandmarker = await V.FaceLandmarker.createFromOptions(fs, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false
      });
      console.log('[tracking] FaceLandmarker loaded (478 pts + 52 blendshapes)');
    } catch (e) {
      console.warn('[tracking] FaceLandmarker not available:', e);
    }
  }

  let lastDetectTime = -1;
  let frameCount = 0;

  /** Detect hands + pose + face from current video frame. Call once per rAF. */
  function detect() {
    const result = { hands: null, handedness: [], handCount: 0, pose: null, poseWorld: null, face: null };
    if (videoEl.readyState < 2) return result;

    const now = performance.now();
    if (now === lastDetectTime) return result;
    lastDetectTime = now;
    frameCount++;

    // Hands (every frame)
    const hr = handLandmarker.detectForVideo(videoEl, now);
    if (hr.landmarks && hr.landmarks.length) {
      result.handCount = hr.landmarks.length;
      result.hands = [];
      result.handedness = [];
      for (let h = 0; h < result.handCount; h++) {
        // Mirror X for selfie camera
        const mirrored = hr.landmarks[h].map(p => ({ x: 1 - p.x, y: p.y, z: p.z }));
        result.hands.push(stabilize(mirrored, h));
        // MediaPipe labels are mirrored for selfie — flip
        const label = hr.handednesses?.[h]?.[0]?.categoryName === 'Left' ? 'Right' : 'Left';
        result.handedness.push(label);
      }
    }

    // Pose (every 4th frame for performance)
    if (frameCount % 4 === 0) {
      const pr = poseLandmarker.detectForVideo(videoEl, now);
      if (pr.landmarks && pr.landmarks.length > 0) {
        result.pose = pr.landmarks[0].map(p => ({ x: 1 - p.x, y: p.y, z: p.z || 0 }));
      }
      if (pr.worldLandmarks && pr.worldLandmarks.length > 0) {
        result.poseWorld = pr.worldLandmarks[0];
      }
    }

    // Face (every 3rd frame — 478 landmarks + 52 blendshapes)
    if (faceLandmarker && frameCount % 3 === 0) {
      const fr = faceLandmarker.detectForVideo(videoEl, now);
      if (fr.faceLandmarks && fr.faceLandmarks.length > 0) {
        result.face = {
          landmarks: fr.faceLandmarks[0],
          blendshapes: fr.faceBlendshapes?.[0] || null
        };
      }
    }

    return result;
  }

  return { detect, handLandmarker, poseLandmarker, faceLandmarker };
}

/** Start camera and attach to video elements */
export async function initCamera(bgVideoEl, detectionVideoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
  });
  bgVideoEl.srcObject = stream.clone();
  bgVideoEl.play();

  // Separate lower-res stream for detection
  const detStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
  });
  detectionVideoEl.srcObject = detStream;
  await detectionVideoEl.play();
}
