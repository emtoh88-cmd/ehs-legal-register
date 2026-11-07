// Synthetic stick-figure poses in MediaPipe landmark format.
// Used by the tests and by the in-app demo, so recognition can be shown and
// checked without a camera.

const D = Math.PI / 180;
const rot = (v, d) => { const c = Math.cos(d * D), s = Math.sin(d * D); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const add = (a, v, l) => ({ x: a.x + v.x * l, y: a.y + v.y * l });
const neg = v => ({ x: -v.x, y: -v.y });

function toLandmarks(pts) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [i, p] of Object.entries(pts)) lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 };
  return lm;
}

// Side-on figure facing right. Angles in degrees.
// tilt: torso from vertical; hip/knee/elbow: joint angles; arm: upper arm from straight down.
export function sidePose({ tilt = 0, hip = 180, knee = 180, arm = 0, elbow = 180, x = 0.5, y = 0.55, scale = 1 } = {}) {
  const hp = { x, y };
  const torso = { x: Math.sin(tilt * D), y: -Math.cos(tilt * D) };
  const sh = add(hp, torso, 0.25 * scale);
  const thigh = rot(torso, hip), kn = add(hp, thigh, 0.22 * scale);
  const an = add(kn, rot(neg(thigh), -knee), 0.22 * scale);
  const ua = rot({ x: 0, y: 1 }, -arm), el = add(sh, ua, 0.15 * scale);
  const wr = add(el, rot(neg(ua), elbow), 0.14 * scale);
  const nose = add(add(sh, torso, 0.1 * scale), rot(torso, 90), 0.04 * scale);
  return toLandmarks({ 0: nose, 11: sh, 12: sh, 13: el, 14: el, 15: wr, 16: wr, 23: hp, 24: hp, 25: kn, 26: kn, 27: an, 28: an });
}

// Facing the camera. abd: arm raised sideways from down (0) to overhead (180);
// elbow: bend, forearm folds upward; legs: each leg's angle out from vertical.
export function frontPose({ abd = 10, abdL, abdR, elbow = 180, legs = 3, knee = 180, x = 0.5, y = 0.55, scale = 1 } = {}) {
  const pts = {}; const T = 0.25 * scale;
  for (const s of [1, -1]) {
    const a = s === 1 ? abdR ?? abd : abdL ?? abd;
    const sh = { x: x + s * 0.09 * scale, y: y - T }, hp = { x: x + s * 0.06 * scale, y };
    const ua = rot({ x: 0, y: 1 }, -s * a), el = add(sh, ua, 0.15 * scale);
    const wr = add(el, rot(neg(ua), s * elbow), 0.14 * scale);
    const th = rot({ x: 0, y: 1 }, -s * legs), kn = add(hp, th, 0.22 * scale);
    const an = add(kn, rot(neg(th), -s * knee), 0.22 * scale);
    const o = s === 1 ? 0 : 1; // image-right = person's left (mirrored selfie view)
    Object.assign(pts, { [11 + o]: sh, [13 + o]: el, [15 + o]: wr, [23 + o]: hp, [25 + o]: kn, [27 + o]: an });
  }
  pts[0] = { x, y: y - T - 0.1 * scale };
  return toLandmarks(pts);
}

// Small deterministic PRNG so tests are repeatable.
export function rng(seed = 1) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

const lerp = (a, b, k) => { const o = {}; for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) o[key] = typeof a[key] === 'number' ? a[key] + ((b[key] ?? a[key]) - a[key]) * k : a[key]; return o; };

// Frames for `reps` cycles top -> bottom -> top, then `restMs` holding the top.
export function animate({ pose, top, bottom, reps, periodMs = 1800, restMs = 0, fps = 30, t0 = 0, noise = 2, seed = 7, startAtBottom = false }) {
  const r = rng(seed), frames = []; const dt = 1000 / fps;
  const jitter = p => { const o = { ...p }; for (const k in o) if (typeof o[k] === 'number' && !['x', 'y', 'scale'].includes(k)) o[k] += (r() - 0.5) * 2 * noise; return o; };
  const total = reps * periodMs;
  for (let t = 0; t < total; t += dt) {
    let k = (1 - Math.cos((2 * Math.PI * t) / periodMs)) / 2; // 0 top, 1 bottom
    if (startAtBottom) k = 1 - k;
    frames.push({ t: t0 + t, lm: pose(jitter(lerp(top, bottom, k))) });
  }
  const rest = startAtBottom ? bottom : top;
  for (let t = total; t < total + restMs; t += dt) frames.push({ t: t0 + t, lm: pose(jitter(rest)) });
  return frames;
}

export const DEMOS = {
  squat:  { pose: sidePose, top: { tilt: 5, hip: 175, knee: 178, arm: 75, elbow: 175 }, bottom: { tilt: 40, hip: 70, knee: 78, arm: 85, elbow: 175 }, periodMs: 2000 },
  pushup: { pose: sidePose, top: { tilt: 76, hip: 178, knee: 178, arm: 0, elbow: 172, y: 0.6 }, bottom: { tilt: 82, hip: 176, knee: 178, arm: 40, elbow: 75, y: 0.66 }, periodMs: 1600 },
  curl:   { pose: sidePose, top: { tilt: 2, arm: 8, elbow: 170 }, bottom: { tilt: 2, arm: 18, elbow: 38 }, periodMs: 1800 },
  press:  { pose: frontPose, top: { abd: 172, elbow: 176 }, bottom: { abd: 92, elbow: 88 }, periodMs: 2000, startAtBottom: true },
  jack:   { pose: frontPose, top: { abd: 15, legs: 3 }, bottom: { abd: 172, legs: 20 }, periodMs: 900 },
  plank:  { pose: sidePose, top: { tilt: 80, hip: 176, knee: 178, arm: 0, elbow: 92, y: 0.62 }, bottom: { tilt: 80, hip: 176, knee: 178, arm: 0, elbow: 92, y: 0.62 }, periodMs: 1000 },
};
