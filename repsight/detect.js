// RepSight exercise recognition.
// Pure logic: takes 33 MediaPipe pose landmarks per frame and turns them into
// exercise recognition, rep counts and finished sets. No DOM, no camera, so it
// runs the same in the browser and in Node tests.

export const EXERCISES = {
  squat:  { name: 'Squat',          kind: 'reps', muscle: 'Legs',
            tip: 'Side-on or 45°, whole body in frame. Counts when knees bend past ~110°.' },
  pushup: { name: 'Push-up',        kind: 'reps', muscle: 'Chest',
            tip: 'Camera at floor level, side-on. Counts when elbows bend past ~100°.' },
  curl:   { name: 'Bicep Curl',     kind: 'reps', muscle: 'Arms',
            tip: 'Side-on or facing, upper arms by your sides. Alternating curls count per arm.' },
  press:  { name: 'Overhead Press', kind: 'reps', muscle: 'Shoulders',
            tip: 'Facing the camera, start with hands at shoulders, lock out overhead.' },
  lunge:  { name: 'Lunge',          kind: 'reps', muscle: 'Legs',
            tip: 'Side-on, whole body in frame. Each leg counts; front knee past ~110°.' },
  deadlift: { name: 'Deadlift',     kind: 'reps', muscle: 'Back',
            tip: 'Side-on, bar and whole body in frame. Counts a hip hinge down and a full lockout.' },
  pullup: { name: 'Pull-up',        kind: 'reps', muscle: 'Back',
            tip: 'Facing or behind you, bar and hands in frame. Counts from straight arms to elbows past ~80°.' },
  jack:   { name: 'Jumping Jack',   kind: 'reps', muscle: 'Cardio',
            tip: 'Facing the camera, full body in frame. Hands overhead and feet wide counts one.' },
  plank:  { name: 'Plank',          kind: 'hold', muscle: 'Core',
            tip: 'Side-on at floor level. Timer starts after 2 s of a straight, still body.' },
};

// MediaPipe Pose landmark indices
const I = { nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
            lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28 };
const MIN_VIS = 0.5;

const deg = r => (r * 180) / Math.PI;

function angle(a, b, c) {
  // angle at b formed by a-b-c, in degrees (0..180)
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!d) return null;
  return deg(Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))));
}

function fromDown(a, b) {
  // angle of vector a->b measured from straight down (0) to straight up (180)
  const x = b.x - a.x, y = b.y - a.y, l = Math.hypot(x, y);
  return l ? deg(Math.acos(Math.max(-1, Math.min(1, y / l)))) : null;
}

const mean = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

export function computeFeatures(lm, aspect = 1) {
  if (!lm || lm.length < 29) return null;
  const p = i => (lm[i] && (lm[i].visibility ?? 1) >= MIN_VIS ? { x: lm[i].x * aspect, y: lm[i].y } : null);
  const P = {}; for (const k in I) P[k] = p(I[k]);
  const ok = (...ks) => ks.every(k => P[k]);
  const mid = (a, b) => (P[a] && P[b] ? { x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 } : P[a] || P[b]);

  const sh = mid('ls', 'rs'), hp = mid('lh', 'rh');
  if (!sh || !hp) return { visible: false };

  const tx = sh.x - hp.x, ty = sh.y - hp.y, tl = Math.hypot(tx, ty);
  const tilt = tl ? deg(Math.acos(Math.max(-1, Math.min(1, -ty / tl)))) : null; // 0 upright, 90 horizontal

  const elbowL = ok('ls', 'le', 'lw') ? angle(P.ls, P.le, P.lw) : null;
  const elbowR = ok('rs', 're', 'rw') ? angle(P.rs, P.re, P.rw) : null;
  const kneeL = ok('lh', 'lk', 'la') ? angle(P.lh, P.lk, P.la) : null;
  const kneeR = ok('rh', 'rk', 'ra') ? angle(P.rh, P.rk, P.ra) : null;
  const hipL = ok('ls', 'lh', 'lk') ? angle(P.ls, P.lh, P.lk) : null;
  const hipR = ok('rs', 'rh', 'rk') ? angle(P.rs, P.rh, P.rk) : null;
  const armL = ok('ls', 'le') ? fromDown(P.ls, P.le) : null;
  const armR = ok('rs', 're') ? fromDown(P.rs, P.re) : null;

  const wristUpL = ok('lw', 'le') ? P.lw.y < P.le.y : null;
  const wristUpR = ok('rw', 're') ? P.rw.y < P.re.y : null;
  const headY = P.nose ? P.nose.y : sh.y - tl * 0.35;
  const wrists = [P.lw, P.rw].filter(Boolean);
  const wristsOverhead = wrists.length === 2 && wrists.every(w => w.y < headY);
  const wristsLow = wrists.length === 2 && wrists.every(w => w.y > sh.y);

  const shW = ok('ls', 'rs') ? Math.abs(P.ls.x - P.rs.x) : 0;
  const spread = ok('la', 'ra') && shW > tl * 0.25 ? Math.abs(P.la.x - P.ra.x) / shW : null;

  // side-on vs facing, from how far apart the hips look; split stance for lunges
  const hipSep = ok('lh', 'rh') ? Math.abs(P.lh.x - P.rh.x) : 0;
  const sideOn = hipSep < tl * 0.35;
  const thigh = mean([ok('lh', 'lk') ? Math.hypot(P.lh.x - P.lk.x, P.lh.y - P.lk.y) : null, ok('rh', 'rk') ? Math.hypot(P.rh.x - P.rk.x, P.rh.y - P.rk.y) : null]);
  const stance = ok('la', 'ra') && thigh ? Math.abs(P.la.x - P.ra.x) / thigh : null;
  // heights in torso lengths, so travel can be compared across camera distances
  const shY = sh.y / tl, wrY = wrists.length ? mean(wrists.map(w => w.y)) / tl : null;
  const wristsAboveShoulders = wrists.length === 2 && wrists.every(w => w.y < sh.y);

  return {
    visible: true, tilt, torso: tl, sideOn, stance, shY, wrY, wristsAboveShoulders,
    kneeMin: kneeL == null ? kneeR : kneeR == null ? kneeL : Math.min(kneeL, kneeR),
    elbowL, elbowR, elbow: mean([elbowL, elbowR]),
    kneeL, kneeR, knee: mean([kneeL, kneeR]),
    hip: mean([hipL, hipR]), armL, armR,
    wristUpL, wristUpR, wristsOverhead, wristsLow, spread,
  };
}

