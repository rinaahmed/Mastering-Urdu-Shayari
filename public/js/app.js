// App bootstrap: seed plan on first run, E Ink mode detection, offline-queue
// flusher, service worker, hash routing. Today is the default — one screen,
// today's session only.

import { db } from './db.js';
import { seedDefaultPlan } from './exporter.js';
import { installQueueFlusher } from './api.js';
import { applyEvaluation } from './session.js';
import { getVersionInfo, formatVersionBadge } from './version.js';
import { renderToday } from './views/today.js';
import { renderLessons } from './views/lessons.js';
import { renderProgress, renderAllSkills } from './views/progress.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderSettings } from './views/settings.js';

const routes = {
  '#today': renderToday,
  '#lessons': renderLessons,
  '#progress': renderProgress,
  '#progress-all': renderAllSkills, // secondary view, one tap from Progress — not a tab of its own
  '#portfolio': renderPortfolio,
  '#settings': renderSettings
};

const main = document.getElementById('main');

function route() {
  const hash = routes[location.hash] ? location.hash : '#today';
  const navHash = hash === '#progress-all' ? '#progress' : hash;
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === navHash);
  });
  routes[hash](main);
}

function updateOnlineBadge() {
  const badge = document.getElementById('offline-badge');
  if (badge) badge.hidden = navigator.onLine;
}

async function applyEinkMode() {
  const stored = await db.getMeta('einkMode', null);
  // Default on when the display reports slow refresh (E Ink panels).
  const eink = stored !== null ? stored : window.matchMedia('(update: slow)').matches;
  document.body.classList.toggle('eink', !!eink);
}

async function showVersionBadge() {
  const badge = document.getElementById('version-badge');
  if (!badge) return;
  const info = await getVersionInfo();
  badge.textContent = formatVersionBadge(info) || 'v—';
}

async function boot() {
  await applyEinkMode();
  await seedDefaultPlan();
  await showVersionBadge();

  // When a queued judgment call finally succeeds, apply it to its screen.
  installQueueFlusher(async (queueItem, result) => {
    const { sessionId, screenIndex, ledgerAlreadyApplied } = queueItem.context || {};
    if (sessionId !== undefined && screenIndex !== undefined) {
      await applyEvaluation(sessionId, screenIndex, result, ledgerAlreadyApplied);
      if (location.hash === '#today' || location.hash === '') route();
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);
  updateOnlineBadge();
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed:', err));
  }
}

boot();
