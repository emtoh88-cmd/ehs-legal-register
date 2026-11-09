// RepSight weight scanning: pure helpers (no DOM), shared by the app and tests.
// The app crops the video around the hands and bar ends (found from pose
// landmarks), reads them with OCR or Claude vision, and these helpers turn the
// raw readings into one weight for the set.

export const KG_PER_LB = 0.45359237;
export const toKg = (v, unit) => (unit === 'lb' ? v * KG_PER_LB : v);

// Exercises where a load is usually held. Body-weight moves are not scanned automatically.
export const LOADED = { curl: 'dumbbell', lunge: 'dumbbell', squat: 'barbell', press: 'barbell', deadlift: 'barbell' };
// Where a barbell sits when filmed side-on: across the back (squat) or in the hands.
const BAR_ON_BACK = new Set(['squat']);

const PLATES_KG = [0.5, 1, 1.25, 2, 2.5, 5, 7.5, 10, 15, 20, 25];
const PLATES_LB = [2.5, 5, 10, 25, 35, 45, 55];

function plausible(value, unit) {
  if (!(value > 0)) return false;
  if (unit === 'kg') return value <= 60 && Math.abs(value * 4 - Math.round(value * 4)) < 1e-6; // quarter-kg steps
  if (unit === 'lb') return value <= 150 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-6;
  // unit not printed / not read: only common catalogue weights, at lower score
  return Number.isInteger(value) ? value >= 2 && value <= 50 : [1.25, 2.5, 7.5, 12.5, 17.5, 22.5, 27.5].includes(value);
}

