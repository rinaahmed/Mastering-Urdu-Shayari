// v1 → v2 plan migration. Produces a best-effort v2 draft plus an issues list.
// Structural conversions are automatic; anything that needs a human —
// teaching content, external checker URLs, untaught nodes — is reported as an
// issue with a clear path. Drafts with 'error' issues will not pass import.

// v1's checkerId values were an app enum; v2 checkers are plan-declared.
// NOTE: the literal ids below are v1 wire-format identifiers this migration
// must recognize — historical plan data, not app vocabulary. This is the one
// file exempt from the no-domain-words rule for exactly that reason.
const V1_CHECKER_MAP = {
  'pattern-diff': {
    name: 'Token sequence diff',
    strategy: 'sequence-diff',
    config: { tokenizer: 'chars', keep: '0-9' }
  },
  'matra-total': {
    name: 'Numeric total',
    strategy: 'numeric',
    config: { tolerance: 0 }
  },
  'exact-word': {
    name: 'Normalized word match',
    strategy: 'normalized-exact',
    config: {}
  },
  'behr-engine': {
    name: 'External scansion engine',
    strategy: 'external',
    externalUrl: '',
    fallback: 'pattern-diff'
  }
};

export function migrateV1toV2(v1) {
  const issues = [];
  const todo = (path, message) => issues.push({ level: 'todo', path, message });
  const error = (path, message) => issues.push({ level: 'error', path, message });

  if (!v1 || v1.schemaVersion !== 1) {
    return { plan: null, issues: [{ level: 'error', path: 'schemaVersion', message: 'not a v1 plan' }] };
  }

  const plan = JSON.parse(JSON.stringify(v1));
  plan.schemaVersion = 2;

  // ---- checkers: synthesize from the checkerIds the v1 drill types used ----
  const usedCheckerIds = new Set((v1.drillTypes || []).map((d) => d.checkerId).filter(Boolean));
  plan.checkers = [];
  for (const id of usedCheckerIds) {
    const mapped = V1_CHECKER_MAP[id];
    if (mapped) {
      plan.checkers.push({ id, ...mapped });
      if (mapped.strategy === 'external' && !mapped.externalUrl) {
        error(`checkers[id=${id}].externalUrl`,
          'v1 wired this checker in code; v2 needs the engine\'s URL. Fill in externalUrl (the endpoint receives {prompt, answer, userResponse, config} and returns {correct, detail}), or change strategy.');
      }
    } else {
      plan.checkers.push({ id, name: id, strategy: 'exact', config: {} });
      error(`checkers[id=${id}]`,
        `unknown v1 checker "${id}" — converted to an 'exact' placeholder; choose the right strategy by hand.`);
    }
  }
  // Judgment drills get an explicit judgment checker.
  if ((v1.drillTypes || []).some((d) => d.evaluationMode === 'judgment')) {
    plan.checkers.push({ id: 'judge', name: 'Tutor judgment', strategy: 'judgment' });
    plan.drillTypes = plan.drillTypes.map((d) =>
      d.evaluationMode === 'judgment' && !d.checkerId ? { ...d, checkerId: 'judge' } : d);
  }

  // ---- lessons: metadata carries over; content must be authored ----
  const lessonOrder = [];
  for (const ph of plan.phases || []) {
    for (const wk of ph.weeks || []) {
      wk.lessons = (wk.lessons || []).map((ls) => {
        lessonOrder.push(ls);
        const hasArtifact = (ls.drillTypeIds || []).some((dtId) =>
          (v1.drillTypes || []).find((d) => d.id === dtId && d.producesArtifact));
        const lessonType = hasArtifact ? 'production' : 'drill';
        const content = [
          {
            type: 'generate',
            body: `TODO(author): no teaching content existed in the v1 plan. Interim stand-in — teach toward this objective before the drills: "${ls.objective}"`
          },
          ...(ls.drillTypeIds || []).map((dtId) => ({ type: 'drill', drillTypeId: dtId }))
        ];
        todo(`lesson "${ls.id}".content`,
          `teaching content must be authored by hand — a placeholder generate block was inserted (lesson "${ls.title}")`);
        return { ...ls, lessonType, content };
      });
    }
  }

  // ---- skillNodes: infer taughtIn from first lesson that declares the node ----
  plan.skillNodes = (plan.skillNodes || []).map((n) => {
    const taughtLesson = lessonOrder.find((ls) => (ls.skillNodeIds || []).includes(n.id));
    if (!taughtLesson) {
      error(`skillNodes[id=${n.id}].taughtIn`,
        `node "${n.name}" is never declared by any lesson — set taughtIn by hand. Until its lesson completes, the node is ineligible for all drills and review.`);
      return { ...n, taughtIn: '' };
    }
    return { ...n, taughtIn: taughtLesson.id };
  });

  if (!plan.missingData) plan.missingData = [];
  if (!plan.settings) plan.settings = {};

  return { plan, issues };
}
