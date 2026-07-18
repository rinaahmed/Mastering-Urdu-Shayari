// Plan import (validated against the schema) and full JSON export.

import { db, STORES, exportAll, importAll } from './db.js';
import { validatePlan } from './schema.js';
import { newNodeState } from './ledger.js';

// Import a plan file. Validates first and reports errors clearly; on success,
// stores the plan verbatim and seeds ledger state for any new nodes/categories.
export async function importPlan(planJson) {
  let plan;
  try {
    plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e.message}`] };
  }

  const { ok, errors } = validatePlan(plan);
  if (!ok) return { ok: false, errors };

  await db.put(STORES.plans, plan);

  // Seed skill-node ledger state without clobbering existing progress.
  const now = Date.now();
  for (const node of plan.skillNodes) {
    const existing = await db.get(STORES.nodes, node.id);
    if (!existing) {
      await db.put(STORES.nodes, newNodeState(plan.id, node, now));
    } else {
      // refresh descriptive fields; keep ledger state
      existing.name = node.name;
      existing.description = node.description;
      existing.prerequisites = node.prerequisites || [];
      await db.put(STORES.nodes, existing);
    }
  }

  // Seed error categories (plan-authored instances count as history).
  for (const cat of plan.errorCategories || []) {
    const existing = await db.get(STORES.errorCategories, cat.id);
    if (!existing) {
      await db.put(STORES.errorCategories, { ...cat, planId: plan.id });
    }
  }

  await db.setMeta('activePlanId', plan.id);
  const firstLesson = plan.phases[0].weeks[0].lessons[0];
  const current = await db.getMeta('currentLessonId');
  if (!current) await db.setMeta('currentLessonId', firstLesson.id);

  return { ok: true, errors: [], plan };
}

// Seed plan #1 on first run.
export async function seedDefaultPlan() {
  const existing = await db.getMeta('activePlanId');
  if (existing) return false;
  try {
    const res = await fetch('/plans/urdu-shayari-plan.json');
    if (!res.ok) return false;
    const plan = await res.json();
    const result = await importPlan(plan);
    if (!result.ok) {
      console.error('Seed plan failed validation:', result.errors);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Could not seed default plan (offline first run?):', e);
    return false;
  }
}

export async function downloadFullExport() {
  const dump = await exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mastering-urdu-shayari-export-${dump.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function restoreFromExport(text) {
  const dump = JSON.parse(text);
  await importAll(dump);
}