// Hysteresis rep counter: a rep is top -> bottom -> top, with the exercise's
// context (body position) holding for most of the rep.
class RepCounter {
  constructor({ signal, isTop, isBottom, context, minMs = 350, maxMs = 10000, minCtx = 0.7, track = null, accept = null }) {
    Object.assign(this, { signal, isTop, isBottom, context, minMs, maxMs, minCtx, track, accept });
    this.ranges = {};
    this.state = null; this.reps = 0; this.repStart = 0; this.ctxYes = 0; this.ctxAll = 0; this.value = null;
  }
  update(f, t) {
    const v = this.signal(f); this.value = v;
    if (v == null) return false;
    const ctx = !!this.context(f);
    if (this.state === 'down' || this.state === 'leaving') { this.ctxAll++; if (ctx) this.ctxYes++; this.observe(f); }
    if (this.isTop(v, f)) {
      if (this.state === 'down') {
        const dur = t - this.repStart, ratio = this.ctxAll ? this.ctxYes / this.ctxAll : 0;
        this.state = 'up';
        const travel = Object.fromEntries(Object.entries(this.ranges).map(([k, r]) => [k, r[1] - r[0]]));
        if (dur >= this.minMs && dur <= this.maxMs && ratio >= this.minCtx && (!this.accept || this.accept(travel))) { this.reps++; return true; }
        return false;
      }
      this.state = 'up';
    } else if (this.state === 'up') {
      this.state = 'leaving'; this.repStart = t; this.ctxYes = ctx ? 1 : 0; this.ctxAll = 1; this.ranges = {}; this.observe(f);
    }
    if (this.state === 'leaving' && this.isBottom(v, f)) this.state = 'down';
    // starting a set in the bottom position (e.g. press from the rack) still counts the first rep
    if (this.state === null && this.isBottom(v, f)) { this.state = 'down'; this.repStart = t; this.ctxYes = ctx ? 1 : 0; this.ctxAll = 1; this.ranges = {}; this.observe(f); }
    return false;
  }
  // min/max of tracked values over the current rep (e.g. how far the shoulders moved)
  observe(f) {
    if (!this.track) return;
    for (const [k, v] of Object.entries(this.track(f))) {
      if (v == null) continue;
      const r = this.ranges[k]; if (!r) this.ranges[k] = [v, v]; else { if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v; }
    }
  }
  get phase() { return this.state === 'down' ? 'bottom' : this.state === 'up' ? 'top' : this.state === 'leaving' ? 'moving' : 'waiting'; }
}

const splitStance = f => f.sideOn && f.stance != null && f.stance > 1.2;
const travelTrack = f => ({ sh: f.shY, wr: f.wrY });

