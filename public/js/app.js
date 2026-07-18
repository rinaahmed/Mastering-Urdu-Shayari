// App bootstrap: seed plan on first run, E Ink mode detection, offline-queue
// flusher, service worker, hash routing. Today is the default — one screen,
// today's session only.

import { db } from './db.js';
import { seedDefaultPlan } from './exporter.js';
import { installQueueFlusher } from './api.js';
import { applyEvaluation, getActivePlan } from './session.js';
import { getVersionInfo, formatVersionBadge } from './version.js';
import { renderToday } from './views/today.js';
import { renderLessons } from './views/lessons.js';
import { renderProgress } from './views/progress.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderSettings } from './views/settings.js';

const routes = {
  '#today': renderToday,
  '#lessons': renderLessons,
  '#progress': renderProgress,
  '#portfolio': renderPortfolio,
  '#settings': renderSettings
};

const main = document.getElementById('main');

function route() {
  const hash = routes[location.hash] ? location.hash : '#today';
  document.querySelectorAll('nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
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

async function setTitle() {
  const plan = await getActivePlan();
  const h1 = document.getElementById('app-title');
  if (plan && h1) h1.textContent = plan.title;
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
  await setTitle();
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
