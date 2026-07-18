// Checker engine. Checkers are PLAN-DECLARED plugins; the app implements only
// generic strategies and knows nothing about any domain. Anything a checker
// can grade never touches the API. 'external' POSTs to a plan-supplied URL
// (how a domain engine gets wired in with no code changes); when it is
// unreachable the declared fallback runs and the result is marked provisional.
// 'judgment' is routed to the evaluator API by the session runtime, not here.

// runCheck(plan, drillType, item, userResponse)
//   -> Promise<{ correct, detail, diff?, provisional?, fallbackUsed? }>

function norm(s, keepPattern) {
  let out = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (keepPattern) {
    out = (out.match(new RegExp(`[${keepPattern}]`, 'g')) || []).join('');
  } else {
    out = out.replace(/[^\p{L}\p{N}]/gu, '');
  }
  return out;
}

function candidates(item) {
  return [item.answer, ...(item.acceptedAnswers || [])];
}

const strategies = {
  // Verbatim string equality (trimmed). config: { caseSensitive }
  exact(config, item, response) {
    const cs = !!config.caseSensitive;
    const got = cs ? response.trim() : response.trim().toLowerCase();
    const ok = candidates(item).some((a) => (cs ? a.trim() : a.trim().toLowerCase()) === got);
    return {
      correct: ok,
      detail: ok ? 'Correct.' : `Expected "${item.answer}", got "${response}".`
    };
  },

  // Diacritic-, punctuation- and case-insensitive equality.
  // config: { keepPattern } — regex character class of what survives.
  'normalized-exact'(config, item, response) {
    const got = norm(response, config.keepPattern);
    const ok = candidates(item).some((a) => norm(a, config.keepPattern) === got);
    return {
      correct: ok,
      detail: ok ? 'Correct.' : `Expected "${item.answer}", got "${response}".`
    };
  },

  // Order-insensitive multiset comparison. config: { separator }
  'set-match'(config, item, response) {
    const sep = config.separator ? new RegExp(config.separator) : /[\s,;]+/;
    const toSet = (s) => (s || '').trim().toLowerCase().split(sep).filter(Boolean).sort();
    const got = toSet(response);
    const ok = candidates(item).some((a) => {
      const want = toSet(a);
      return want.length === got.length && want.every((w, i) => w === got[i]);
    });
    const want = toSet(item.answer);
    const missing = want.filter((w) => !got.includes(w));
    const extra = got.filter((g) => !want.includes(g));
    return {
      correct: ok,
      detail: ok ? 'All elements present.' :
        `${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${extra.length ? `Unexpected: ${extra.join(', ')}.` : ''}`.trim() || `Expected "${item.answer}".`
    };
  },

  // Position-by-position token diff. config:
  //   { tokenizer: 'whitespace' | 'chars', keep } — keep is a regex character
  //   class; with tokenizer 'chars' each kept character is one token.
  'sequence-diff'(config, item, response) {
    const tokenize = (s) => {
      if (config.tokenizer === 'chars') {
        const keep = config.keep || '\\S';
        return ((s || '').match(new RegExp(`[${keep}]`, 'g')) || []);
      }
      return (s || '').trim().split(/\s+/).filter(Boolean);
    };
    const grade = (answer) => {
      const expected = tokenize(answer);
      const got = tokenize(response);
      const len = Math.max(expected.length, got.length);
      const diff = [];
      let ok = true;
      for (let i = 0; i < len; i++) {
        const match = expected[i] === got[i];
        if (!match) ok = false;
        diff.push({ pos: i + 1, expected: expected[i] ?? '·', got: got[i] ?? '·', ok: match });
      }
      return { ok, diff };
    };
    for (const a of candidates(item)) {
      const g = grade(a);
      if (g.ok) return { correct: true, detail: 'Sequence matches position for position.', diff: g.diff };
    }
    const g = grade(item.answer);
    const misses = g.diff.filter((d) => !d.ok);
    return {
      correct: false,
      detail: `Mismatch at position${misses.length > 1 ? 's' : ''} ${misses.map((d) => d.pos).join(', ')} — expected ${misses.map((d) => d.expected).join(',')}, got ${misses.map((d) => d.got).join(',')}.`,
      diff: g.diff
    };
  },

  // Numeric comparison. config: { tolerance }
  numeric(config, item, response) {
    const got = parseFloat(String(response).trim().replace(',', '.'));
    if (Number.isNaN(got)) return { correct: false, detail: 'Answer must be a number.' };
    const tol = config.tolerance || 0;
    const ok = candidates(item).some((a) => Math.abs(parseFloat(a) - got) <= tol);
    const expected = parseFloat(item.answer);
    return {
      correct: ok,
      detail: ok ? `Correct: ${item.answer}.` : `Off by ${+(got - expected).toFixed(4)} — expected ${item.answer}, got ${got}.`
    };
  }
};

