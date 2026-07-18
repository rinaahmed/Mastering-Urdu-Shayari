// Settings — plan import (with clear validation errors), full JSON export,
// restore, offline-queue status, and derived-node creation.

import { db, STORES } from '../db.js';
import { importPlan, downloadFullExport, restoreFromExport } from '../exporter.js';
import { queueSize } from '../api.js';
import { getActivePlan, createDerivedNode } from '../session.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function renderSettings(root) {
  root.innerHTML = '';
  const plan = await getActivePlan();

  // Active plan
  const planCard = el('section', 'card');
  planCard.append(el('h2', null, 'Plan'));
  planCard.append(el('p', null, plan ? `Active: ${plan.title}` : 'No plan loaded.'));

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json';
  fileInput.style.display = 'none';
  const importBtn = el('button', 'primary', 'Import plan JSON…');
  const errBox = el('div', 'error-box');
  importBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const text = await file.text();
    const result = await importPlan(text);
    if (result.ok) {
      errBox.innerHTML = '';
      errBox.append(el('p', 'verdict ok', `Imported: ${result.plan.title}`));
    } else {
      errBox.innerHTML = '';
      errBox.append(el('p', 'verdict bad', `Plan failed validation (${result.errors.length} error${result.errors.length > 1 ? 's' : ''}):`));
      const ul = el('ul', 'error-list');
      result.errors.forEach(e => ul.append(el('li', null, e)));
      errBox.append(ul);
    }
    renderSettingsPartial(root);
  };
  planCard.append(importBtn, fileInput, errBox);
  root.append(planCard);

  // Data
  const dataCard = el('section', 'card');
  dataCard.append(el('h2', null, 'Data'));
  const exportBtn = el('button', 'primary', 'Export everything (JSON)');
  exportBtn.onclick = downloadFullExport;
  dataCard.append(exportBtn);

  const restoreInput = el('input');
  restoreInput.type = 'file';
  restoreInput.accept = 'application/json';
  restoreInput.style.display = 'none';
  const restoreBtn = el('button', null, 'Restore from export…');
  restoreBtn.onclick = () => restoreInput.click();
  restoreInput.onchange = async () => {
    const file = restoreInput.files[0];
    if (!file) return;
    if (!confirm('Restore will replace ALL current data with the export file. Continue?')) return;
    try {
      await restoreFromExport(await file.text());
      alert('Restored.');
      location.reload();
    } catch (e) {
      alert(`Restore failed: ${e.message}`);
    }
  };
  dataCard.append(restoreBtn, restoreInput);

  const pending = await queueSize();
  dataCard.append(el('p', 'muted', pending > 0
    ? `${pending} judgment call${pending > 1 ? 's' : ''} queued (will retry when online).`
    : 'Offline queue is empty.'));
  root.append(dataCard);

  // Derived node — capture a mid-session realization as a trackable skill.
  if (plan) {
    const derivedCard = el('section', 'card');
    derivedCard.append(el('h2', null, 'New derived node'));
    derivedCard.append(el('p', 'muted small', 'Capture a realization as a trackable skill node — it enters review like any other.'));
    const name = el('input', 'answer');
    name.placeholder = 'name, e.g. "nun-ghunna weight"';
    const desc = el('input', 'answer');
    desc.placeholder = 'what exactly the skill is';
    const add = el('button', null, 'Add node');
    add.onclick = async () => {
      if (!name.value.trim()) return;
      await createDerivedNode(plan.id, name.value.trim(), desc.value.trim() || name.value.trim());
      name.value = ''; desc.value = '';
      alert('Derived node added.');
    };
    derivedCard.append(name, desc, add);
    root.append(derivedCard);
  }
}

function renderSettingsPartial(root) {
  // re-render active-plan label only on next full navigation; cheap approach:
  getActivePlan().then(p => {
    const label = root.querySelector('.card p');
    if (label && p) label.textContent = `Active: ${p.title}`;
  });
}
