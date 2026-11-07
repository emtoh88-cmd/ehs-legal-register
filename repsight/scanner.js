// RepSight weight scanner (browser). Reads the weight on dumbbells, plates and
// bars from camera frames, with one of two readers:
//   'ocr'    on-device text recognition (Tesseract.js). Free and private; needs printed numbers.
//   'claude' Claude vision with the user's own Anthropic API key. Handles hex dumbbells,
//            colour-coded plates and plate counting, and sends one frame per set to Anthropic.
import { parseWeightText, voteReadings, resolveWeight, scanRegions, fromVisionAnswer, LOADED } from './weights.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const CLAUDE_MODEL = 'claude-opus-5-5';

// ---------- OCR ----------
let ocrWorker = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
}
async function getOcr() {
  ocrWorker ||= (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    const w = await window.Tesseract.createWorker('eng', 1);
    await w.setParameters({ tessedit_char_whitelist: '0123456789.,KGLBSkglbs ', tessedit_pageseg_mode: '11' });
    return w;
  })().catch(e => { ocrWorker = null; throw e; });
  return ocrWorker;
}

// Crop, upscale and greyscale, then make black-on-white versions for OCR.
// Label text is a small share of the crop, so the brightest (or darkest) few percent
// of pixels are taken as the text. That works for white numbers on black plates,
// black numbers on chrome or rubber, and coloured discs on any background.
// Remove connected shapes that cannot be characters: plate rims, bar edges, the
// lifter's arm, specks. Without this, OCR treats a ring around the number as a picture.
function keepCharacterShapes(m, W, H) {
  const seen = new Uint8Array(m.length), stack = [];
  for (let start = 0; start < m.length; start++) {
    if (!m[start] || seen[start]) continue;
    const pix = []; let x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop(); pix.push(p);
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (q >= 0 && m[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const fill = pix.length / (w * h);
    const isChar = h <= H * 0.45 && w <= W * 0.45 && pix.length >= 12 && h >= 6 && fill > 0.08;
    if (!isChar) for (const p of pix) m[p] = 0;
  }
}

export function prepCrop(src, b, target = 260) {
  const k = Math.max(1, target / Math.min(b.w, b.h));
  const W = Math.round(b.w * k), H = Math.round(b.h * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high'; x.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data, n = W * H, g = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) { const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0; g[j] = v; hist[v]++; }
  const pct = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * n) return v; } return 255; };
  const make = isText => {
    const m = new Uint8Array(n); for (let j = 0; j < n; j++) m[j] = isText(g[j]) ? 1 : 0;
    keepCharacterShapes(m, W, H);
    const o = document.createElement('canvas'); o.width = W; o.height = H;
    const ox = o.getContext('2d'), im = ox.createImageData(W, H), od = im.data;
    for (let j = 0, i = 0; j < n; j++, i += 4) { const v = m[j] ? 0 : 255; od[i] = od[i + 1] = od[i + 2] = v; od[i + 3] = 255; }
    ox.putImageData(im, 0, 0); return o;
  };
  const hi = pct(0.9), lo = pct(0.1);
  const variants = [];
  if (hi > lo + 20) variants.push(make(v => v > hi), make(v => v < lo));       // light text, dark text
  variants.push(make(v => v < (pct(0.5) + lo) / 2), make(v => v > (pct(0.5) + hi) / 2)); // wider fallbacks
  return variants;
}

async function ocrBoxes(frame, boxes) {
  const w = await getOcr(); const readings = [];
  for (const b of boxes) {
    for (const variant of prepCrop(frame, b)) { // stop at the first version that yields a weight
      const { data } = await w.recognize(variant);
      // judge word by word: edges of plates and bars produce low-confidence junk around a clean number
      const text = data.words?.length ? data.words.filter(x => x.confidence >= 20).map(x => x.text).join(' ') : data.confidence >= 45 ? data.text : '';
      const found = parseWeightText(text);
      for (const r of found) readings.push({ ...r, role: b.role, text: text.trim() });
      if (found.length) break;
    }
  }
  return readings;
}

