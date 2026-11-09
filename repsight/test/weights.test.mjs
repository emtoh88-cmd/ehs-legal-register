import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeightText, voteReadings, resolveWeight, scanRegions, fromVisionAnswer, KG_PER_LB } from '../weights.js';
import { sidePose, frontPose } from '../synth.js';

const vals = t => parseWeightText(t).map(r => [r.value, r.unit]);

test('parses printed weights and common OCR slips', () => {
  assert.deepEqual(vals('12.5 KG'), [[12.5, 'kg']]);
  assert.deepEqual(vals('12,5kg'), [[12.5, 'kg']]);
  assert.deepEqual(vals('45LBS'), [[45, 'lb']]);
  assert.deepEqual(vals('451BS'), [[45, 'lb']]);
  assert.deepEqual(vals('251LB'), [[25, 'lb']]);
  assert.deepEqual(vals('2O KG'), [[20, 'kg']]);
  assert.deepEqual(vals('20 K6'), [[20, 'kg']]);
  assert.deepEqual(vals('IWF 20 kg'), [[20, 'kg']]);
  assert.deepEqual(vals('12'), [[12, null]]);
});

test('rejects noise and implausible numbers', () => {
  assert.deepEqual(vals(''), []);
  assert.deepEqual(vals('2026'), []);
  assert.deepEqual(vals('999 kg'), []);
  assert.deepEqual(vals('13.7 kg'), []);
  assert.deepEqual(vals('3.3'), []);
});

test('voting needs agreement across frames', () => {
  const r = (value, unit, role = 'hand') => ({ value, unit, score: unit ? 1 : 0.4, role });
  assert.deepEqual(voteReadings([r(12, 'kg')]), {});
  const v = voteReadings([r(12, 'kg'), r(12, null), r(12, 'kg'), r(8, 'kg')]);
  assert.equal(v.hand.kg, 12); assert.equal(v.hand.unit, 'kg');
  const lb = voteReadings([r(45, 'lb', 'plate'), r(45, 'lb', 'plate')]);
  assert.ok(Math.abs(lb.plate.kg - 45 * KG_PER_LB) < 1e-9);
});

test('dumbbells log per dumbbell, barbells log bar plus both sides', () => {
  const voted = { hand: { kg: 12, value: 12, unit: 'kg' }, plate: { kg: 20, value: 20, unit: 'kg' } };
  assert.equal(resolveWeight(voted, 'curl').weightKg, 12);
  assert.equal(resolveWeight(voted, 'squat', 20).weightKg, 60);
  assert.equal(resolveWeight({ hand: voted.hand }, 'squat').implement, 'dumbbell'); // goblet / dumbbell squat
  assert.equal(resolveWeight({}, 'curl'), null);
});

test('scan regions sit on the hands and bar ends', () => {
  const W = 640, H = 640;
  const curl = scanRegions(sidePose({ arm: 10, elbow: 170 }), 'curl', W, H);
  assert.equal(curl.length, 1); // side view: both wrists overlap
  assert.equal(curl[0].role, 'hand');
  const press = scanRegions(frontPose({ abd: 172, elbow: 176 }), 'press', W, H);
  assert.equal(press.filter(b => b.role === 'hand').length, 2);
  assert.equal(press.filter(b => b.role === 'plate').length, 2);
  const squat = scanRegions(sidePose({ tilt: 5 }), 'squat', W, H);
  assert.ok(squat.some(b => b.role === 'plate'));
  for (const b of [...curl, ...press, ...squat]) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H);
  const dl = scanRegions(sidePose({ tilt: 72, hip: 100, knee: 140 }), 'deadlift', W, H);
  const lw = { x: sidePose({ tilt: 72, hip: 100, knee: 140 })[15].x * W, y: sidePose({ tilt: 72, hip: 100, knee: 140 })[15].y * H };
  const plate = dl.find(b => b.role === 'plate');
  assert.ok(plate && lw.x > plate.x && lw.x < plate.x + plate.w && lw.y > plate.y && lw.y < plate.y + plate.h, 'deadlift plate box should cover the hands');
  assert.equal(resolveWeight({ plate: { kg: 20, value: 20, unit: 'kg' } }, 'deadlift', 20).weightKg, 60);
  assert.equal(resolveWeight({ hand: { kg: 10, value: 10, unit: 'kg' } }, 'lunge').implement, 'dumbbell');
  assert.deepEqual(scanRegions(null, 'curl', W, H), []);
});

test('Claude vision answers become set weights', () => {
  assert.equal(fromVisionAnswer({ implement: 'dumbbell', weight_per_item: 15, unit: 'kg', confidence: 'high' }).weightKg, 15);
  assert.equal(fromVisionAnswer({ implement: 'barbell', total_weight: 0, plates_per_side: [20, 5], bar_weight: 0, unit: 'kg', confidence: 'medium' }, 20).weightKg, 70);
  assert.ok(Math.abs(fromVisionAnswer({ implement: 'barbell', total_weight: 135, plates_per_side: [], unit: 'lb', confidence: 'high' }).weightKg - 135 * KG_PER_LB) < 1e-9);
  assert.equal(fromVisionAnswer({ implement: 'none', confidence: 'high' }), null);
  assert.equal(fromVisionAnswer({ implement: 'dumbbell', weight_per_item: 15, unit: 'kg', confidence: 'low' }), null);
});
