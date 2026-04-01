'use strict';

/* ================================================================
   EMOTION CANVAS — script.js
   Hand-tracking version using MediaPipe Hands
   Two-canvas system:
     #bg-canvas    → animated wavy gradient background
     #trail-canvas → persistent emotion glow trail
   Hand gestures → emotion colors:
     Open hand  = Happy (yellow)
     Fist       = Angry (red)
     Peace sign = Surprised (green)
     Thumbs up  = Happy (yellow)
     One finger = Sad (blue)
     T-shape    = Undo last stroke (hold 1.5s)
     O-shape    = Erase all (hold 2.5s)
     No hand    = no trail
================================================================ */

// ─── Configuration ────────────────────────────────────────────
const SAMPLE_MS      = 16;    // ms between trail captures
const LERP_SPEED     = 0.18;  // hand position smoothing (0–1)
const ERASE_HOLD_MS  = 2500;  // hold O-shape this long to erase
const UNDO_HOLD_MS   = 1500;  // hold T-shape this long to undo
const SNAP_HOLD_MS   = 2000;  // hold dual-L this long to screenshot
const ERASE_RADIUS   = 50;    // radius of the erase progress circle
const PENCIL_WIDTH   = 8;     // trail line thickness

// ─── Emotion → Color Map ──────────────────────────────────────
const EMOTIONS = {
  happy:     { hex:'#FFDC00', name:'Happy'     },
  sad:       { hex:'#3C64FF', name:'Sad'       },
  angry:     { hex:'#FF1E1E', name:'Angry'     },
  surprised: { hex:'#1ED250', name:'Surprised' },
  neutral:   { hex:'#C8C8DC', name:'Neutral'   },
};

// ─── Animated Background Blobs (purple / blue / pink / cyan) ──
const BG_BLOBS = [
  { hue:270, ox:0.35, oy:0.30, r:0.50, sx:0.00020, sy:0.00016, ax:0.08, ay:0.07, hueSpeed:0.025 },
  { hue:190, ox:0.22, oy:0.38, r:0.44, sx:0.00025, sy:0.00020, ax:0.07, ay:0.09, hueSpeed:0.032 },
  { hue:320, ox:0.50, oy:0.50, r:0.48, sx:0.00018, sy:0.00022, ax:0.06, ay:0.08, hueSpeed:0.028 },
  { hue:240, ox:0.75, oy:0.25, r:0.42, sx:0.00022, sy:0.00018, ax:0.09, ay:0.06, hueSpeed:0.035 },
  { hue:280, ox:0.80, oy:0.55, r:0.38, sx:0.00015, sy:0.00025, ax:0.07, ay:0.08, hueSpeed:0.030 },
  { hue:210, ox:0.60, oy:0.75, r:0.35, sx:0.00028, sy:0.00015, ax:0.06, ay:0.07, hueSpeed:0.038 },
];

// ─── Runtime State ────────────────────────────────────────────
let bgCanvas, bgCtx, trailCanvas, trailCtx, eraseCanvas, eraseCtx, video;
let previewCanvas, previewCtx;
const PREVIEW_W = 160, PREVIEW_H = 120;
let trail        = [];
let curPos       = null;
let curEmotion   = null;
let detecting    = false;
let lastSample   = 0;
let instrGone    = false;
let W = 0, H = 0;
let smoothX = 0, smoothY = 0;
let eraseStart = 0;         // timestamp when O-shape began
let isOShape   = false;     // currently forming O?
let undoStart  = 0;         // timestamp when T-shape began
let isTShape   = false;     // currently forming T?
let undoHistory = [];        // canvas ImageData snapshots for undo
let wasDrawing  = false;     // was user drawing in previous frame?
let poofPlayed  = false;     // has poof SFX been triggered this gesture?
const POOF_EARLY_MS = 500;   // play poof this many ms before action completes
let snapStart   = 0;         // timestamp when dual-L screenshot gesture began
let isSnapGesture = false;   // currently forming dual-L?
let snapCenter  = null;      // center point between the two hands
let faceEmotion = 'neutral';
let faceBox     = null;
let handOverFace = false;   // is the hand covering the face?
let audioCtx    = null;     // Web Audio context (needs user gesture to resume)
let _audioPlaying = false;  // has music been successfully started?

// Try to start music + resume AudioContext (safe to call repeatedly)
function tryPlayMusic() {
  if (_audioPlaying) return;
  initAudioAmplification();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (bgMusic) {
    bgMusic.volume = 0.35;
    bgMusic.play().then(() => { _audioPlaying = true; }).catch(() => {});
  }
}

