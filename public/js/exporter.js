// Plan import (schema validation + teaching-order audit), v1 migration hook,
// and full JSON export/restore.

import { db, STORES, exportAll, importAll } from './db.js';
import { validatePlan, auditTeachingOrder } from './schema.js';
import { migrateV1toV2 } from './migrate.js';
import { newNodeState } from './ledger.js';

// Import a plan file. Order: parse → structural validation → teaching-order
// audit → store. Every failure reports its JSON path; audit violations refuse
// the import outright.
export async function importPlan(planJson) {
  let plan;
  try {
    plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e.message}`] };
  }

  if (plan && plan.schemaVersion === 1) {
    return {
      ok: false,
      v1: true,
      errors: ['This is a schema v1 plan. Use "Convert v1 plan" below to migrate it — teaching content will need to be authored by hand.']
    };
  }

  const { ok, errors } = validatePlan(plan);
  if (!ok) return { ok: false, errors };

  const audit = auditTeachingOrder(plan);
  if (!audit.ok) {
    return {
      ok: false,
      errors: audit.violations.map((v) => `teaching-order audit: ${v}`)
    };
  }

  await db.put(STORES.plans, plan);

  // Seed skill-node ledger state without clobbering existing progress.
  const now = Date.now();
  for (const node of plan.skillNodes) {
    const existing = await db.get(STORES.nodes, node.id);
    if (!existing) {
      await db.put(STORES.nodes, newNodeState(plan.id, node, now));
    } else {
      existing.name = node.name;
      existing.description = node.description;
      existing.prerequisites = node.prerequisites || [];
      existing.taughtIn = node.taughtIn;
      await db.put(STORES.nodes, existing);
    }
  }

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

// Convert a v1 plan and report what needs hand-authoring. Returns the draft
// regardless so the user can download and finish it.
export function convertV1(planJson) {
  let v1;
  try {
    v1 = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
  } catch (e) {
    return { plan: null, issues: [{ level: 'error', path: '(root)', message: `Not valid JSON: ${e.message}` }] };
  }
  return migrateV1toV2(v1);
}

// Seed plan #1 on first run.
export async function seedDefaultPlan() {
  const existing = await db.getMeta('activePlanId');
  if (existing) return false;
  try {
    const res = await fetch('/plans/seed-plan.json');
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

export async function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function downloadFullExport() {
  const dump = await exportAll();
  await downloadJson(dump, `learning-sessions-export-${dump.exportedAt.slice(0, 10)}.json`);
}

export async function restoreFromExport(text) {
  const dump = JSON.parse(text);
  await importAll(dump);
}
