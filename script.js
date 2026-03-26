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
     Peace sign = Surprised (orange)
     Thumbs up  = Happy (yellow)
     One finger = Sad (blue)
     Horns      = Disgusted (green)
     No hand    = no trail
================================================================ */

// ─── Configuration ────────────────────────────────────────────
const SAMPLE_MS      = 16;    // ms between trail captures
const LERP_SPEED     = 0.18;  // hand position smoothing (0–1)
const ERASE_HOLD_MS  = 2500;  // hold O-shape this long to erase
const ERASE_RADIUS   = 50;    // radius of the erase progress circle
const PENCIL_WIDTH   = 8;     // trail line thickness

// ─── Emotion → Color Map ──────────────────────────────────────
const EMOTIONS = {
  happy:     { hex:'#FFDC00', name:'Happy'     },
  sad:       { hex:'#3C64FF', name:'Sad'       },
  angry:     { hex:'#FF1E1E', name:'Angry'     },
  disgusted: { hex:'#1ED250', name:'Disgusted' },
  fearful:   { hex:'#B91EFF', name:'Fearful'   },
  surprised: { hex:'#FF9100', name:'Surprised' },
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
let faceEmotion = 'neutral';
let faceBox     = null;

// ─── Face Detection Config ────────────────────────────────────
const FACE_DETECT_MS  = 120;
const FACE_MODEL_URL  = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';

// ─── DOM refs ─────────────────────────────────────────────────
let loadingBar, loadingStatus, statusOverlay, errorMsg;
let emotionDot, emotionName, instrEl, faceRing;

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

  resizeAll();
  window.addEventListener('resize', resizeAll);
  bgLoop(performance.now());

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
      maxNumHands: 1,
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
      if (sorted.length) faceEmotion = sorted[0].expression;
    } else {
      faceBox = null;
    }
  } catch (_) { /* ignore transient errors */ }
  setTimeout(faceDetectLoop, FACE_DETECT_MS);
}

// ─── Hand Results Callback ────────────────────────────────────
function onHandResults(results) {
  if (!detecting) return;

  // Draw hand preview
  drawHandPreview(results);

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

    // Check for O-shape (erase gesture) first
    const oDetected = detectOShape(lm);

    if (oDetected) {
      isOShape = true;
      if (eraseStart === 0) eraseStart = Date.now();
      curEmotion = null;
      lastTrailPt = null;  // break trail so O-shape doesn't draw
      updateHUD(null);
      updateRing(smoothX, smoothY, 50, 50, '#ffffff');
    } else {
      if (isOShape) lastTrailPt = null; // break trail coming out of O
      isOShape = false;
      eraseStart = 0;

      const pointing = isPointing(lm);
      curEmotion = faceEmotion;

      updateHUD(faceEmotion);
      updateRing(smoothX, smoothY, 50, 50, EMOTIONS[faceEmotion]?.hex || '#aaa');

      // Only draw trail when pointing (index finger only)
      if (pointing) {
        const now = Date.now();
        if (now - lastSample > SAMPLE_MS && faceEmotion !== 'neutral') {
          trail.push({ x: smoothX, y: smoothY, emotion: faceEmotion, t: now });
          lastSample = now;
        }
      } else {
        lastTrailPt = null; // break trail when not pointing
      }
    }

    if (!instrGone) {
      instrEl.style.opacity = '0';
      instrGone = true;
    }

  } else {
    curEmotion = null;
    curPos     = null;
    isOShape   = false;
    eraseStart = 0;
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

// ─── Trail Render Loop (60fps) ────────────────────────────────
let lastTrailPt = null;

function trailLoop() {
  if (!detecting) return;

  const ctx = trailCtx;
  const now = Date.now();

  // ── Draw pencil-style trail segments (flat, no glow) ──
  ctx.globalCompositeOperation = 'source-over';

  while (trail.length > 0) {
    const pt = trail.shift();
    const col = EMOTIONS[pt.emotion] || EMOTIONS.neutral;

    if (lastTrailPt && lastTrailPt.emotion === pt.emotion) {
      ctx.save();
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth   = PENCIL_WIDTH;
      ctx.strokeStyle = col.hex;
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
    const elapsed  = now - eraseStart;
    const progress = Math.min(elapsed / ERASE_HOLD_MS, 1); // 0→1
    const endAngle = -Math.PI / 2 + progress * Math.PI * 2;

    eraseCtx.save();
    eraseCtx.lineWidth   = 4;
    eraseCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    eraseCtx.beginPath();
    eraseCtx.arc(curPos.x, curPos.y, ERASE_RADIUS, -Math.PI / 2, endAngle);
    eraseCtx.stroke();
    eraseCtx.restore();

    // Full circle reached → erase everything
    if (progress >= 1) {
      ctx.clearRect(0, 0, W, H);
      eraseCtx.clearRect(0, 0, W, H);
      lastTrailPt = null;
      trail.length = 0;
      eraseStart = 0;
    }
  }

  requestAnimationFrame(trailLoop);
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

function updateRing(cx, cy, fw, fh, hex) {
  faceRing.style.left        = cx + 'px';
  faceRing.style.top         = cy + 'px';
  faceRing.style.width       = Math.max(50, fw * 0.5) + 'px';
  faceRing.style.height      = Math.max(60, fh * 0.5) + 'px';
  faceRing.style.borderColor = hex + '40';
  faceRing.style.boxShadow   = `0 0 12px ${hex}30, inset 0 0 8px ${hex}18`;
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


