// Settings — plan import with full-path validation errors, v1 conversion,
// display mode (E Ink), plan dependencies (missingData), export/restore,
// offline queue status, derived nodes.

import { db, STORES } from '../db.js';
import { importPlan, convertV1, downloadFullExport, downloadJson, restoreFromExport } from '../exporter.js';
import { queueSize } from '../api.js';
import { getActivePlan, getResolvedMissingIds, resolveMissingData, createDerivedNode,
  getCompletedLessonIds, getCurrentLessonId, setStartingPosition } from '../session.js';
import { getVersionInfo, formatVersionBadge, formatBuiltAt } from '../version.js';
import { flattenLessons } from '../schema.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function filePicker(accept, onText) {
  const input = el('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files[0];
    if (file) await onText(await file.text());
    input.value = '';
  };
  return input;
}

export async function renderSettings(root, opts = {}) {
  root.innerHTML = '';
  const plan = await getActivePlan();

  // ---- About ----
  const aboutCard = el('section', 'card');
  aboutCard.append(el('h2', null, 'About'));
  const versionInfo = await getVersionInfo();
  aboutCard.append(el('p', null, 'Bayaz'));
  aboutCard.append(el('p', 'muted small', versionInfo
    ? `${formatVersionBadge(versionInfo)} — built ${formatBuiltAt(versionInfo)}`
    : 'Version unknown — /version.json unreachable.'));
  root.append(aboutCard);

  // ---- Display mode ----
  const displayCard = el('section', 'card');
  displayCard.append(el('h2', null, 'Display'));
  const einkRow = el('label', 'toggle-row');
  const einkBox = el('input');
  einkBox.type = 'checkbox';
  einkBox.checked = document.body.classList.contains('eink');
  einkBox.onchange = async () => {
    document.body.classList.toggle('eink', einkBox.checked);
    await db.setMeta('einkMode', einkBox.checked);
  };
  einkRow.append(einkBox, el('span', null, 'E Ink mode — pure greyscale, no accent, heavier borders'));
  displayCard.append(einkRow);
  displayCard.append(el('p', 'muted small', 'Defaults on when the display reports slow refresh (E Ink).'));
  root.append(displayCard);

  // ---- Plan ----
  const planCard = el('section', 'card');
  planCard.append(el('h2', null, 'Plan'));
  planCard.append(el('p', null, plan ? `Active: ${plan.title}` : 'No plan loaded.'));

  const errBox = el('div', 'error-box');
  const showErrors = (title, errors) => {
    errBox.innerHTML = '';
    errBox.append(el('p', 'verdict bad small', title));
    const ul = el('ul', 'error-list');
    errors.forEach((e) => ul.append(el('li', null, e)));
    errBox.append(ul);
  };

  const importInput = filePicker('application/json', async (text) => {
    const result = await importPlan(text);
    if (result.ok) {
      errBox.innerHTML = '';
      errBox.append(el('p', 'verdict ok small', `Imported: ${result.plan.title}`));
      renderSettings(root, { justImported: true });
    } else {
      showErrors(`Import refused (${result.errors.length} problem${result.errors.length > 1 ? 's' : ''}):`, result.errors);
    }
  });
  const importBtn = el('button', 'primary', 'Import plan JSON…');
  importBtn.onclick = () => importInput.click();

  const convertInput = filePicker('application/json', async (text) => {
    const { plan: draft, issues } = convertV1(text);
    errBox.innerHTML = '';
    if (!draft) {
      showErrors('Conversion failed:', issues.map((i) => `${i.path}: ${i.message}`));
      return;
    }
    const errors = issues.filter((i) => i.level === 'error');
    const todos = issues.filter((i) => i.level === 'todo');
    errBox.append(el('p', 'verdict small', `Converted to schema v2 — ${errors.length} blocking, ${todos.length} to author by hand.`));
    const ul = el('ul', 'error-list');
    errors.forEach((i) => ul.append(el('li', 'hard', `MUST FIX — ${i.path}: ${i.message}`)));
    todos.forEach((i) => ul.append(el('li', null, `TODO — ${i.path}: ${i.message}`)));
    errBox.append(ul);
    const dl = el('button', null, 'Download v2 draft…');
    dl.onclick = () => downloadJson(draft, `${draft.id || 'plan'}-v2-draft.json`);
    errBox.append(dl);
    if (errors.length === 0) {
      const imp = el('button', 'primary', 'Import draft now');
      imp.onclick = async () => {
        const result = await importPlan(draft);
        if (result.ok) {
          errBox.innerHTML = '';
          errBox.append(el('p', 'verdict ok small', `Imported: ${result.plan.title}`));
          renderSettings(root, { justImported: true });
        } else {
          showErrors('Draft failed validation:', result.errors);
        }
      };
      errBox.append(imp);
    }
  });
  const convertBtn = el('button', null, 'Convert v1 plan…');
  convertBtn.onclick = () => convertInput.click();

  const btnRow = el('div', 'btn-row');
  btnRow.append(importBtn, convertBtn);
  planCard.append(btnRow, importInput, convertInput, errBox);
  root.append(planCard);

  // ---- Starting position ----
  // Bulk-set where someone is in the plan in one tap, instead of tapping
  // "Start next lesson" 25+ times to reach a point they've already reached
  // elsewhere. Surfaced here always, and auto-expanded right after an import.
  if (plan) {
    const spCard = el('section', 'card');
    spCard.append(el('h2', null, 'Starting position'));
    spCard.append(el('p', 'muted small',
      'Already partway through this plan? Tap the lesson you want to resume at — every lesson before it is marked done and it becomes current, in one step.'));

    const spList = el('div', 'lesson-list');
    spList.hidden = true;

    const buildSpList = async () => {
      spList.innerHTML = '';
      const lessons = flattenLessons(plan);
      const [doneIds, currentId] = await Promise.all([getCompletedLessonIds(plan.id), getCurrentLessonId()]);
      lessons.forEach((lesson, i) => {
        const isDone = doneIds.has(lesson.id);
        const isCurrent = lesson.id === currentId;
        const row = el('button', `lesson-row${isDone ? ' done' : ''}${isCurrent ? ' current' : ''}${!isDone && !isCurrent ? ' not-started' : ''}`);
        row.append(el('span', 'lesson-marker', isCurrent ? '▸' : isDone ? '●' : '○'));
        const info = el('span', 'lesson-info');
        info.append(el('span', 'lesson-title', lesson.title));
        info.append(el('span', 'lesson-meta', `${lesson.phaseTitle} · Unit ${lesson.unitNumber}`));
        row.append(info);
        row.onclick = async () => {
          const ok = confirm(i === 0
            ? `Set starting position to "${lesson.title}"?`
            : `Set starting position to "${lesson.title}"? This marks the ${i} lesson${i === 1 ? '' : 's'} before it as done.`);
          if (!ok) return;
          await setStartingPosition(lesson.id);
          location.hash = '#lessons';
        };
        spList.append(row);
      });
    };

    const spToggle = el('button', null, 'Set starting position…');
    spToggle.onclick = async () => {
      spList.hidden = !spList.hidden;
      if (!spList.hidden) await buildSpList();
    };
    spCard.append(spToggle, spList);
    root.append(spCard);

    if (opts.justImported) {
      spList.hidden = false;
      await buildSpList();
    }
  }

  // ---- Plan dependencies (missingData) ----
  if (plan && (plan.missingData || []).length) {
    const depCard = el('section', 'card');
    depCard.append(el('h2', null, 'Plan dependencies'));
    const resolved = await getResolvedMissingIds(plan.id);
    for (const md of plan.missingData) {
      const row = el('div', 'dep-row');
      const isDone = resolved.has(md.id);
      row.append(el('strong', null, `${isDone ? '● ' : '○ '}${md.title}`));
      if (md.description) row.append(el('p', 'muted small', md.description));
      if (isDone) {
        const note = await db.getMeta(`resolvedMissingNote:${plan.id}:${md.id}`, '');
        row.append(el('p', 'small', `Resolved${note ? `: ${note}` : ''}`));
      } else {
        if (md.howToResolve) row.append(el('p', 'small', md.howToResolve));
        const note = el('input', 'answer');
        note.placeholder = 'resolution note';
        const btn = el('button', null, 'Mark resolved');
        btn.onclick = async () => {
          await resolveMissingData(plan.id, md.id, note.value.trim());
          renderSettings(root);
        };
        row.append(note, btn);
      }
      depCard.append(row);
    }
    root.append(depCard);
  }

  // ---- Data ----
  const dataCard = el('section', 'card');
  dataCard.append(el('h2', null, 'Data'));
  const exportBtn = el('button', 'primary', 'Export everything (JSON)');
  exportBtn.onclick = downloadFullExport;

  const restoreInput = filePicker('application/json', async (text) => {
    if (!confirm('Restore will replace ALL current data with the export file. Continue?')) return;
    try {
      await restoreFromExport(text);
      alert('Restored.');
      location.reload();
    } catch (e) {
      alert(`Restore failed: ${e.message}`);
    }
  });
  const restoreBtn = el('button', null, 'Restore from export…');
  restoreBtn.onclick = () => restoreInput.click();

  const dataRow = el('div', 'btn-row');
  dataRow.append(exportBtn, restoreBtn);
  dataCard.append(dataRow, restoreInput);

  const pending = await queueSize();
  dataCard.append(el('p', 'muted small', pending > 0
    ? `${pending} judgment call${pending > 1 ? 's' : ''} queued — will retry when online; results are provisional until then.`
    : 'Offline queue is empty.'));
  root.append(dataCard);

  // ---- Derived node ----
  if (plan) {
    const derivedCard = el('section', 'card');
    derivedCard.append(el('h2', null, 'New derived skill'));
    derivedCard.append(el('p', 'muted small', 'Capture a mid-session realization as a trackable skill. Derived skills have no teaching lesson and are eligible for review immediately.'));
    const name = el('input', 'answer');
    name.placeholder = 'name';
    const desc = el('input', 'answer');
    desc.placeholder = 'what exactly the skill is';
    const add = el('button', null, 'Add skill');
    add.onclick = async () => {
      if (!name.value.trim()) return;
      await createDerivedNode(plan.id, name.value.trim(), desc.value.trim() || name.value.trim());
      name.value = ''; desc.value = '';
      add.textContent = 'Added ✓';
    };
    derivedCard.append(name, desc, add);
    root.append(derivedCard);
  }
}