// Amplify SFX beyond 1.0 using Web Audio API
// Deferred — safe to call before DOM elements exist (will just no-op)
function initAudioAmplification() {
  if (audioCtx) return; // already initialised
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (eraseSfx) {
      const eraseSource = audioCtx.createMediaElementSource(eraseSfx);
      const eraseGain   = audioCtx.createGain();
      eraseGain.gain.value = 3.0;
      eraseSource.connect(eraseGain);
      eraseGain.connect(audioCtx.destination);
    }
    if (poofSfx) {
      const poofSource = audioCtx.createMediaElementSource(poofSfx);
      const poofGain   = audioCtx.createGain();
      poofGain.gain.value = 3.0;
      poofSource.connect(poofGain);
      poofGain.connect(audioCtx.destination);
    }
    if (undoSfx) {
      const undoSource = audioCtx.createMediaElementSource(undoSfx);
      const undoGain   = audioCtx.createGain();
      undoGain.gain.value = 3.0;
      undoSource.connect(undoGain);
      undoGain.connect(audioCtx.destination);
    }
    if (bgMusic) {
      const musicSource = audioCtx.createMediaElementSource(bgMusic);
      const musicGain   = audioCtx.createGain();
      musicGain.gain.value = 1.0;
      musicSource.connect(musicGain);
      musicGain.connect(audioCtx.destination);
    }
  } catch (e) { console.warn('Web Audio init failed:', e); }
}

// ─── Face Detection Config ────────────────────────────────────
const FACE_DETECT_MS  = 120;
const FACE_MODEL_URL  = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';

// ─── DOM refs ─────────────────────────────────────────────────
let loadingBar, loadingStatus, statusOverlay, errorMsg;
let emotionDot, emotionName, instrEl, faceRing, handWarning, bgMusic, eraseSfx, undoSfx, poofSfx;

// ─── Boot ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  bgCanvas    = document.getElementById('bg-canvas');
  trailCanvas = document.getElementById('trail-canvas');
  eraseCanvas = document.getElementById('erase-canvas');
  previewCanvas = document.getElementById('hand-preview');
  bgCtx       = bgCanvas.getContext('2d');
  trailCtx    = trailCanvas.getContext('2d');
  eraseCtx    = eraseCanvas.getContext('2d');
  previewCtx  = previewCanvas.getContext('2d');
  previewCanvas.width  = PREVIEW_W;
  previewCanvas.height = PREVIEW_H;
  video       = document.getElementById('video');

  loadingBar    = document.getElementById('loading-bar');
  loadingStatus = document.getElementById('loading-status');
  statusOverlay = document.getElementById('status-overlay');
  errorMsg      = document.getElementById('error-msg');
  emotionDot    = document.getElementById('emotion-dot');
  emotionName   = document.getElementById('emotion-name');
  instrEl       = document.getElementById('instructions');
  faceRing      = document.getElementById('face-ring');
  handWarning   = document.getElementById('hand-warning');
  bgMusic       = document.getElementById('bg-music');
  eraseSfx      = document.getElementById('erase-sfx');
  undoSfx       = document.getElementById('undo-sfx');
  poofSfx       = document.getElementById('poof-sfx');

  // Audio amplification is now handled by the module-level initAudioAmplification()

  resizeAll();
  window.addEventListener('resize', resizeAll);
  bgLoop(performance.now());

  // Unlock audio on ANY user interaction (autoplay policy)
  const audioEvents = ['click', 'pointerdown', 'touchstart', 'keydown'];
  function onAudioUnlock() {
    tryPlayMusic();
    if (_audioPlaying) audioEvents.forEach(e => document.removeEventListener(e, onAudioUnlock));
  }
  audioEvents.forEach(e => document.addEventListener(e, onAudioUnlock));

  initHands();
});

// ─── Resize Both Canvases ──────────────────────────────────────
function resizeAll() {
  W = window.innerWidth;
  H = window.innerHeight;
  bgCanvas.width    = W; bgCanvas.height    = H;
  trailCanvas.width = W; trailCanvas.height = H;
  eraseCanvas.width = W; eraseCanvas.height = H;
  trailCtx.clearRect(0, 0, W, H);
  eraseCtx.clearRect(0, 0, W, H);
  undoHistory.length = 0;
}

// ─── Background Render Loop ────────────────────────────────────
function bgLoop(t) {
  drawBackground(t);
  requestAnimationFrame(bgLoop);
}