// ---------- Claude vision ----------
const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['implement', 'unit', 'weight_per_item', 'total_weight', 'plates_per_side', 'bar_weight', 'confidence', 'evidence'],
  properties: {
    implement: { type: 'string', enum: ['dumbbell', 'kettlebell', 'barbell', 'ez_bar', 'machine', 'none', 'unclear'] },
    unit: { type: 'string', enum: ['kg', 'lb'] },
    weight_per_item: { type: 'number', description: 'Weight of one dumbbell or kettlebell. 0 if not applicable or unreadable.' },
    total_weight: { type: 'number', description: 'Total load if it can be read directly (e.g. a fixed barbell or machine stack). 0 if unknown.' },
    plates_per_side: { type: 'array', items: { type: 'number' }, description: 'Plate weights on ONE side of the bar, largest first. Empty if no plates.' },
    bar_weight: { type: 'number', description: 'Bar weight if printed or clearly standard; 0 if unknown.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'One short sentence: what you read or recognised.' },
  },
};

let claudeClient = null, claudeKey = null;
async function getClaude(apiKey) {
  if (claudeClient && claudeKey === apiKey) return claudeClient;
  const { default: Anthropic } = await import(ANTHROPIC_SDK_URL);
  // The key belongs to the person using this browser and stays on this device (sent only to Anthropic).
  claudeClient = new Anthropic({ apiKey, dangerouslyAllowBrowser: true }); claudeKey = apiKey;
  return claudeClient;
}

function frameToJpeg(frame, maxSide = 1024) {
  const k = Math.min(1, maxSide / Math.max(frame.width, frame.height));
  const c = document.createElement('canvas'); c.width = Math.round(frame.width * k); c.height = Math.round(frame.height * k);
  c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

export async function askClaude(apiKey, frame, exerciseName) {
  const client = await getClaude(apiKey);
  const response = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VISION_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frameToJpeg(frame) } },
        { type: 'text', text:
          `This is a frame from a gym workout camera${exerciseName ? `; the person is doing ${exerciseName}` : ''}. ` +
          'Identify the free weight they are holding or lifting and read its load. Use printed numbers when visible; ' +
          'otherwise use standard colour codes for competition plates (red 25 kg, blue 20, yellow 15, green 10, white 5) or obvious size cues. ' +
          'For a barbell, list the plates on one side. If nothing is held, answer implement "none". ' +
          'If you are guessing, set confidence to "low".' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.find(b => b.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- a scanning session for one set ----------
// Call tick(frame, landmarks) every few hundred ms while the set runs; it throttles itself.
export function createWeightScan({ exercise, engine, apiKey, barKg = 20, defaultUnit = 'kg', exerciseName, onResult, onError }) {
  const readings = []; let busy = false, done = false, attempts = 0, result = null;
  const maxAttempts = engine === 'claude' ? 2 : 12;
  return {
    get result() { return result; },
    get done() { return done; },
    async tick(frame, landmarks) {
      if (done || busy || !frame) return;
      if (attempts >= maxAttempts) { done = true; return; }
      busy = true; attempts++;
      try {
        if (engine === 'claude') {
          const a = await askClaude(apiKey, frame, exerciseName);
          const r = fromVisionAnswer(a, barKg);
          if (r) { result = { ...r, engine, evidence: a.evidence }; done = true; onResult?.(result); }
        } else {
          const boxes = landmarks ? scanRegions(landmarks, exercise, frame.width, frame.height) : [];
          if (!boxes.length) return;
          readings.push(...await ocrBoxes(frame, boxes));
          const r = resolveWeight(voteReadings(readings, { defaultUnit }), exercise, barKg);
          if (r) { result = { ...r, engine }; done = true; onResult?.(result); }
        }
      } catch (err) { done = true; onError?.(err); }
      finally { busy = false; }
    },
  };
}

// One-off scan of a still image or the middle of a frame ("hold the weight up to the camera").
export async function scanStill(frame, { engine, apiKey, barKg = 20, defaultUnit = 'kg', centre = false }) {
  if (engine === 'claude') {
    const a = await askClaude(apiKey, frame, null);
    const r = fromVisionAnswer(a, barKg);
    return r ? { ...r, engine, evidence: a.evidence } : null;
  }
  const W = frame.width, H = frame.height;
  const s = Math.min(W, H) * (centre ? 0.55 : 1);
  const boxes = centre ? [{ x: (W - s) / 2, y: (H - s) / 2, w: s, h: s, role: 'hand' }] : [{ x: 0, y: 0, w: W, h: H, role: 'hand' }];
  const readings = await ocrBoxes(frame, boxes);
  const v = voteReadings(readings.map(r => ({ ...r, score: r.score * 2 })), { minScore: 0.8, defaultUnit });
  if (!v.hand) return null;
  return { weightKg: v.hand.kg, implement: 'item', label: `${+v.hand.value.toFixed(2)} ${v.hand.unit}`, unit: v.hand.unit, engine };
}

export const isLoaded = ex => ex in LOADED;
