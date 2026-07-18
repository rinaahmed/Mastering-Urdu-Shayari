// API client for the Cloudflare Worker proxy. The browser never sees the
// Anthropic key. Works offline for everything except generation and judgment:
// judgment calls are queued in IndexedDB and retried when back online.

import { db, STORES } from './db.js';

const GENERATE_URL = '/api/generate';
const EVALUATE_URL = '/api/evaluate';

export class OfflineError extends Error {
  constructor() { super('offline'); this.name = 'OfflineError'; }
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new OfflineError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Generator call: teaches, hints, explains. Full context payload, returns prose.
export async function generate(contextPayload, request) {
  const data = await post(GENERATE_URL, { context: contextPayload, request });
  return data.text;
}

// Evaluator call: drill + correct answer + user response only. Strict JSON.
// { correct, errorCategoryId, newCategory, confidenceDelta, note }
export async function evaluate(evaluatorPayload) {
  const data = await post(EVALUATE_URL, evaluatorPayload);
  return data; // worker validates and returns the parsed JSON
}

// ---- offline queue: judgment calls survive being offline ----

export async function enqueueEvaluation(evaluatorPayload, context) {
  // context: { sessionId, blockIndex, nodeIds } — enough to apply the result later
  await db.add(STORES.queue, {
    type: 'evaluate',
    payload: evaluatorPayload,
    context,
    createdAt: Date.now(),
    attempts: 0
  });
}

// Flush the queue with backoff. onResult(applied) is called per success so the
// caller can update ledger/session state.
export async function flushQueue(onResult) {
  if (!navigator.onLine) return { flushed: 0, remaining: (await db.getAll(STORES.queue)).length };
  const items = await db.getAll(STORES.queue);
  let flushed = 0;
  for (const item of items) {
    try {
      if (item.type === 'evaluate') {
        const result = await evaluate(item.payload);
        await db.delete(STORES.queue, item.id);
        flushed++;
        if (onResult) await onResult(item, result);
      }
    } catch (e) {
      if (e instanceof OfflineError) break; // stop; retry on next 'online'
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts >= 5) {
        await db.delete(STORES.queue, item.id); // give up after 5 real failures
      } else {
        await db.put(STORES.queue, item);
      }
    }
  }
  const remaining = (await db.getAll(STORES.queue)).length;
  return { flushed, remaining };
}

export async function queueSize() {
  return (await db.getAll(STORES.queue)).length;
}

let flushHandler = null;
export function installQueueFlusher(onResult) {
  flushHandler = () => flushQueue(onResult);
  window.addEventListener('online', flushHandler);
  // opportunistic flush on start
  flushQueue(onResult);
}