function drawBackground(t) {
  const ctx = bgCtx;
  ctx.clearRect(0, 0, W, H);

  const baseHue = (t * 0.012) % 360;
  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0,   `hsl(${baseHue}, 65%, 8%)`);
  base.addColorStop(0.5, `hsl(${(baseHue + 30) % 360}, 60%, 12%)`);
  base.addColorStop(1,   `hsl(${(baseHue + 60) % 360}, 55%, 6%)`);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = 'lighter';
  for (const b of BG_BLOBS) {
    const cx = (b.ox + Math.sin(t * b.sx + b.hue) * b.ax) * W;
    const cy = (b.oy + Math.cos(t * b.sy + b.hue * 0.7) * b.ay) * H;
    const rad = b.r * Math.min(W, H);
    const hue = (b.hue + t * b.hueSpeed) % 360;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0,   `hsla(${hue},80%,62%,0.55)`);
    g.addColorStop(0.4, `hsla(${(hue+20)%360},70%,55%,0.25)`);
    g.addColorStop(1,   `hsla(${(hue+40)%360},60%,45%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ─── MediaPipe Hands Init ─────────────────────────────────────
async function initHands() {
  try {
    setStatus('Loading face + hand models…', 10);

    // Load face-api.js models for expression detection
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(FACE_MODEL_URL);

    setStatus('Loading hand tracker…', 30);

    const hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });

    hands.onResults(onHandResults);

    setStatus('Starting camera…', 70);

    const camera = new Camera(video, {
      onFrame: async () => { await hands.send({ image: video }); },
      width: 1280,
      height: 720,
      facingMode: 'user',
    });
    await camera.start();

    setStatus('Ready', 100);
    statusOverlay.remove();

    // Try to start audio immediately (may fail without user gesture)
    initAudioAmplification();
    tryPlayMusic();

    detecting = true;
    trailLoop();
    faceDetectLoop();

  } catch (e) {
    setStatus('Error', 0);
    showError('Could not load hand tracker or camera.\nPlease allow camera access and refresh.');
    console.error(e);
  }
}

// ─── Face Detection Loop ──────────────────────────────────────
async function faceDetectLoop() {
  if (!detecting || video.readyState < 2) {
    setTimeout(faceDetectLoop, FACE_DETECT_MS);
    return;
  }
  try {
    const result = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceExpressions();
    if (result) {
      const box = result.detection.box;
      const vw = video.videoWidth  || 1;
      const vh = video.videoHeight || 1;
      faceBox = { x: box.x / vw, y: box.y / vh, w: box.width / vw, h: box.height / vh };
      // Pick the expression with highest probability
      const sorted = result.expressions.asSortedArray();
      if (sorted.length) {
        let detected = sorted[0].expression;
        // Remap removed emotions to neutral
        if (detected === 'fearful' || detected === 'disgusted') detected = 'neutral';
        faceEmotion = detected;
      }
    } else {
      faceBox = null;
    }
  } catch (_) { /* ignore transient errors */ }
  setTimeout(faceDetectLoop, FACE_DETECT_MS);
}

// ─── Hand Results Callback ────────────────────────────────────
let _audioUnlockedByHand = false;
function onHandResults(results) {
  if (!detecting) return;

  // Try to unlock audio on first hand detection
  if (!_audioUnlockedByHand && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    _audioUnlockedByHand = true;
    tryPlayMusic();
  }

  // Draw hand preview
  drawHandPreview(results);

  // ── Check for dual-L screenshot gesture (2 hands) ──
  if (results.multiHandLandmarks && results.multiHandLandmarks.length === 2) {
    const lm0 = results.multiHandLandmarks[0];
    const lm1 = results.multiHandLandmarks[1];

    if (detectLShape(lm0) && detectLShape(lm1)) {
      isSnapGesture = true;
      isOShape = false; eraseStart = 0;
      isTShape = false; undoStart = 0;
      wasDrawing = false;
      curEmotion = null;
      lastTrailPt = null;

      // Center between the two index fingertips (mirrored)
      const cx = ((1 - lm0[8].x) + (1 - lm1[8].x)) / 2 * W;
      const cy = (lm0[8].y + lm1[8].y) / 2 * H;
      snapCenter = { x: cx, y: cy };

      if (snapStart === 0) snapStart = Date.now();
      updateHUD(null);
      hideRing();

      if (!instrGone) { instrEl.style.opacity = '0'; instrGone = true; }
      return; // skip single-hand processing
    }
  }

  // If we were in snap gesture but lost it, reset
  if (isSnapGesture) {
    isSnapGesture = false;
    snapStart = 0;
    snapCenter = null;
  }

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const lm = results.multiHandLandmarks[0];

    // Index fingertip (landmark 8) as tracking point — mirror X
    const rawX = (1 - lm[8].x) * W;
    const rawY = lm[8].y * H;

    // Smooth position
    if (curPos === null) { smoothX = rawX; smoothY = rawY; }
    smoothX += (rawX - smoothX) * LERP_SPEED;
    smoothY += (rawY - smoothY) * LERP_SPEED;
    curPos = { x: smoothX, y: smoothY };

    // Check for O-shape (erase) → T-shape (undo) → pointing (draw)
    const oDetected = detectOShape(lm);
    const tDetected = !oDetected && detectTShape(lm);

    if (oDetected) {
      isOShape = true;
      isTShape = false; undoStart = 0; wasDrawing = false;
      if (eraseStart === 0) { eraseStart = Date.now(); poofPlayed = false; }
      curEmotion = null;
      lastTrailPt = null;
      updateHUD(null);
      updateRing(smoothX, smoothY, 50, 50, '#ffffff', false);

    } else if (tDetected) {
      isTShape = true;
      isOShape = false; eraseStart = 0; wasDrawing = false;
      if (undoStart === 0) { undoStart = Date.now(); poofPlayed = false; }
      curEmotion = null;
      lastTrailPt = null;
      updateHUD(null);
      updateRing(smoothX, smoothY, 50, 50, '#ffffff', false);

    } else {
      if (isOShape) lastTrailPt = null;
      if (isTShape) lastTrailPt = null;
      isOShape = false; eraseStart = 0;
      isTShape = false; undoStart = 0;

      const pointing = isPointing(lm);
      curEmotion = faceEmotion;

      const isDrawing = pointing && faceEmotion !== 'neutral';
      updateHUD(faceEmotion);
      updateRing(smoothX, smoothY, 50, 50, EMOTIONS[faceEmotion]?.hex || '#aaa', isDrawing);

      // Only draw trail when pointing (index finger only)
      if (pointing) {
        const now = Date.now();
        // Save canvas state when a new stroke begins
        if (!wasDrawing) {
          undoHistory.push(trailCtx.getImageData(0, 0, W, H));
          if (undoHistory.length > 20) undoHistory.shift();
          wasDrawing = true;
        }
        if (now - lastSample > SAMPLE_MS && faceEmotion !== 'neutral') {
          trail.push({ x: smoothX, y: smoothY, emotion: faceEmotion, t: now });
          lastSample = now;
        }
      } else {
        lastTrailPt = null;
        wasDrawing = false;
      }
    }

    // ── Hand-over-face detection ──
    checkHandOverFace(lm);

    if (!instrGone) {
      instrEl.style.opacity = '0';
      instrGone = true;
    }

  } else {
    curEmotion = null;
    curPos     = null;
    isOShape   = false;
    eraseStart = 0;
    isTShape   = false;
    undoStart  = 0;
    wasDrawing = false;
    isSnapGesture = false;
    snapStart  = 0;
    snapCenter = null;
    setHandWarning(false);
    updateHUD(null);
    hideRing();
  }
}

// ─── Hand Preview (top-right mini view) ───────────────────────
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],       // thumb
  [0,5],[5,6],[6,7],[7,8],       // index
  [5,9],[9,10],[10,11],[11,12],  // middle
  [9,13],[13,14],[14,15],[15,16],// ring
  [13,17],[17,18],[18,19],[19,20],// pinky
  [0,17],                         // palm base
];

function drawHandPreview(results) {
  const ctx = previewCtx;
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);

  // Draw mirrored camera feed
  if (video.readyState >= 2) {
    ctx.save();
    ctx.translate(PREVIEW_W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, PREVIEW_W, PREVIEW_H);
    ctx.restore();
    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  }

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;
  const lm = results.multiHandLandmarks[0];

  // Compute bounding box (mirrored)
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lm) {
    const mx = 1 - p.x; // mirror
    if (mx < minX) minX = mx;
    if (mx > maxX) maxX = mx;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 0.03;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    (minX - pad) * PREVIEW_W, (minY - pad) * PREVIEW_H,
    (maxX - minX + pad * 2) * PREVIEW_W, (maxY - minY + pad * 2) * PREVIEW_H
  );

  // Draw skeleton connections
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo((1 - lm[a].x) * PREVIEW_W, lm[a].y * PREVIEW_H);
    ctx.lineTo((1 - lm[b].x) * PREVIEW_W, lm[b].y * PREVIEW_H);
    ctx.stroke();
  }

  // Draw landmark dots
  const col = curEmotion && EMOTIONS[curEmotion] ? EMOTIONS[curEmotion].hex : '#fff';
  ctx.fillStyle = col;
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc((1 - p.x) * PREVIEW_W, p.y * PREVIEW_H, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw face bounding box + emotion label
  drawFaceOverlay(ctx);
}

function drawFaceOverlay(ctx) {
  if (!faceBox) return;

  // Mirror the face box X to match the mirrored camera feed
  const fx = (1 - faceBox.x - faceBox.w) * PREVIEW_W;
  const fy = faceBox.y * PREVIEW_H;
  const fw = faceBox.w * PREVIEW_W;
  const fh = faceBox.h * PREVIEW_H;

  const emotionColor = EMOTIONS[faceEmotion]?.hex || '#fff';

  // Box
  ctx.strokeStyle = emotionColor;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(fx, fy, fw, fh);

  // Label background
  const label = faceEmotion.charAt(0).toUpperCase() + faceEmotion.slice(1);
  ctx.font = '9px "Space Mono", monospace';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(fx, fy - 12, tw + 6, 12);

  // Label text
  ctx.fillStyle = emotionColor;
  ctx.fillText(label, fx + 3, fy - 3);
}

// ─── Pointing Detection (only index finger extended) ──────────
function isPointing(lm) {
  const [thumb, index, middle, ring, pinky] = getFingerStates(lm);
  return index && !middle && !ring && !pinky;
}

// ─── O-Shape Detection (thumb tip ↔ index tip close) ──────────
function detectOShape(lm) {
  const d = dist(lm[4], lm[8]);           // thumb tip to index tip
  const palmSize = dist(lm[0], lm[9]);    // wrist to middle MCP for scale
  return d < palmSize * 0.28;             // touching threshold
}

// ─── T-Shape Detection (thumb ⊥ index, others closed → undo) ─
function detectTShape(lm) {
  const [thumb, index, middle, ring, pinky] = getFingerStates(lm);

  // T-shape: thumb and index extended, others closed
  if (!thumb || !index || middle || ring || pinky) return false;

  // Must NOT be O-shape (thumb & index touching)
  const d = dist(lm[4], lm[8]);
  const palmSize = dist(lm[0], lm[9]);
  if (d < palmSize * 0.28) return false;

  // Thumb direction: MCP → tip
  const thumbDir = { x: lm[4].x - lm[2].x, y: lm[4].y - lm[2].y };
  // Index direction: MCP → tip
  const indexDir = { x: lm[8].x - lm[5].x, y: lm[8].y - lm[5].y };

  const dot  = thumbDir.x * indexDir.x + thumbDir.y * indexDir.y;
  const magT = Math.sqrt(thumbDir.x ** 2 + thumbDir.y ** 2);
  const magI = Math.sqrt(indexDir.x ** 2 + indexDir.y ** 2);
  if (magT < 0.001 || magI < 0.001) return false;

  const cosAngle = dot / (magT * magI);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;

  // Accept angles between 50° and 130° (roughly perpendicular)
  return angle > 50 && angle < 130;
}

// ─── L-Shape Detection (thumb + index at ~90°, others closed → screenshot) ─
function detectLShape(lm) {
  const [thumb, index, middle, ring, pinky] = getFingerStates(lm);

  // L-shape: thumb and index extended, others closed
  if (!thumb || !index || middle || ring || pinky) return false;

  // Must NOT be O-shape (thumb & index touching)
  const d = dist(lm[4], lm[8]);
  const palmSize = dist(lm[0], lm[9]);
  if (d < palmSize * 0.28) return false;

  // Thumb direction: MCP → tip
  const thumbDir = { x: lm[4].x - lm[2].x, y: lm[4].y - lm[2].y };
  // Index direction: MCP → tip
  const indexDir = { x: lm[8].x - lm[5].x, y: lm[8].y - lm[5].y };

  const dotP = thumbDir.x * indexDir.x + thumbDir.y * indexDir.y;
  const magT = Math.sqrt(thumbDir.x ** 2 + thumbDir.y ** 2);
  const magI = Math.sqrt(indexDir.x ** 2 + indexDir.y ** 2);
  if (magT < 0.001 || magI < 0.001) return false;

  const cosAngle = dotP / (magT * magI);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;

  // Accept angles between 60° and 120° (roughly perpendicular = L)
  return angle > 60 && angle < 120;
}

function getFingerStates(lm) {
  // Thumb: compare tip (4) to IP joint (3) in x-direction relative to wrist
  const thumbOpen = dist(lm[4], lm[9]) > dist(lm[3], lm[9]);

  // Other fingers: tip is farther from wrist than PIP joint
  const indexOpen  = dist(lm[8],  lm[0]) > dist(lm[6],  lm[0]);
  const middleOpen = dist(lm[12], lm[0]) > dist(lm[10], lm[0]);
  const ringOpen   = dist(lm[16], lm[0]) > dist(lm[14], lm[0]);
  const pinkyOpen  = dist(lm[20], lm[0]) > dist(lm[18], lm[0]);

  return [thumbOpen, indexOpen, middleOpen, ringOpen, pinkyOpen];
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ─── Hand-over-face warning ──────────────────────────────────
function checkHandOverFace(lm) {
  if (!faceBox) { setHandWarning(false); return; }

  // Compute hand bounding box in normalised coords (un-mirrored, same as faceBox)
  let hMinX = 1, hMaxX = 0, hMinY = 1, hMaxY = 0;
  for (const p of lm) {
    if (p.x < hMinX) hMinX = p.x;
    if (p.x > hMaxX) hMaxX = p.x;
    if (p.y < hMinY) hMinY = p.y;
    if (p.y > hMaxY) hMaxY = p.y;
  }

  // AABB overlap test
  const fb = faceBox;
  const overlap =
    hMinX < fb.x + fb.w &&
    hMaxX > fb.x &&
    hMinY < fb.y + fb.h &&
    hMaxY > fb.y;

  // Require significant overlap (at least 30% of face area covered)
  if (overlap) {
    const ox = Math.max(0, Math.min(hMaxX, fb.x + fb.w) - Math.max(hMinX, fb.x));
    const oy = Math.max(0, Math.min(hMaxY, fb.y + fb.h) - Math.max(hMinY, fb.y));
    const overlapArea = ox * oy;
    const faceArea = fb.w * fb.h;
    setHandWarning(overlapArea > faceArea * 0.30);
  } else {
    setHandWarning(false);
  }
}

function setHandWarning(show) {
  if (show === handOverFace) return; // no change
  handOverFace = show;
  if (handWarning) {
    handWarning.classList.toggle('visible', show);
  }
}

// ─── Trail Render Loop (60fps) ────────────────────────────────
let lastTrailPt = null;

function trailLoop() {
  if (!detecting) return;

  const ctx = trailCtx;
  const now = Date.now();

  // ── Draw pencil-style trail segments with color mixing ──
  ctx.globalCompositeOperation = 'source-over';

  while (trail.length > 0) {
    const pt = trail.shift();
    const col = EMOTIONS[pt.emotion] || EMOTIONS.neutral;

    if (lastTrailPt && lastTrailPt.emotion === pt.emotion) {
      // Sample existing pixel at the midpoint to mix colors
      const mx = Math.round((lastTrailPt.x + pt.x) / 2);
      const my = Math.round((lastTrailPt.y + pt.y) / 2);
      let drawColor = col.hex;

      if (mx >= 0 && mx < W && my >= 0 && my < H) {
        const pixel = ctx.getImageData(mx, my, 1, 1).data;
        if (pixel[3] > 20) { // existing color present
          const newRGB = hexToRGB(col.hex);
          // Blend 50/50 between existing and new color
          const blendR = Math.round((pixel[0] + newRGB.r) / 2);
          const blendG = Math.round((pixel[1] + newRGB.g) / 2);
          const blendB = Math.round((pixel[2] + newRGB.b) / 2);
          drawColor = `rgb(${blendR},${blendG},${blendB})`;
        }
      }

      ctx.save();
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth   = PENCIL_WIDTH;
      ctx.strokeStyle = drawColor;
      ctx.beginPath();
      ctx.moveTo(lastTrailPt.x, lastTrailPt.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();
    }
    // (skip dot for first segment — pencil only draws when moving)

    lastTrailPt = pt;
  }

  // ── Erase circle progress (O-shape) — drawn on separate overlay ──
  eraseCtx.clearRect(0, 0, W, H);
  if (isOShape && eraseStart > 0 && curPos) {
    // Start eraser SFX loop
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (eraseSfx && eraseSfx.paused) {
      eraseSfx.volume = 1.0;
      eraseSfx.currentTime = 0;
      eraseSfx.play().catch(() => {});
    }

    const elapsed  = now - eraseStart;
    const progress = Math.min(elapsed / ERASE_HOLD_MS, 1); // 0→1
    const endAngle = -Math.PI / 2 + progress * Math.PI * 2;

    // Interpolate color from white → red based on progress
    const r = 255;
    const g = Math.round(255 * (1 - progress));
    const b = Math.round(255 * (1 - progress));

    eraseCtx.save();
    eraseCtx.lineWidth   = 4;
    eraseCtx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
    eraseCtx.beginPath();
    eraseCtx.arc(curPos.x, curPos.y, ERASE_RADIUS, -Math.PI / 2, endAngle);
    eraseCtx.stroke();

    // "ERASING" label below progress ring
    eraseCtx.fillStyle  = `rgba(${r},${g},${b},0.8)`;
    eraseCtx.font       = '12px "Space Mono", monospace';
    eraseCtx.textAlign  = 'center';
    eraseCtx.fillText('ERASING', curPos.x, curPos.y + ERASE_RADIUS + 18);
    eraseCtx.restore();

    // Trigger poof SFX 0.5s before completion
    const erasePoofAt = 1 - (POOF_EARLY_MS / ERASE_HOLD_MS);
    if (!poofPlayed && progress >= erasePoofAt && poofSfx) {
      poofSfx.volume = 1.0;
      poofSfx.currentTime = 0;
      poofSfx.play().catch(() => {});
      poofPlayed = true;
    }

    // Full circle reached → erase everything
    if (progress >= 1) {
      ctx.clearRect(0, 0, W, H);
      eraseCtx.clearRect(0, 0, W, H);
      lastTrailPt = null;
      trail.length = 0;
      eraseStart = 0;
      undoHistory.length = 0; // nothing left to undo
      if (eraseSfx) { eraseSfx.pause(); eraseSfx.currentTime = 0; }
    }
  } else {
    // Not erasing → stop SFX if playing
    if (eraseSfx && !eraseSfx.paused) { eraseSfx.pause(); eraseSfx.currentTime = 0; }
  }

  // ── Undo circle progress (T-shape) — drawn on erase overlay ──
  if (isTShape && undoStart > 0 && curPos) {
    // Start undo SFX loop
    if (undoSfx && undoSfx.paused) {
      undoSfx.volume = 1.0;
      undoSfx.currentTime = 0;
      undoSfx.play().catch(() => {});
    }

    const elapsed  = now - undoStart;
    const progress = Math.min(elapsed / UNDO_HOLD_MS, 1);
    const endAngle = -Math.PI / 2 + progress * Math.PI * 2;

    // Interpolate color from white → blue based on progress
    const uR = Math.round(255 * (1 - progress));
    const uG = Math.round(255 * (1 - progress));
    const uB = 255;

    eraseCtx.save();
    eraseCtx.lineWidth   = 4;
    eraseCtx.strokeStyle = `rgba(${uR},${uG},${uB},0.9)`;
    eraseCtx.beginPath();
    eraseCtx.arc(curPos.x, curPos.y, ERASE_RADIUS, -Math.PI / 2, endAngle);
    eraseCtx.stroke();

    // "UNDO" label below progress ring
    eraseCtx.fillStyle  = `rgba(${uR},${uG},${uB},0.8)`;
    eraseCtx.font       = '12px "Space Mono", monospace';
    eraseCtx.textAlign  = 'center';
    eraseCtx.fillText('UNDO', curPos.x, curPos.y + ERASE_RADIUS + 18);
    eraseCtx.restore();

    // Trigger poof SFX 0.5s before completion
    const undoPoofAt = 1 - (POOF_EARLY_MS / UNDO_HOLD_MS);
    if (!poofPlayed && progress >= undoPoofAt && poofSfx) {
      poofSfx.volume = 1.0;
      poofSfx.currentTime = 0;
      poofSfx.play().catch(() => {});
      poofPlayed = true;
    }

    // Full circle reached → undo last stroke
    if (progress >= 1) {
      if (undoHistory.length > 0) {
        const snapshot = undoHistory.pop();
        ctx.clearRect(0, 0, W, H);
        ctx.putImageData(snapshot, 0, 0);
      }
      eraseCtx.clearRect(0, 0, W, H);
      lastTrailPt = null;
      trail.length = 0;
      undoStart = 0;
      if (undoSfx) { undoSfx.pause(); undoSfx.currentTime = 0; }
    }
  } else {
    // Not undoing → stop SFX if playing
    if (undoSfx && !undoSfx.paused) { undoSfx.pause(); undoSfx.currentTime = 0; }
  }

  // ── Screenshot progress (dual-L) — drawn on erase overlay ──
  if (isSnapGesture && snapStart > 0 && snapCenter) {
    const elapsed  = now - snapStart;
    const progress = Math.min(elapsed / SNAP_HOLD_MS, 1);
    const endAngle = -Math.PI / 2 + progress * Math.PI * 2;

    // Interpolate white → yellow
    const sR = 255;
    const sG = Math.round(255 * (1 - progress) + 220 * progress);
    const sB = Math.round(255 * (1 - progress));

    eraseCtx.save();
    eraseCtx.lineWidth   = 4;
    eraseCtx.strokeStyle = `rgba(${sR},${sG},${sB},0.9)`;
    eraseCtx.beginPath();
    eraseCtx.arc(snapCenter.x, snapCenter.y, ERASE_RADIUS, -Math.PI / 2, endAngle);
    eraseCtx.stroke();

    // "📸 SCREENSHOT" label
    eraseCtx.fillStyle  = `rgba(${sR},${sG},${sB},0.8)`;
    eraseCtx.font       = '12px "Space Mono", monospace';
    eraseCtx.textAlign  = 'center';
    eraseCtx.fillText('SCREENSHOT', snapCenter.x, snapCenter.y + ERASE_RADIUS + 18);
    eraseCtx.restore();

    // Full circle → take screenshot
    if (progress >= 1) {
      captureScreenshot();
      snapStart = 0;
      isSnapGesture = false;
      snapCenter = null;
    }
  }

  requestAnimationFrame(trailLoop);
}

// ─── Screenshot Capture ───────────────────────────────────────
function captureScreenshot() {
  // Merge bg-canvas + trail-canvas only (no HUD, no camera)
  const shotCanvas = document.createElement('canvas');
  shotCanvas.width  = W;
  shotCanvas.height = H;
  const shotCtx = shotCanvas.getContext('2d');
  shotCtx.drawImage(bgCanvas, 0, 0);
  shotCtx.drawImage(trailCanvas, 0, 0);

  // Trigger download
  const link = document.createElement('a');
  link.download = `emotion-canvas-${Date.now()}.png`;
  link.href = shotCanvas.toDataURL('image/png');
  link.click();

  // Flash effect – slow dissolve
  let flashOpacity = 0.7;
  function fadeFlash() {
    eraseCtx.clearRect(0, 0, W, H);
    if (flashOpacity <= 0) return;
    eraseCtx.save();
    eraseCtx.fillStyle = `rgba(255,255,255,${flashOpacity})`;
    eraseCtx.fillRect(0, 0, W, H);
    eraseCtx.restore();
    flashOpacity -= 0.012;          // ~60 frames → ~1 second fade
    requestAnimationFrame(fadeFlash);
  }
  fadeFlash();
}

// ─── HUD Updates ──────────────────────────────────────────────
function updateHUD(emotion) {
  Object.keys(EMOTIONS).forEach((k) => {
    document.getElementById('leg-' + k)?.classList.remove('active');
  });

  if (emotion && EMOTIONS[emotion]) {
    const ec = EMOTIONS[emotion];
    emotionName.textContent    = ec.name;
    emotionName.style.color      = ec.hex;
    emotionName.style.textShadow = `0 0 80px ${ec.hex}88`;
    emotionName.style.opacity    = '1';
    emotionDot.style.background  = ec.hex;
    emotionDot.style.boxShadow   = `0 0 24px ${ec.hex}, 0 0 8px ${ec.hex}`;
    document.getElementById('leg-' + emotion)?.classList.add('active');
  } else {
    emotionName.style.opacity  = '0';
    emotionDot.style.background = 'rgba(255,255,255,0.08)';
    emotionDot.style.boxShadow  = 'none';
  }
}

function updateRing(cx, cy, fw, fh, hex, drawing) {
  faceRing.style.left        = cx + 'px';
  faceRing.style.top         = cy + 'px';

  if (drawing) {
    faceRing.classList.add('drawing');
    faceRing.style.width       = Math.max(50, fw * 0.5) + 'px';
    faceRing.style.height      = Math.max(60, fh * 0.5) + 'px';
    faceRing.style.background  = 'transparent';
    faceRing.style.borderColor = 'transparent';
    faceRing.style.boxShadow   = 'none';
    faceRing.style.filter      = `drop-shadow(0 0 12px ${hex}30) drop-shadow(0 0 6px ${hex}18)`;
    faceRing.innerHTML = `<svg viewBox="0 0 100 120" preserveAspectRatio="none"><polygon points="50,5 5,115 95,115" fill="none" stroke="${hex}" stroke-width="2" opacity="0.4"/></svg>`;
  } else {
    faceRing.classList.remove('drawing');
    faceRing.innerHTML         = '';
    faceRing.style.width       = Math.max(50, fw * 0.5) + 'px';
    faceRing.style.height      = Math.max(60, fh * 0.5) + 'px';
    faceRing.style.background  = 'transparent';
    faceRing.style.borderColor = hex + '40';
    faceRing.style.boxShadow   = `0 0 12px ${hex}30, inset 0 0 8px ${hex}18`;
    faceRing.style.filter      = 'none';
  }
}

function hideRing() {
  faceRing.style.top  = '-9999px';
  faceRing.style.left = '-9999px';
}

// ─── Utilities ────────────────────────────────────────────────
function setStatus(msg, pct) {
  if (loadingStatus) loadingStatus.textContent = msg;
  if (loadingBar)    loadingBar.style.width = pct + '%';
}

function showError(msg) {
  if (errorMsg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }
}

function hexToRGB(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}


