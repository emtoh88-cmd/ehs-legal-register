import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../detect.js';
import { animate, DEMOS, sidePose, frontPose, rng } from '../synth.js';

function run(frames, opts) {
  const tr = createTracker(opts); const events = [];
  for (const f of frames) events.push(...tr.update(f.lm, f.t));
  events.push(...tr.flush(frames.at(-1).t));
  return events.filter(e => e.type === 'set-end').map(e => e.set);
}
const demo = (ex, reps, extra = {}) => animate({ ...DEMOS[ex], reps, restMs: 1000, ...extra });

for (const [ex, reps] of [['squat', 10], ['pushup', 12], ['curl', 8], ['press', 6], ['jack', 15], ['lunge', 8], ['deadlift', 6], ['pullup', 6]]) {
  test(`${ex}: recognises the exercise and counts ${reps} reps`, () => {
    const sets = run(demo(ex, reps));
    assert.equal(sets.length, 1, JSON.stringify(sets));
    assert.equal(sets[0].exercise, ex);
    assert.equal(sets[0].reps, reps);
  });
}

test('alternating curls count each arm', () => {
  const r = rng(3); const frames = [];
  for (let t = 0; t < 8 * 1800; t += 33) {
    const k = (1 - Math.cos((2 * Math.PI * t) / 1800)) / 2; const k2 = (1 - Math.cos((2 * Math.PI * (t + 900)) / 1800)) / 2;
    const lm = sidePose({ arm: 10, elbow: 170 - 132 * k });
    const other = sidePose({ arm: 10, elbow: 170 - 132 * k2 + (r() - 0.5) * 3 });
    lm[14] = other[14]; lm[16] = other[16]; // right arm half a cycle out of phase
    frames.push({ t, lm });
  }
  const sets = run(frames);
  assert.equal(sets.length, 1); assert.equal(sets[0].exercise, 'curl');
  assert.ok(sets[0].reps >= 15 && sets[0].reps <= 16, `got ${sets[0].reps}`);
});

test('plank is timed as a hold', () => {
  const sets = run(animate({ ...DEMOS.plank, reps: 20, periodMs: 1000, noise: 1.5 }));
  assert.equal(sets.length, 1); assert.equal(sets[0].exercise, 'plank');
  assert.ok(Math.abs(sets[0].seconds - 20) <= 1, `got ${sets[0].seconds}s`);
});

test('two exercises back to back become two sets', () => {
  const a = demo('squat', 6, { restMs: 7000 });
  const b = demo('jack', 10, { t0: a.at(-1).t + 33 });
  const sets = run([...a, ...b]);
  assert.deepEqual(sets.map(s => [s.exercise, s.reps]), [['squat', 6], ['jack', 10]]);
  assert.equal(sets[0].reason, 'idle');
});

test('standing still, idle arm movement and a single dip record nothing', () => {
  const r = rng(11); const frames = [];
  for (let t = 0; t < 20000; t += 33) frames.push({ t, lm: frontPose({ abd: 10 + r() * 25, elbow: 150 + r() * 30, legs: 2 + r() * 3 }) });
  frames.push(...demo('squat', 1, { t0: 20033 }));
  assert.deepEqual(run(frames), []);
});

test('half reps do not count', () => {
  const sets = run(animate({ ...DEMOS.squat, bottom: { ...DEMOS.squat.bottom, knee: 130, hip: 120 }, reps: 8 }));
  assert.deepEqual(sets, []);
});

test('missing landmarks are tolerated', () => {
  const tr = createTracker();
  assert.deepEqual(tr.update(null, 0), []);
  assert.deepEqual(tr.update(Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.1 })), 33), []);
});

test('no other exercise is even suspected during each demo', () => {
  for (const ex of Object.keys(DEMOS).filter(k => k !== 'plank')) {
    const tr = createTracker(); const seen = new Set();
    for (const f of demo(ex, 6)) for (const e of tr.update(f.lm, f.t)) if (e.exercise) seen.add(e.exercise);
    assert.deepEqual([...seen], [ex], `${ex} demo also looked like ${[...seen].filter(x => x !== ex)}`);
  }
});

test('pull-ups and presses are told apart by what moves', async () => {
  // same arm angles, but in a pull-up the shoulders travel and the hands stay on the bar
  const { frontPose } = await import('../synth.js');
  const fixedBody = animate({ pose: frontPose, top: DEMOS.pullup.top, bottom: { ...DEMOS.pullup.bottom, y: DEMOS.pullup.top.y }, reps: 6, restMs: 1000 });
  const sets = run(fixedBody);
  assert.ok(!sets.some(s => s.exercise === 'pullup'), JSON.stringify(sets));
});

test('slow reps stay in one set even with a short timeout', () => {
  // 4.5 s per deadlift rep, timeout set to 4 s: the pace-based limit keeps it one set
  const sets = run(animate({ ...DEMOS.deadlift, reps: 5, periodMs: 4500, restMs: 1000 }), { idleMs: 4000 });
  assert.deepEqual(sets.map(s => [s.exercise, s.reps]), [['deadlift', 5]]);
});