function makeDetectors() {
  const upright = f => f.tilt != null && f.tilt < 35;
  const curlArm = side => new RepCounter({
    signal: f => f['elbow' + side],
    isTop: v => v > 135, isBottom: v => v < 65,
    context: f => upright(f) && f['arm' + side] != null && f['arm' + side] < 45,
  });
  return {
    squat: new RepCounter({
      signal: f => f.knee, isTop: v => v > 155, isBottom: v => v < 110,
      context: f => f.tilt != null && f.tilt < 60 && !splitStance(f),
    }),
    lunge: new RepCounter({
      signal: f => f.kneeMin, isTop: v => v > 150, isBottom: v => v < 110,
      context: f => f.tilt != null && f.tilt < 45 && splitStance(f), minCtx: 0.6,
    }),
    deadlift: new RepCounter({
      signal: f => f.hip, isTop: v => v > 160, isBottom: v => v < 115,
      // hinge: knees stay fairly straight (unlike a squat), arms hang straight, shoulders stay above hips
      context: f => f.tilt != null && f.tilt < 85 && (f.knee == null || f.knee > 115) && (f.elbow == null || f.elbow > 140),
    }),
    pullup: new RepCounter({
      signal: f => f.elbow, isTop: v => v > 150, isBottom: v => v < 80,
      context: f => f.tilt != null && f.tilt < 35 && f.wristsAboveShoulders,
      track: travelTrack, accept: t => (t.sh ?? 0) > (t.wr ?? 0) + 0.1, // the body rises to the hands
    }),
    pushup: new RepCounter({
      signal: f => f.elbow, isTop: v => v > 145, isBottom: v => v < 100,
      context: f => f.tilt != null && f.tilt > 55 && (f.knee == null || f.knee > 130),
    }),
    curlL: curlArm('L'),
    curlR: curlArm('R'),
    press: new RepCounter({
      signal: f => f.elbow,
      isTop: (v, f) => v > 150 && Math.max(f.armL ?? 0, f.armR ?? 0) > 130,
      isBottom: v => v < 105,
      context: f => upright(f) && (f.wristUpL ?? true) && (f.wristUpR ?? true) && (f.wristUpL != null || f.wristUpR != null),
      track: travelTrack, accept: t => (t.wr ?? 0) > (t.sh ?? 0), // the hands rise from the shoulders
    }),
    jack: new RepCounter({
      signal: f => (f.spread == null ? null : f.wristsOverhead && f.spread > 1.3 ? 1 : f.wristsLow && f.spread < 1.15 ? -1 : 0),
      isTop: v => v === -1, isBottom: v => v === 1,
      context: upright, minMs: 250,
    }),
  };
}

// Plank: a held position rather than reps.
class HoldDetector {
  constructor({ startMs = 2000, graceMs = 1200 } = {}) {
    Object.assign(this, { startMs, graceMs });
    this.since = null; this.lastOk = null; this.active = false; this.elbows = [];
  }
  update(f, t) {
    this.elbows.push([t, f.elbow]); while (this.elbows.length && t - this.elbows[0][0] > 1500) this.elbows.shift();
    const es = this.elbows.map(e => e[1]).filter(e => e != null);
    const still = es.length > 3 && Math.max(...es) - Math.min(...es) < 18;
    const ok = f.tilt != null && f.tilt > 60 && f.hip != null && f.hip > 150 && (f.knee == null || f.knee > 150) && still;
    if (ok) { this.lastOk = t; if (this.since == null) this.since = t; }
    if (!this.active && ok && t - this.since >= this.startMs) { this.active = true; return { type: 'start', at: this.since }; }
    if (!ok && this.since != null && t - this.lastOk > this.graceMs) {
      const wasActive = this.active, start = this.since, end = this.lastOk;
      this.since = null; this.active = false;
      if (wasActive) return { type: 'end', at: start, end };
    }
    return null;
  }
}

