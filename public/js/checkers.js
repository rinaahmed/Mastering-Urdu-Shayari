// Deterministic checkers. Anything a checker can grade is NEVER sent to the
// API. Pluggable registry so the ShayriWorkshop behr engine can be wired in
// as the scansion checker (see registerChecker('behr-engine', ...)).

// A checker: (item, userResponse) -> {
//   correct: boolean,
//   detail: string,          // human-readable, e.g. position-by-position diff
//   diff?: Array<{pos, expected, got, ok}>
// }

const registry = new Map();

export function registerChecker(id, fn) {
  registry.set(id, fn);
}

export function getChecker(id) {
  return registry.get(id) || null;
}

export function hasChecker(id) {
  return registry.has(id);
}

// ---- helpers ----

function normalizePattern(s) {
  // "122 122" and "1 2 2 1 2 2" and "122|122" all normalize to digit array + grouping string
  const digits = (s || '').replace(/[^12]/g, '');
  return digits.split('');
}

function normalizeWord(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics: ī -> i, ā -> a
    .replace(/[^a-z]/g, '');
}

// ---- built-in checkers ----

// Position-by-position pattern diff (behr reps, syllable weights).
registerChecker('pattern-diff', (item, response) => {
  const expected = normalizePattern(item.answer);
  const got = normalizePattern(response);
  const len = Math.max(expected.length, got.length);
  const diff = [];
  let ok = true;
  for (let i = 0; i < len; i++) {
    const match = expected[i] === got[i];
    if (!match) ok = false;
    diff.push({ pos: i + 1, expected: expected[i] ?? '·', got: got[i] ?? '·', ok: match });
  }
  const misses = diff.filter(d => !d.ok);
  const detail = ok
    ? 'Pattern matches position for position.'
    : `Mismatch at position${misses.length > 1 ? 's' : ''} ${misses.map(d => d.pos).join(', ')} — expected ${misses.map(d => d.expected).join(',')}, got ${misses.map(d => d.got).join(',')}.`;
  return { correct: ok, detail, diff };
});

// Matra totals: numeric comparison.
registerChecker('matra-total', (item, response) => {
  const expected = parseInt(String(item.answer).trim(), 10);
  const got = parseInt(String(response).trim(), 10);
  if (Number.isNaN(got)) return { correct: false, detail: 'Answer must be a number (total matras).' };
  const correct = expected === got;
  return {
    correct,
    detail: correct ? `Correct: ${expected} matras.` : `Off by ${got - expected}: the total is ${expected}, you said ${got}.`
  };
});

// Exact word match, diacritic-insensitive, with accepted alternates.
registerChecker('exact-word', (item, response) => {
  const got = normalizeWord(response);
  const accepted = [item.answer, ...(item.acceptedAnswers || [])].map(normalizeWord);
  const correct = accepted.includes(got);
  return {
    correct,
    detail: correct ? 'Correct.' : `Expected "${item.answer}", got "${response}".`
  };
});

// Scansion checker slot. Default implementation grades the user's typed taqti
// pattern against the item's answer pattern (a pattern diff). Wire in the
// ShayriWorkshop behr engine here to scan the raw Urdu text itself:
//
//   import { scanLine } from './shayri-workshop-behr.js';
//   registerChecker('behr-engine', (item, response) => {
//     const scan = scanLine(response.text ?? response, item.targetBehr);
//     return { correct: scan.fits, detail: scan.explanation, diff: scan.diff };
//   });
registerChecker('behr-engine', (item, response) => {
  return getChecker('pattern-diff')(item, response);
});

// Run the right checker for a drill type. Throws if a deterministic drill has
// no checker — that is a plan/config error, not a reason to call the API.
export function runChecker(drillType, item, response) {
  const checker = getChecker(drillType.checkerId);
  if (!checker) {
    throw new Error(`No checker registered for "${drillType.checkerId}" (drill ${drillType.id}). Deterministic drills are never graded by the API.`);
  }
  return checker(item, response);
}
