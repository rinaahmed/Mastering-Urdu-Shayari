// Shared grouped/collapsible lesson list, used by the Lessons view and the
// Settings "starting position" picker so both present lessons the same way.
//
// Grouping (phase -> unit) and per-lesson numbering are presentation only —
// the underlying order is exactly flattenLessons()'s phases -> weeks ->
// lessons sequence (that's also the order "mark everything before" and the
// teaching-order audit rely on). A lesson's globalIndex is its 1-based
// position in that flat sequence, unaffected by how it's visually grouped.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// The seed plan's own week titles happen to read "Week N — <rest>"; the
// app's UI calls this grouping level "Unit" (see flattenLessons in
// schema.js), so a literal leading "Week N —" is stripped to avoid showing
// both terms for the same thing. Anything else in the title is kept as-is —
// this is a cosmetic no-op for plans whose week titles don't follow that
// pattern.
function unitLabel(weekTitle, unitNumber) {
  const stripped = (weekTitle || '').replace(/^Week\s+\d+\s*[—–-]\s*/i, '').trim();
  return stripped ? `Unit ${unitNumber} — ${stripped}` : `Unit ${unitNumber}`;
}

export function groupLessons(lessons) {
  const phases = [];
  let curPhase = null;
  let curUnit = null;
  lessons.forEach((lesson, i) => {
    if (!curPhase || curPhase.phaseId !== lesson.phaseId) {
      curPhase = { phaseId: lesson.phaseId, phaseTitle: lesson.phaseTitle, units: [] };
      phases.push(curPhase);
      curUnit = null;
    }
    if (!curUnit || curUnit.weekId !== lesson.weekId) {
      curUnit = { weekId: lesson.weekId, unitLabel: unitLabel(lesson.weekTitle, lesson.unitNumber), lessons: [] };
      curPhase.units.push(curUnit);
    }
    curUnit.lessons.push({ ...lesson, globalIndex: i + 1 });
  });
  return phases;
}

// rowState(lesson) -> {isDone, isCurrent, isBlocked}
// rowMarker(state) -> glyph string; rowStatusLabel(state) -> meta text
// onRowClick(lesson) -> tap handler
export function renderGroupedLessons({ lessons, rowState, rowMarker, rowStatusLabel, onRowClick }) {
  const total = lessons.length;
  const phases = groupLessons(lessons);
  const wrap = el('div', 'lessons-groups');

  for (const phase of phases) {
    const phaseLessons = phase.units.flatMap((u) => u.lessons);
    const doneCount = phaseLessons.filter((l) => rowState(l).isDone).length;
    const hasCurrent = phaseLessons.some((l) => rowState(l).isCurrent);

    const details = el('details', 'phase-section');
    // Open by default only for phases with something actually going on
    // (current or already-done lessons) — an untouched future phase stays
    // collapsed so it doesn't force scrolling past dozens of its rows.
    if (hasCurrent || doneCount > 0) details.open = true;

    const summary = el('summary', 'phase-summary');
    summary.append(el('span', 'phase-title', phase.phaseTitle));
    summary.append(el('span', 'phase-progress', `${doneCount}/${phaseLessons.length} done`));
    details.append(summary);

    const body = el('div', 'phase-body');
    for (const unit of phase.units) {
      body.append(el('h3', 'unit-heading', unit.unitLabel));
      const list = el('div', 'lesson-list');
      for (const lesson of unit.lessons) {
        const state = rowState(lesson);
        const classes = ['lesson-row'];
        if (state.isDone) classes.push('done');
        if (state.isCurrent) classes.push('current');
        if (state.isBlocked) classes.push('blocked');
        if (!state.isDone && !state.isCurrent && !state.isBlocked) classes.push('not-started');

        const row = el('button', classes.join(' '));
        row.append(el('span', 'lesson-index', `${lesson.globalIndex} / ${total}`));
        row.append(el('span', 'lesson-marker', rowMarker(state)));
        const info = el('span', 'lesson-info');
        info.append(el('span', 'lesson-title', lesson.title));
        info.append(el('span', 'lesson-meta', rowStatusLabel(state)));
        row.append(info);
        row.onclick = () => onRowClick(lesson);
        list.append(row);
      }
      body.append(list);
    }
    details.append(body);
    wrap.append(details);
  }
  return wrap;
}