// The tracker turns per-frame features into events the UI records:
//   {type:'candidate', exercise}       saw one rep, not sure yet
//   {type:'set-start', exercise, reps} recognised an exercise
//   {type:'rep', exercise, reps}       another rep in the active set
//   {type:'hold', exercise, seconds}   plank timer tick
//   {type:'set-end', set}              set finished (idle, switched, or stopped)
export function createTracker({ idleMs = 6000, confirmReps = 2, switchReps = 3, windowMs = 12000 } = {}) {
  let det = makeDetectors(), hold = new HoldDetector();
  let active = null; const cand = {}; let lastCurl = { L: -1e9, R: -1e9 };
  let lastFeatures = null, lastT = 0, smooth = null;

  const SMOOTH_KEYS = ['tilt', 'elbowL', 'elbowR', 'elbow', 'kneeL', 'kneeR', 'knee', 'hip', 'armL', 'armR'];

  function endSet(t, events, reason) {
    if (!active) return;
    const set = { exercise: active.exercise, startedAt: active.startedAt, reason };
    if (active.kind === 'hold') set.seconds = Math.round(((active.end ?? t) - active.startedAt) / 1000);
    else { set.reps = active.reps; set.seconds = Math.max(1, Math.round((active.lastRepAt - active.startedAt) / 1000)); }
    if (set.reps > 0 || set.seconds >= 3) events.push({ type: 'set-end', set });
    active = null;
  }

  function onRep(ex, t, events) {
    if (active && active.exercise === ex) {
      active.gaps.push(t - active.lastRepAt); active.reps++; active.lastRepAt = t;
      events.push({ type: 'rep', exercise: ex, reps: active.reps });
      return;
    }
    const c = (cand[ex] = (cand[ex] || []).filter(x => t - x < windowMs)); c.push(t);
    const need = active ? switchReps : confirmReps;
    if (c.length >= need) {
      endSet(t, events, 'switched');
      active = { exercise: ex, kind: 'reps', reps: c.length, startedAt: c[0], lastRepAt: t, gaps: c.slice(1).map((x, i) => x - c[i]) };
      for (const k in cand) cand[k] = [];
      events.push({ type: 'set-start', exercise: ex, reps: active.reps });
      events.push({ type: 'rep', exercise: ex, reps: active.reps });
    } else if (!active) events.push({ type: 'candidate', exercise: ex });
  }

  function update(landmarks, t, aspect = 1) {
    const events = [];
    const raw = computeFeatures(landmarks, aspect);
    lastT = t;
    if (!raw || !raw.visible) { lastFeatures = raw; tick(t, events); return events; }
    // light smoothing to suppress landmark jitter
    if (!smooth) smooth = { ...raw };
    for (const k of SMOOTH_KEYS) smooth[k] = raw[k] == null ? null : smooth[k] == null ? raw[k] : smooth[k] * 0.4 + raw[k] * 0.6;
    const f = { ...raw, ...Object.fromEntries(SMOOTH_KEYS.map(k => [k, smooth[k]])) };
    lastFeatures = f;

    if (det.squat.update(f, t)) onRep('squat', t, events);
    if (det.lunge.update(f, t)) onRep('lunge', t, events);
    if (det.deadlift.update(f, t)) onRep('deadlift', t, events);
    if (det.pullup.update(f, t)) onRep('pullup', t, events);
    if (det.pushup.update(f, t)) onRep('pushup', t, events);
    if (det.press.update(f, t)) onRep('press', t, events);
    if (det.jack.update(f, t)) onRep('jack', t, events);
    for (const s of ['L', 'R']) {
      if (det['curl' + s].update(f, t)) {
        const other = s === 'L' ? 'R' : 'L';
        // both arms finishing together is one rep, alternating arms count separately
        if (t - lastCurl[other] > 700) onRep('curl', t, events);
        lastCurl[s] = t;
      }
    }

    const h = hold.update(f, t);
    if (h && h.type === 'start') {
      endSet(t, events, 'switched');
      active = { exercise: 'plank', kind: 'hold', startedAt: h.at };
      events.push({ type: 'set-start', exercise: 'plank' });
    } else if (h && h.type === 'end' && active && active.exercise === 'plank') {
      active.end = h.end; endSet(t, events, 'idle');
    }
    if (active && active.kind === 'hold') events.push({ type: 'hold', exercise: 'plank', seconds: Math.floor((t - active.startedAt) / 1000) });

    tick(t, events);
    return events;
  }

  // slow lifts (deadlifts, paused reps) get more time: 2.5x the lifter's own pace, at least idleMs
  function idleLimit(a) {
    const g = a.gaps.length ? a.gaps.reduce((x, y) => x + y, 0) / a.gaps.length : 0;
    return Math.max(idleMs, 2.5 * g);
  }

  function tick(t, events) {
    if (active && active.kind === 'reps' && t - active.lastRepAt > idleLimit(active)) endSet(t, events, 'idle');
  }

  return {
    update,
    flush(t = lastT) { const e = []; if (active && active.kind === 'hold') active.end = t; endSet(t, e, 'stopped'); return e; },
    reset() { det = makeDetectors(); hold = new HoldDetector(); active = null; for (const k in cand) delete cand[k]; smooth = null; },
    get active() { return active ? { ...active } : null; },
    get features() { return lastFeatures; },
    phase(ex) { const d = ex === 'curl' ? det.curlL : det[ex]; return d ? d.phase : null; },
  };
}