async function runExternal(checker, item, response) {
  const res = await fetch(checker.externalUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: item.prompt,
      answer: item.answer,
      userResponse: response,
      config: checker.config || {}
    })
  });
  if (!res.ok) throw new Error(`external checker ${res.status}`);
  const data = await res.json();
  if (typeof data.correct !== 'boolean' || typeof data.detail !== 'string') {
    throw new Error('external checker returned an invalid shape (need {correct, detail})');
  }
  return { correct: data.correct, detail: data.detail, diff: data.diff };
}

export function getCheckerDef(plan, checkerId) {
  return (plan.checkers || []).find((c) => c.id === checkerId) || null;
}

export function isJudgmentChecker(plan, drillType) {
  if (drillType.evaluationMode === 'judgment') return true;
  const c = drillType.checkerId ? getCheckerDef(plan, drillType.checkerId) : null;
  return !!(c && c.strategy === 'judgment');
}

export async function runCheck(plan, drillType, item, userResponse, seenFallbacks = new Set()) {
  const checker = getCheckerDef(plan, drillType.checkerId);
  if (!checker) {
    throw new Error(`Drill "${drillType.id}" references checker "${drillType.checkerId}" which the plan does not declare.`);
  }
  return runCheckerDef(plan, checker, item, userResponse, seenFallbacks);
}

async function runCheckerDef(plan, checker, item, userResponse, seenFallbacks) {
  if (checker.strategy === 'judgment') {
    // The session runtime routes judgment to the evaluator API; reaching here
    // means a config error the validator should have caught.
    throw new Error(`Checker "${checker.id}" is judgment-strategy — route via the evaluator, not runCheck().`);
  }

  if (checker.strategy === 'external') {
    try {
      return await runExternal(checker, item, userResponse);
    } catch (e) {
      if (checker.fallback && !seenFallbacks.has(checker.id)) {
        seenFallbacks.add(checker.id);
        const fb = getCheckerDef(plan, checker.fallback);
        if (fb && fb.strategy === 'judgment') {
          // Typical fallback: hand the grading to the evaluator API. The
          // session runtime performs the actual call (or queues it offline).
          return {
            routeToJudgment: true,
            provisional: true,
            fallbackUsed: fb.id,
            detail: `"${checker.name}" unreachable — routed to tutor judgment (provisional).`
          };
        }
        if (fb) {
          const result = await runCheckerDef(plan, fb, item, userResponse, seenFallbacks);
          return {
            ...result,
            provisional: true,
            fallbackUsed: fb.id,
            detail: `[provisional — "${checker.name}" unreachable, graded by "${fb.name}"] ${result.detail}`
          };
        }
      }
      return {
        correct: false,
        provisional: true,
        detail: `[provisional] External checker "${checker.name}" is unreachable and no fallback is declared: ${e.message}`
      };
    }
  }

  const impl = strategies[checker.strategy];
  if (!impl) throw new Error(`Unknown checker strategy "${checker.strategy}"`);
  return impl(checker.config || {}, item, userResponse);
}
