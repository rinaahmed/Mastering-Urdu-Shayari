// Skill-node ledger: status, accuracy, confidence with time decay, spaced
// repetition scheduling, and plateau ("flag, don't hammer") detection.
// Pure functions over node-state objects; persistence happens in the caller.

export const STATUSES = ['not-attempted', 'emerging', 'shaky', 'solid'];

const DAY = 24 * 60 * 60 * 1000;

// Decay rate per status: solid knowledge fades slower.
const DECAY_LAMBDA = { 'solid': 0.02, 'shaky': 0.08, 'emerging': 0.15, 'not-attempted': 0 };

export function newNodeState(planId, node, now = Date.now()) {
  return {
    id: node.id,
    planId,
    name: node.name,
    description: node.description,
    prerequisites: node.prerequisites || [],
    derived: !!node.derived,        // true when formed mid-session from a realization
    status: 'not-attempted',
    attempts: 0,
    correct: 0,
    accuracy: 0,
    confidence: 0,                  // 0..1, stored at lastSeen; decays over time
    lastSeen: null,
    nextDue: now,                   // new nodes are due immediately
    intervalDays: 1,
    history: [],                    // recent results: {ts, correct} — capped
    flagged: false,
    flagNote: null,
    createdAt: now
  };
}

export function newDerivedNode(planId, { id, name, description }, now = Date.now()) {
  const n = newNodeState(planId, { id, name, description, prerequisites: [], derived: true }, now);
  n.derived = true;
  return n;
}

// Confidence with time decay: stored confidence * exp(-lambda * days since seen).
export function decayedConfidence(node, now = Date.now()) {
  if (!node.lastSeen) return 0;
  const days = Math.max(0, (now - node.lastSeen) / DAY);
  const lambda = DECAY_LAMBDA[node.status] ?? 0.1;
  return node.confidence * Math.exp(-lambda * days);
}

function computeStatus(node) {
  if (node.attempts === 0) return 'not-attempted';
  const recent = node.history.slice(-6);
  const recentAcc = recent.length ? recent.filter(r => r.correct).length / recent.length : 0;
  if (node.attempts >= 6 && recentAcc >= 0.85) return 'solid';
  if (node.attempts >= 3 && recentAcc >= 0.6) return 'shaky';
  return 'emerging';
}

// Record one drill result against a node. confidenceDelta comes from the
// evaluator for judgment drills, or defaults for deterministic ones.
export function recordResult(node, correct, { confidenceDelta = null, now = Date.now() } = {}) {
  node.attempts += 1;
  if (correct) node.correct += 1;
  node.accuracy = node.correct / node.attempts;
  node.history.push({ ts: now, correct: !!correct });
  if (node.history.length > 30) node.history = node.history.slice(-30);

  const delta = confidenceDelta !== null ? confidenceDelta : (correct ? 0.15 : -0.2);
  node.confidence = Math.min(1, Math.max(0, decayedConfidence(node, now) + delta));
  node.lastSeen = now;
  node.status = computeStatus(node);

  // Spaced repetition: grow the interval on success, reset on failure.
  if (correct) {
    node.intervalDays = Math.min(21, Math.max(1, node.intervalDays * (node.status === 'solid' ? 2 : 1.5)));
  } else {
    node.intervalDays = 1;
  }
  node.nextDue = now + node.intervalDays * DAY;
  return node;
}

// Flag, don't hammer: >= threshold attempts with flat, sub-mastery accuracy.
export function isPlateaued(node, { attemptThreshold = 8, window = 6 } = {}) {
  if (node.flagged) return false; // already surfaced
  if (node.attempts < attemptThreshold) return false;
  const recent = node.history.slice(-window);
  if (recent.length < window) return false;
  const recentAcc = recent.filter(r => r.correct).length / recent.length;
  if (recentAcc >= 0.85) return false; // it's moving — that's mastery, not a plateau
  const older = node.history.slice(0, -window);
  if (older.length < 2) return false;
  const olderAcc = older.filter(r => r.correct).length / older.length;
  return Math.abs(recentAcc - olderAcc) < 0.15; // flat: no meaningful movement
}

export function dueNodes(nodes, now = Date.now()) {
  return nodes.filter(n => n.attempts > 0 && !n.flagged && n.nextDue <= now);
}

// Review weight: low accuracy and overdueness push a node up the queue.
export function reviewWeight(node, now = Date.now()) {
  const overdueDays = Math.max(0, (now - node.nextDue) / DAY);
  return (1 - node.accuracy) * 2 + Math.min(overdueDays, 7) / 7 + (1 - decayedConfidence(node, now));
}

// Accuracy trend for the progress view: accuracy over trailing windows.
export function accuracyTrend(node, buckets = 5) {
  const h = node.history;
  if (h.length === 0) return [];
  const size = Math.max(1, Math.ceil(h.length / buckets));
  const out = [];
  for (let i = 0; i < h.length; i += size) {
    const slice = h.slice(i, i + size);
    out.push(slice.filter(r => r.correct).length / slice.length);
  }
  return out;
}
