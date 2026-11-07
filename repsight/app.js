import { createTracker, EXERCISES } from './detect.js';
import { animate, DEMOS } from './synth.js';
import { createWeightScan, scanStill, isLoaded } from './scanner.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};
const KG_PER_LB = 0.45359237;
const STORE_KEY = 'repsight.v1';
const $ = id => document.getElementById(id);

// ---------- storage ----------
const defaults = { workouts: [], current: null, settings: { unit: 'kg', idle: 6, sound: true, model: 'lite', scan: 'ocr', apiKey: '', barKg: 20 } };
let db = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE_KEY)); if (d) return { ...defaults, ...d, settings: { ...defaults.settings, ...d.settings } }; } catch {}
  return structuredClone(defaults);
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch {} }
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- units / formatting ----------
const toDisplay = kg => (kg == null ? '' : db.settings.unit === 'lb' ? +(kg / KG_PER_LB).toFixed(1) : +kg.toFixed(1));
const fromDisplay = v => (v === '' || v == null || isNaN(+v) ? null : db.settings.unit === 'lb' ? +v * KG_PER_LB : +v);
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`; };
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const many = name => name.toLowerCase() + (/s$/i.test(name) ? 'es' : 's'); // "press" -> "presses"
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }

// ---------- sound ----------
let audio;
function beep(freq = 880, ms = 70) {
  if (!db.settings.sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(0.15, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch {}
}

// ---------- workout session ----------
function ensureSession() { if (!db.current) db.current = { id: uid(), startedAt: Date.now(), sets: [] }; return db.current; }
function lastWeight(ex) {
  // newest first: this workout's sets, then saved workouts (stored newest first)
  const all = [...(db.current?.sets || [])].reverse().concat(db.workouts.flatMap(w => [...w.sets].reverse()));
  return all.find(s => s.exercise === ex && s.weightKg != null) || null;
}
let freshId = null;
function addSet(set, source) {
  const s = ensureSession();
  // weight priority: scanned during the set > typed in the form > same as last time
  const scanned = set.scan || null, prev = scanned || set.weightKg != null ? null : lastWeight(set.exercise);
  const row = {
    id: uid(), exercise: set.exercise, reps: set.reps ?? null, seconds: set.seconds ?? null, source, at: Date.now(),
    weightKg: scanned ? scanned.weightKg : set.weightKg ?? prev?.weightKg ?? null,
    weightSrc: scanned ? 'scan' : set.weightKg != null ? 'manual' : prev ? 'last' : null,
    implement: scanned?.implement ?? prev?.implement ?? null,
    weightNote: scanned ? `${scanned.label}${scanned.evidence ? ` (${scanned.evidence})` : ''}, read by ${scanned.engine === 'claude' ? 'Claude' : 'on-device OCR'}` : prev ? 'Same as your last set' : null,
  };
  s.sets.push(row); freshId = row.id; save(); renderSession();
  const ex = EXERCISES[row.exercise];
  const w = row.weightSrc === 'scan' ? ` @ ${toDisplay(row.weightKg)} ${db.settings.unit} (scanned)` : '';
  toast(ex.kind === 'hold' ? `Logged ${ex.name}: ${fmtDur(row.seconds)}` : `Logged ${ex.name}: ${row.reps} reps${w}`);
}

const IMPLEMENT_LABEL = { dumbbell: 'each', kettlebell: 'each', barbell: 'total', ez_bar: 'total' };
function weightTag(s) {
  if (s.weightSrc === 'scan') return `<span class="wtag scan" title="${esc(s.weightNote || 'Scanned')}">Scanned${IMPLEMENT_LABEL[s.implement] ? ` · ${IMPLEMENT_LABEL[s.implement]}` : ''}</span>`;
  if (s.weightSrc === 'last') return `<span class="wtag" title="${esc(s.weightNote || '')}">Last time</span>`;
  return '';
}

function renderSession() {
  const cur = db.current, box = $('session-sets');
  $('finish-btn').disabled = !cur || !cur.sets.length;
  $('discard-row').hidden = !cur || !cur.sets.length;
  if (!cur || !cur.sets.length) { box.innerHTML = '<p class="empty">No sets yet. Start the camera or run a demo, and finished sets will be logged here automatically.</p>'; $('session-meta').textContent = 'Sets the camera records appear here. You can edit weight and reps.'; return; }
  const groups = []; for (const s of cur.sets) { const g = groups.at(-1); if (g && g.ex === s.exercise) g.sets.push(s); else groups.push({ ex: s.exercise, sets: [s] }); }
  const unit = db.settings.unit;
  box.innerHTML = groups.map(g => {
    const ex = EXERCISES[g.ex], hold = ex.kind === 'hold';
    return `<div class="ex-block"><div class="ex-title"><h3>${esc(ex.name)}</h3><span>${esc(ex.muscle)}</span></div>
      <table class="set-table"><thead><tr><th>Set</th><th>${hold ? 'Time (s)' : 'Reps'}</th><th>${unit}</th><th></th><th><span class="sr" hidden>Delete</span></th></tr></thead><tbody>
      ${g.sets.map((s, i) => `<tr class="${s.id === freshId ? 'fresh' : ''}" data-id="${s.id}">
        <td class="set-no">${i + 1}</td>
        <td><input type="number" min="0" inputmode="numeric" data-f="${hold ? 'seconds' : 'reps'}" value="${hold ? s.seconds ?? '' : s.reps ?? ''}" aria-label="${hold ? 'Seconds' : 'Reps'}" id="in-${s.id}-a"></td>
        <td><div class="w-cell"><input type="number" min="0" step="0.5" inputmode="decimal" data-f="weight" value="${toDisplay(s.weightKg)}" placeholder="—" aria-label="Weight in ${unit}" id="in-${s.id}-w">${weightTag(s)}</div></td>
        <td><span class="src ${s.source}">${s.source === 'camera' ? 'Camera' : s.source === 'video' ? 'Video' : s.source === 'demo' ? 'Demo' : 'Manual'}</span></td>
        <td><button class="del" data-del="${s.id}" aria-label="Delete set">×</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }).join('');
  freshId = null;
  const reps = cur.sets.reduce((a, s) => a + (s.reps || 0), 0);
  $('session-meta').textContent = `Started ${new Date(cur.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${plural(cur.sets.length, 'set')} · ${plural(reps, 'rep')}`;
}

$('session-sets').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const s = db.current.sets.find(x => x.id === tr.dataset.id); const f = e.target.dataset.f;
  if (f === 'weight') { s.weightKg = fromDisplay(e.target.value); s.weightSrc = s.weightKg == null ? null : 'manual'; s.weightNote = null; }
  else s[f] = e.target.value === '' ? null : Math.max(0, Math.round(+e.target.value));
  save(); renderSession();
});
$('session-sets').addEventListener('click', e => {
  const id = e.target.dataset?.del; if (!id) return;
  db.current.sets = db.current.sets.filter(s => s.id !== id); save(); renderSession();
});

$('add-ex').innerHTML = Object.entries(EXERCISES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
$('add-set-btn').onclick = () => { const f = $('add-set-form'); f.hidden = !f.hidden; if (!f.hidden) { $('add-reps').placeholder = EXERCISES[$('add-ex').value].kind === 'hold' ? 'Seconds' : 'Reps'; $('add-reps').focus(); } };
$('add-ex').onchange = () => { $('add-reps').placeholder = EXERCISES[$('add-ex').value].kind === 'hold' ? 'Seconds' : 'Reps'; };
$('add-set-form').addEventListener('submit', e => {
  e.preventDefault();
  const ex = $('add-ex').value, n = Math.max(0, Math.round(+$('add-reps').value || 0));
  if (!n) { $('add-reps').focus(); toast(EXERCISES[ex].kind === 'hold' ? 'Enter how many seconds you held it' : 'Enter how many reps you did'); return; }
  const w = fromDisplay($('add-weight').value);
  addSet(EXERCISES[ex].kind === 'hold' ? { exercise: ex, seconds: n, weightKg: w ?? undefined } : { exercise: ex, reps: n, weightKg: w ?? undefined }, 'manual');
  $('add-reps').value = ''; $('add-weight').value = '';
});

$('finish-btn').onclick = () => {
  const cur = db.current; if (!cur || !cur.sets.length) return;
  stopAll();
  db.workouts.unshift({ ...cur, endedAt: Date.now() }); db.current = null; save();
  renderSession(); renderHistory(); renderExercises(); toast('Workout saved'); location.hash = 'history';
};
$('discard-btn').onclick = e => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Tap again to discard all sets'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Discard workout'; }, 3000); return; }
  db.current = null; save(); renderSession(); b.classList.remove('armed'); b.textContent = 'Discard workout'; toast('Workout discarded');
};

// ---------- HUD ----------
const hud = { weight: $('hud-weight'), chip: $('hud-exercise'), status: $('hud-status'), count: $('hud-count'), label: $('hud-count-label'), meter: $('hud-meter-fill'), rest: $('hud-rest') };
let lastSetEndAt = null, restTimer = null;
function setChip(text, state) { hud.chip.textContent = text; hud.chip.dataset.state = state; }
function setCount(n, label = 'reps') { if (hud.count.textContent !== String(n)) { hud.count.textContent = n; hud.count.classList.remove('bump'); void hud.count.offsetWidth; hud.count.classList.add('bump'); } hud.label.textContent = label; }
function startRest() {
  lastSetEndAt = Date.now(); hud.rest.hidden = false; clearInterval(restTimer);
  const tick = () => { hud.rest.textContent = `Rest ${clock((Date.now() - lastSetEndAt) / 1000)}`; };
  tick(); restTimer = setInterval(tick, 1000);
}
function stopRest() { clearInterval(restTimer); hud.rest.hidden = true; }
function showWeight(text, state = 'found') { hud.weight.hidden = !text; if (text) { hud.weight.textContent = text; hud.weight.dataset.state = state; } }
function resetHud() { showWeight(pendingWeight ? `Next set: ${weightText(pendingWeight)}` : null, 'pending'); setChip('No exercise yet', 'idle'); hud.count.textContent = '0'; hud.label.textContent = 'reps'; hud.meter.style.height = '0%'; }

// ---------- recognition pipeline ----------
let tracker = createTracker({ idleMs: db.settings.idle * 1000 });
let source = null; // 'camera' | 'video' | 'demo'
let lastPerson = 0;

// ---------- weight scanning ----------
let wscan = null, wscanEx = null, pendingWeight = null, lastScanTick = 0, lastLm = null;
const weightText = w => `${toDisplay(w.weightKg)} ${db.settings.unit}${IMPLEMENT_LABEL[w.implement] ? ` ${IMPLEMENT_LABEL[w.implement]}` : ''}`;
function scanEngine() { if (window.REPSIGHT_PREVIEW) return 'off'; const e = db.settings.scan; return e === 'claude' && !db.settings.apiKey ? 'ocr' : e; }
function beginScan(ex) {
  if (scanEngine() === 'off' || !isLoaded(ex) || pendingWeight || (wscan && wscanEx === ex)) return;
  wscanEx = ex;
  showWeight('Looking for weights…', 'searching');
  wscan = createWeightScan({
    exercise: ex, engine: scanEngine(), apiKey: db.settings.apiKey, barKg: db.settings.barKg, defaultUnit: db.settings.unit,
    exerciseName: EXERCISES[ex].name,
    onResult: r => { if (wscanEx === ex) { showWeight(`${weightText(r)} · scanned`, 'found'); beep(1200, 60); } },
    onError: err => { console.error(err); showWeight('Weight scan unavailable', 'error'); notice(`<strong>Weight scan failed.</strong> ${esc(scanErrorText(err))}`); },
  });
}
function scanErrorText(err) {
  const st = err?.status;
  if (st === 401) return 'Your Anthropic API key was rejected. Check it in Settings.';
  if (st === 429) return 'Anthropic rate limit reached. Try again in a minute, or switch to on-device scanning in Settings.';
  if (/load/i.test(err?.message || '')) return 'The text-recognition engine could not be downloaded. Check your connection.';
  return 'Type the weight in the set row instead.';
}
function takeScanResult() {
  const r = wscan?.result || pendingWeight || null;
  wscan = null; wscanEx = null; pendingWeight = null;
  return r;
}
async function scanTick(lm) {
  if (!wscan || wscan.done) return;
  const now = performance.now(); if (now - lastScanTick < 450) return; lastScanTick = now;
  const frame = grabFrame(lm); if (!frame) return;
  wscan.tick(frame, lm);
  if (wscan.done && !wscan.result) showWeight('No weight read · type it in', 'error');
}

function meterValue(f, ex) {
  if (!f || !f.visible) return 0;
  const norm = (v, top, bottom) => (v == null ? 0 : Math.max(0, Math.min(1, (top - v) / (top - bottom))));
  switch (ex) {
    case 'squat': return norm(f.knee, 170, 90);
    case 'pushup': case 'press': return norm(f.elbow, 170, 85);
    case 'curl': return norm(Math.min(f.elbowL ?? 180, f.elbowR ?? 180), 165, 45);
    case 'jack': return f.spread == null ? 0 : Math.max(0, Math.min(1, (f.spread - 0.8) / 1.2));
    case 'plank': return 1;
    default: return Math.max(norm(f.knee, 170, 90), norm(f.elbow, 170, 70));
  }
}

function handleFrame(lm, t, aspect) {
  const events = tracker.update(lm, t, aspect);
  const f = tracker.features;
  if (lm && f?.visible) lastPerson = t;
  for (const e of events) {
    const ex = EXERCISES[e.exercise ?? e.set?.exercise];
    if (e.type === 'candidate' || e.type === 'set-start') beginScan(e.exercise);
    if (e.type === 'candidate' && !tracker.active) { setChip(`${ex.name}?`, 'guess'); hud.status.textContent = `Looks like ${many(ex.name)}. Keep going to confirm.`; }
    if (e.type === 'set-start') { stopRest(); setChip(ex.name, 'active'); hud.status.textContent = ex.kind === 'hold' ? 'Holding. The timer stops when you drop.' : 'Recording reps.'; beep(660, 120); }
    if (e.type === 'rep') { setCount(e.reps, 'reps'); beep(); }
    if (e.type === 'hold') setCount(e.seconds, 'sec');
    if (e.type === 'set-end') { addSet({ ...e.set, scan: takeScanResult() }, source === 'demo' ? 'demo' : source === 'video' ? 'video' : 'camera'); showWeight(null); beep(990, 180); setChip(`${ex.name} done`, 'idle'); hud.status.textContent = 'Set logged. Start your next set whenever you are ready.'; startRest(); }
  }
  if (!tracker.active && t - lastPerson > 1500 && source !== 'demo') hud.status.textContent = lm ? 'Step back so your shoulders, hips and feet are all in view.' : 'No one in view. Point the camera at the person exercising.';
  hud.meter.style.height = `${Math.round(meterValue(f, tracker.active?.exercise) * 100)}%`;
  lastLm = lm; scanTick(lm);
}

function flushTracker() { for (const e of tracker.flush()) if (e.type === 'set-end') { addSet({ ...e.set, scan: takeScanResult() }, source === 'demo' ? 'demo' : source === 'video' ? 'video' : 'camera'); showWeight(null); startRest(); } }

// ---------- overlay drawing ----------
const canvas = $('overlay'), ctx = canvas.getContext('2d'), stage = $('stage'), video = $('video');
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
function drawFigure(c, lm, P, lw) {
  const vis = i => (lm[i]?.visibility ?? 1) > 0.5;
  const bone = getComputedStyle(document.documentElement).getPropertyValue('--bone').trim() || '#59d3ff';
  c.lineCap = 'round'; c.lineWidth = lw; c.strokeStyle = bone; c.globalAlpha = 0.9;
  for (const [a, b] of BONES) if (lm[a] && lm[b] && vis(a) && vis(b)) { c.beginPath(); c.moveTo(...P(a)); c.lineTo(...P(b)); c.stroke(); }
  c.fillStyle = '#fff';
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) if (lm[i] && vis(i)) { c.beginPath(); c.arc(...P(i), lw * 0.9, 0, Math.PI * 2); c.fill(); }
  c.globalAlpha = 1;
}

// Demo equipment, drawn with printed labels so the scanner has something real to read.
const DEMO_LOADS = { curl: { kind: 'dumbbell', label: '12 KG' }, squat: { kind: 'plate', label: '20 KG' }, press: { kind: 'bar', label: '10 KG' } };
let demoExercise = null;
function drawLoad(c, lm, P, ex) {
  const load = DEMO_LOADS[ex]; if (!load) return;
  const [ex1, ey1] = P(13), [wx, wy] = P(15), u = Math.hypot(wx - ex1, wy - ey1) || 40;
  const label = (x, y, size, fg = '#fff') => { c.fillStyle = fg; c.font = `700 ${Math.round(size)}px Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(load.label, x, y); };
  const disc = (x, y, r) => { c.fillStyle = '#26282d'; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#c23b2e'; c.lineWidth = r * 0.12; c.stroke(); };
  if (load.kind === 'dumbbell') {
    const seen = new Set();
    for (const w of [15, 16]) {
      const [x, y] = P(w), k = `${Math.round(x / 10)},${Math.round(y / 10)}`; if (seen.has(k)) continue; seen.add(k);
      c.fillStyle = '#26282d'; c.fillRect(x - u * 0.55, y - u * 0.22, u * 1.1, u * 0.44);
      label(x, y, u * 0.3);
    }
  } else if (load.kind === 'plate') {
    const [sx, sy] = P(11); disc(sx, sy, u * 0.75); label(sx, sy, u * 0.3);
  } else {
    const [lx, ly] = P(15), [rx, ry] = P(16), dx = rx - lx, dy = ry - ly;
    c.strokeStyle = '#9aa0aa'; c.lineWidth = u * 0.08; c.beginPath(); c.moveTo(lx - dx * 0.75, ly - dy * 0.75); c.lineTo(rx + dx * 0.75, ry + dy * 0.75); c.stroke();
    for (const [x, y] of [[rx + dx * 0.45, ry + dy * 0.45], [lx - dx * 0.45, ly - dy * 0.45]]) { disc(x, y, u * 0.62); label(x, y, u * 0.26); }
  }
}

function drawPose(lm, srcW, srcH) {
  const dpr = window.devicePixelRatio || 1, W = stage.clientWidth, H = stage.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  if (!lm) return;
  const s = Math.min(W / srcW, H / srcH), ox = (W - srcW * s) / 2, oy = (H - srcH * s) / 2; // object-fit: contain
  const P = i => [ox + lm[i].x * srcW * s, oy + lm[i].y * srcH * s];
  drawFigure(ctx, lm, P, Math.max(3, W / 160));
  if (source === 'demo') drawLoad(ctx, lm, P, demoExercise); // equipment in front of the body, label unobstructed
}

// The image the weight scanner reads: the current video frame, or the demo scene.
const grabCanvas = document.createElement('canvas');
function grabFrame(lm) {
  const g = grabCanvas.getContext('2d', { willReadFrequently: true });
  if (source === 'demo') {
    if (!lm) return null;
    grabCanvas.width = grabCanvas.height = 720;
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, 720, 720);
    const P = i => [lm[i].x * 720, lm[i].y * 720];
    drawFigure(g, lm, P, 5); drawLoad(g, lm, P, demoExercise);
    return grabCanvas;
  }
  if (!video.videoWidth) return null;
  if (grabCanvas.width !== video.videoWidth || grabCanvas.height !== video.videoHeight) { grabCanvas.width = video.videoWidth; grabCanvas.height = video.videoHeight; }
  g.drawImage(video, 0, 0);
  return grabCanvas;
}

// ---------- MediaPipe pose model ----------
let landmarker = null, landmarkerModel = null, loading = null;
async function getLandmarker() {
  if (landmarker && landmarkerModel === db.settings.model) return landmarker;
  if (loading) return loading;
  loading = (async () => {
    notice('Loading the pose model (about 6 MB the first time)…');
    const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = d => ({ baseOptions: { modelAssetPath: MODELS[db.settings.model], delegate: d }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lmk;
    try { lmk = await vision.PoseLandmarker.createFromOptions(fileset, opts('GPU')); } catch { lmk = await vision.PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
    landmarker?.close?.(); landmarker = lmk; landmarkerModel = db.settings.model; notice(null);
    return lmk;
  })();
  try { return await loading; } finally { loading = null; }
}

function notice(html) { const n = $('notice'); n.hidden = !html; if (html) n.innerHTML = html; }

// ---------- camera / video loop ----------
let stream = null, facing = 'user', raf = 0, mpTs = 0, lastVideoTime = -1, wakeLock = null;
function frameLoop() {
  raf = requestAnimationFrame(frameLoop);
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  mpTs = Math.max(mpTs + 1, Math.round(performance.now()));
  let res; try { res = landmarker.detectForVideo(video, mpTs); } catch (err) { console.error(err); return; }
  const lm = res.landmarks?.[0] || null;
  const t = source === 'video' ? video.currentTime * 1000 : performance.now();
  handleFrame(lm, t, video.videoWidth / video.videoHeight);
  drawPose(lm, video.videoWidth, video.videoHeight);
}

function setRunning(on) {
  $('cam-btn').hidden = on; $('stop-btn').hidden = !on; $('demo-btn').disabled = on; $('file-input').disabled = on;
  $('flip-btn').hidden = !(on && source === 'camera');
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { notice('<strong>Camera not available here.</strong> Open RepSight over HTTPS (or localhost) in Chrome, Safari or Edge. You can still analyze a recorded video or run a demo.'); return; }
  try {
    stopAll();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (err) {
    notice(`<strong>Camera blocked.</strong> ${err.name === 'NotAllowedError' ? 'Allow camera access for this page in your browser settings, then try again.' : 'No camera could be opened on this device.'} You can still analyze a recorded video or run a demo.`);
    return;
  }
  source = 'camera'; stage.classList.toggle('mirror', facing === 'user');
  video.srcObject = stream; video.loop = false; await video.play().catch(() => {});
  setRunning(true); ensureSession(); renderSession(); resetHud();
  hud.status.textContent = 'Step back until your whole body is in view, then start your set.';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  try { await getLandmarker(); } catch (err) { console.error(err); notice('<strong>The pose model did not load.</strong> Check your internet connection and reload. RepSight downloads the model from Google’s MediaPipe servers.'); stopAll(); return; }
  tracker = createTracker({ idleMs: db.settings.idle * 1000 }); lastVideoTime = -1; cancelAnimationFrame(raf); frameLoop();
}

async function startVideoFile(file) {
  stopAll();
  source = 'video'; stage.classList.remove('mirror');
  video.srcObject = null; video.src = URL.createObjectURL(file); video.loop = false; video.muted = true;
  setRunning(true); ensureSession(); renderSession(); resetHud();
  hud.status.textContent = `Analyzing ${file.name}…`;
  try { await getLandmarker(); } catch (err) { console.error(err); notice('<strong>The pose model did not load.</strong> Check your internet connection and reload.'); stopAll(); return; }
  tracker = createTracker({ idleMs: db.settings.idle * 1000 }); lastVideoTime = -1;
  video.onended = () => { flushTracker(); toast('Video analyzed'); stopAll(); };
  await video.play().catch(() => {}); cancelAnimationFrame(raf); frameLoop();
}

let demoTimer = 0;
function runDemo(ex) {
  stopAll();
  source = 'demo'; stage.classList.remove('mirror'); video.removeAttribute('src'); video.srcObject = null;
  const d = DEMOS[ex]; demoExercise = ex;
  const frames = ex === 'plank' ? animate({ ...d, reps: 8, noise: 1.5 }) : animate({ ...d, reps: ex === 'jack' ? 10 : 6, restMs: 0 });
  tracker = createTracker({ idleMs: 2500 }); ensureSession(); renderSession(); setRunning(true); resetHud();
  hud.status.textContent = `Demo: a simulated person doing ${many(EXERCISES[ex].name)}. Watch it get recognised and counted${DEMO_LOADS[ex] && scanEngine() !== 'off' ? ', and the weight get scanned' : ''}.`;
  const t0 = performance.now(); let i = 0; const last = frames.at(-1).t;
  const step = () => {
    const now = performance.now() - t0;
    while (i < frames.length - 1 && frames[i + 1].t <= now) i++;
    const lm = frames[Math.min(i, frames.length - 1)].lm;
    handleFrame(lm, now, 1); drawPose(lm, 1, 1);
    if (now > last + 3000) { flushTracker(); stopAll(); return; }
    demoTimer = requestAnimationFrame(step);
  };
  demoTimer = requestAnimationFrame(step);
}

function stopAll() {
  cancelAnimationFrame(raf); cancelAnimationFrame(demoTimer);
  if (source && source !== 'demo') flushTracker();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.onended = null; video.pause();
  if (video.src?.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.removeAttribute('src'); video.srcObject = null;
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  source = null; setRunning(false); drawPose(null, 1, 1);
  if (wscan) { wscan = null; wscanEx = null; showWeight(pendingWeight ? `Next set: ${weightText(pendingWeight)}` : null, 'pending'); }
}

$('cam-btn').onclick = startCamera;
$('stop-btn').onclick = () => { stopAll(); hud.status.textContent = 'Stopped. Unfinished sets were logged.'; };
$('flip-btn').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('file-input').onchange = e => { const f = e.target.files?.[0]; if (f) startVideoFile(f); e.target.value = ''; };
$('demo-btn').onclick = () => runDemo($('demo-select').value);

// "Scan weight": with the camera on, hold the label up to the middle of the frame;
// otherwise take or pick a photo. The result is used for the current or next set.
async function manualScan(frame, centre) {
  if (scanEngine() === 'off') { toast('Weight scanning is off. Turn it on in Settings.'); return; }
  const btn = $('scan-btn'); btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const r = await scanStill(frame, { engine: scanEngine(), apiKey: db.settings.apiKey, barKg: db.settings.barKg, defaultUnit: db.settings.unit, centre });
    if (!r) { toast(centre ? 'No weight read. Hold the number closer, square to the camera.' : 'No weight read in that photo. Try a closer shot of the number.'); return; }
    if (wscan) { wscan = null; wscanEx = null; }
    pendingWeight = r;
    showWeight(`${tracker.active ? '' : 'Next set: '}${weightText(r)}`, 'pending');
    toast(`Read ${r.label}. It will be used for ${tracker.active ? 'this' : 'your next'} set.`);
  } catch (err) { console.error(err); toast(scanErrorText(err)); }
  finally { btn.disabled = false; btn.textContent = 'Scan weight'; }
}
$('scan-btn').onclick = () => {
  if (source === 'camera' || source === 'video') { const f = grabFrame(lastLm); if (f) manualScan(f, true); return; }
  $('photo-input').click();
};
$('photo-input').onchange = async e => {
  const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    manualScan(c, false);
  } catch { toast('That file could not be opened as an image.'); }
};

// ---------- history ----------
const EXAMPLE = (() => {
  const d = Date.now() - 2 * 864e5;
  return [{ id: 'example', example: true, startedAt: d, endedAt: d + 31 * 60e3, sets: [
    ...[12, 10, 10].map(r => ({ exercise: 'squat', reps: r, weightKg: 60, source: 'camera' })),
    ...[15, 12].map(r => ({ exercise: 'pushup', reps: r, weightKg: null, source: 'camera' })),
    ...[10, 10, 8].map(r => ({ exercise: 'curl', reps: r, weightKg: 12, source: 'camera' })),
    { exercise: 'plank', seconds: 60, weightKg: null, source: 'camera' },
  ] }];
})();

function summarize(w) {
  const reps = w.sets.reduce((a, s) => a + (s.reps || 0), 0);
  const vol = w.sets.reduce((a, s) => a + (s.reps || 0) * (s.weightKg || 0), 0);
  return { reps, vol, dur: ((w.endedAt || Date.now()) - w.startedAt) / 1000 };
}
function setLine(ex, sets) {
  const e = EXERCISES[ex];
  if (e.kind === 'hold') return `${sets.length} × ${sets.map(s => fmtDur(s.seconds || 0)).join(', ')}`;
  const ws = sets.map(s => s.weightKg).filter(x => x != null);
  const w = ws.length ? ` @ ${toDisplay(Math.max(...ws))} ${db.settings.unit}` : '';
  return `${sets.length} × ${sets.map(s => s.reps ?? 0).join(', ')}${w}`;
}

function renderHistory() {
  const real = db.workouts, list = real.length ? real : EXAMPLE;
  const weekAgo = Date.now() - 7 * 864e5, week = list.filter(w => w.startedAt >= weekAgo);
  const vol = week.reduce((a, w) => a + summarize(w).vol, 0);
  $('stats').innerHTML = [
    [week.length, 'Workouts this week'], [week.reduce((a, w) => a + w.sets.length, 0), 'Sets this week'],
    [week.reduce((a, w) => a + summarize(w).reps, 0), 'Reps this week'], [Math.round(toDisplay(vol) || 0).toLocaleString(), `Volume (${db.settings.unit})`],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');

  // reps per day, last 14 days
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 13 + i); return { d, reps: 0 }; });
  for (const w of list) { const d = new Date(w.startedAt); d.setHours(0, 0, 0, 0); const slot = days.find(x => x.d.getTime() === d.getTime()); if (slot) slot.reps += summarize(w).reps; }
  const max = Math.max(10, ...days.map(d => d.reps)), nice = Math.ceil(max / 10) * 10;
  const W = 560, H = 170, L = 34, B = 22, T = 8, bw = (W - L) / 14;
  const y = v => T + (H - T - B) * (1 - v / nice);
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reps per day over the last 14 days">
    ${[0, nice / 2, nice].map(v => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${days.map((d, i) => `<rect x="${L + i * bw + bw * 0.18}" y="${y(d.reps)}" width="${bw * 0.64}" height="${Math.max(0, H - B - y(d.reps))}" rx="3" fill="${d.reps ? 'var(--accent)' : 'var(--surface-2)'}"><title>${d.d.toLocaleDateString()}: ${d.reps} reps</title></rect>
      ${i % 2 === 1 ? `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.d.toLocaleDateString([], { day: 'numeric', month: 'short' })}</text>` : ''}`).join('')}
  </svg>`;

  $('history-list').innerHTML = list.map(w => {
    const s = summarize(w), groups = {};
    for (const x of w.sets) (groups[x.exercise] ||= []).push(x);
    const date = new Date(w.startedAt);
    return `<article class="wk"><div class="wk-head"><h3>${date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}${w.example ? '<span class="badge">Example</span>' : ''}</h3>
      <span class="wk-sub">${fmtDur(s.dur)} · ${plural(w.sets.length, 'set')} · ${plural(s.reps, 'rep')}${s.vol ? ` · ${Math.round(toDisplay(s.vol)).toLocaleString()} ${db.settings.unit}` : ''}</span></div>
      <ul class="wk-lines">${Object.entries(groups).map(([ex, sets]) => `<li><b>${esc(EXERCISES[ex].name)}</b> — ${setLine(ex, sets)}</li>`).join('')}</ul>
      ${w.example ? '<p class="meta">This is a sample so you can see the layout. Your own workouts replace it once you finish one.</p>' : `<div><button class="link-btn" data-delw="${w.id}">Delete workout</button></div>`}</article>`;
  }).join('');
}
$('history-list').addEventListener('click', e => {
  const id = e.target.dataset?.delw; if (!id) return;
  if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = 'Tap again to delete'; return; }
  db.workouts = db.workouts.filter(w => w.id !== id); save(); renderHistory(); renderExercises(); toast('Workout deleted');
});

// ---------- exercises ----------
function renderExercises() {
  const all = db.workouts.flatMap(w => w.sets);
  $('ex-grid').innerHTML = Object.entries(EXERCISES).map(([k, e]) => {
    const sets = all.filter(s => s.exercise === k), hold = e.kind === 'hold';
    const best = sets.length ? Math.max(...sets.map(s => (hold ? s.seconds : s.reps) || 0)) : null;
    const total = sets.reduce((a, s) => a + ((hold ? s.seconds : s.reps) || 0), 0);
    return `<article class="ex-card"><span class="muscle">${esc(e.muscle)}</span><h3>${esc(e.name)}</h3><p>${esc(e.tip)}</p>
      <div class="pb"><div><b>${best == null ? '—' : hold ? fmtDur(best) : best}</b><span>Best set</span></div><div><b>${sets.length ? (hold ? fmtDur(total) : total) : '—'}</b><span>${hold ? 'Total time' : 'Total reps'}</span></div><div><b>${sets.length || '—'}</b><span>Sets</span></div></div></article>`;
  }).join('');
}

// ---------- settings ----------
$('settings-btn').onclick = () => { const s = $('settings'); s.hidden = !s.hidden; $('settings-btn').setAttribute('aria-expanded', String(!s.hidden)); };
$('set-unit').value = db.settings.unit; $('set-idle').value = String(db.settings.idle); $('set-sound').checked = db.settings.sound; $('set-model').value = db.settings.model;
$('set-unit').onchange = e => { db.settings.unit = e.target.value; save(); renderSession(); renderHistory(); };
$('set-idle').onchange = e => { db.settings.idle = +e.target.value; save(); };
$('set-sound').onchange = e => { db.settings.sound = e.target.checked; save(); };
function syncScanSettings() { $('key-row').hidden = $('set-scan').value !== 'claude'; }
$('set-scan').value = db.settings.scan; $('set-key').value = db.settings.apiKey; $('set-bar').value = String(db.settings.barKg); syncScanSettings();
$('set-scan').onchange = e => { db.settings.scan = e.target.value; save(); syncScanSettings(); if (e.target.value === 'claude' && !db.settings.apiKey) $('set-key').focus(); };
$('set-key').onchange = e => { db.settings.apiKey = e.target.value.trim(); save(); toast(db.settings.apiKey ? 'API key saved on this device' : 'API key removed'); };
$('set-bar').onchange = e => { db.settings.barKg = +e.target.value; save(); };
$('set-model').onchange = e => { db.settings.model = e.target.value; save(); toast('Model changes on the next camera start'); };

// ---------- routing ----------
function route() {
  const tab = ['train', 'history', 'exercises'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'train';
  for (const v of ['train', 'history', 'exercises']) $('view-' + v).hidden = v !== tab;
  document.querySelectorAll('.tabs a').forEach(a => (a.dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (tab !== 'train' && source === 'demo') stopAll();
}
addEventListener('hashchange', route);
addEventListener('pagehide', () => { if (source && source !== 'demo') stopAll(); });

if (!window.isSecureContext) notice('<strong>Live camera needs HTTPS.</strong> Open this page from an https:// address or localhost to use the camera. Demos and video analysis still work.');
route(); renderSession(); renderHistory(); renderExercises(); resetHud();
// show the skeleton overlay idle state with a resting demo figure so the stage is never blank
drawPose(DEMOS.squat.pose(DEMOS.squat.top), 1, 1);