// Pull weight readings out of OCR text such as "12.5 KG", "45LBS", "2O kg".
export function parseWeightText(text) {
  if (!text) return [];
  let t = String(text).toUpperCase().replace(/,/g, '.');
  // common OCR confusions next to digits
  t = t.replace(/(?<=\d)[O]|[O](?=\d)/g, '0').replace(/(?<=\d)[IL](?=\d)/g, '1').replace(/(?<=\d)S(?=\d)/g, '5');
  t = t.replace(/K\s*6\b/g, 'KG').replace(/(\d)\s*1B(S?)\b/g, '$1LB$2'); // 'KG' read as 'K6', 'LB' as '1B'
  const out = [], seen = new Set();
  const re = /(?<![\d.])(\d{1,3}(?:\.\d{1,2})?)(?![\d.])\s*(KGS?|KILOS?|LBS?|POUNDS?)?/g;
  let m;
  while ((m = re.exec(t))) {
    let value = parseFloat(m[1]), score = 1;
    const u = m[2] ? (m[2].startsWith('K') ? 'kg' : 'lb') : null;
    // "25 LB" often comes back as "251LB": the gap before L is read as a 1
    if (!plausible(value, u) && u === 'lb' && /^\d{2,3}1$/.test(m[1])) { value = parseFloat(m[1].slice(0, -1)); score = 0.7; }
    if (!plausible(value, u)) continue;
    const key = `${value}${u}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ value, unit: u, score: u ? score : 0.4 });
  }
  return out;
}

// Combine readings from many frames. Each reading: {value, unit|null, score, role:'hand'|'plate'}.
// Returns the most-agreed weight per role once it has enough support, else null.
export function voteReadings(readings, { minScore = 1.8, defaultUnit = 'kg' } = {}) {
  const best = {};
  for (const role of ['hand', 'plate']) {
    const groups = new Map();
    for (const r of readings.filter(x => x.role === role)) {
      const unit = r.unit || defaultUnit, kg = toKg(r.value, unit);
      const key = Math.round(kg * 4) / 4;
      const g = groups.get(key) || { kg, value: r.value, unit, score: 0, votes: 0, unitSeen: false };
      g.score += r.score; g.votes++;
      if (r.unit && !g.unitSeen) { g.unitSeen = true; g.value = r.value; g.unit = r.unit; g.kg = kg; }
      groups.set(key, g);
    }
    const top = [...groups.values()].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= minScore) best[role] = top;
  }
  return best;
}

// Final weight for a set, from voted readings.
//   dumbbell / kettlebell: weight of one implement (how lifters log it)
//   barbell: bar + plates on both sides
export function resolveWeight(voted, exercise, barKg = 20) {
  const prefer = LOADED[exercise] === 'barbell' ? ['plate', 'hand'] : ['hand', 'plate'];
  for (const role of prefer) {
    const v = voted[role]; if (!v) continue;
    if (role === 'hand') return { weightKg: v.kg, implement: 'dumbbell', label: `${fmt(v.value)} ${v.unit} dumbbell`, unit: v.unit };
    return { weightKg: barKg + 2 * v.kg, implement: 'barbell', plateKg: v.kg, label: `${fmt(v.value)} ${v.unit} plates + bar`, unit: v.unit };
  }
  return null;
}
const fmt = n => String(+n.toFixed(2));

// Where to look in a frame (pixel boxes in a W x H image), from pose landmarks.
// Hands: a box around each wrist, pushed a little past it along the forearm.
// Plates: bar ends beyond the wrists when facing the camera; at the shoulders when side-on (bar on the back).
export function scanRegions(lm, exercise, W, H) {
  if (!lm || lm.length < 29) return [];
  const P = i => (lm[i] && (lm[i].visibility ?? 1) >= 0.5 ? { x: lm[i].x * W, y: lm[i].y * H } : null);
  const boxes = [];
  const box = (cx, cy, size, role, side) => {
    const s = Math.max(48, size), x = Math.max(0, cx - s / 2), y = Math.max(0, cy - s / 2);
    const w = Math.min(W - x, s), h = Math.min(H - y, s);
    if (w > 24 && h > 24) boxes.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), role, side });
  };
  const arms = [[13, 15, 'L'], [14, 16, 'R']];
  let fore = 0, n = 0;
  for (const [e, w, side] of arms) {
    const E = P(e), Wr = P(w); if (!E || !Wr) continue;
    const len = Math.hypot(Wr.x - E.x, Wr.y - E.y); fore += len; n++;
    box(Wr.x + (Wr.x - E.x) * 0.15, Wr.y + (Wr.y - E.y) * 0.15, len * 2, 'hand', side); // fist sits just past the wrist; leave room for the whole label
  }
  fore = n ? fore / n : Math.min(W, H) * 0.12;
  if (LOADED[exercise] === 'barbell') {
    const lw = P(15), rw = P(16), ls = P(11), rs = P(12);
    const shW = ls && rs ? Math.abs(ls.x - rs.x) : 0;
    if (lw && rw && shW > fore * 0.5) {
      const dx = rw.x - lw.x, dy = rw.y - lw.y;
      box(rw.x + dx * 0.45, rw.y + dy * 0.45, fore * 1.8, 'plate', 'R');
      box(lw.x - dx * 0.45, lw.y - dy * 0.45, fore * 1.8, 'plate', 'L');
    } else if (BAR_ON_BACK.has(exercise) && (ls || rs)) {
      const s = ls || rs; box(s.x, s.y - fore * 0.15, fore * 2.2, 'plate', 'side');
    } else if (lw || rw) {
      const w = lw || rw; box(w.x, w.y, fore * 2.4, 'plate', 'side'); // plate face centred on the hands
    }
  }
  return dedupe(boxes);
}
function dedupe(boxes) {
  // side-on views put both wrists in the same place; keep one box
  return boxes.filter((b, i) => !boxes.slice(0, i).some(o => o.role === b.role && Math.abs(o.x - b.x) < b.w * 0.3 && Math.abs(o.y - b.y) < b.h * 0.3));
}

// Turn a Claude vision answer (see app's schema) into the same shape as resolveWeight.
export function fromVisionAnswer(a, barKg = 20) {
  if (!a || a.implement === 'none' || a.implement === 'unclear' || a.confidence === 'low') return null;
  const unit = a.unit === 'lb' ? 'lb' : 'kg';
  if (a.implement === 'barbell' || a.implement === 'ez_bar') {
    const plates = (a.plates_per_side || []).filter(p => p > 0);
    if (a.total_weight > 0) return { weightKg: toKg(a.total_weight, unit), implement: 'barbell', label: `${fmt(a.total_weight)} ${unit} total`, unit };
    if (plates.length) {
      const side = plates.reduce((s, p) => s + p, 0);
      const bar = a.bar_weight > 0 ? toKg(a.bar_weight, unit) : barKg;
      return { weightKg: bar + 2 * toKg(side, unit), implement: 'barbell', label: `${plates.map(fmt).join('+')} ${unit} per side + bar`, unit };
    }
    return null;
  }
  if (a.weight_per_item > 0) return { weightKg: toKg(a.weight_per_item, unit), implement: a.implement, label: `${fmt(a.weight_per_item)} ${unit} ${a.implement}`, unit };
  if (a.total_weight > 0) return { weightKg: toKg(a.total_weight, unit), implement: a.implement, label: `${fmt(a.total_weight)} ${unit}`, unit };
  return null;
}
