// App bootstrap: seed plan #1 on first run, install the offline-queue
// flusher, register the service worker, and route between views.
// Today is the default — one screen, today's session only.

import { seedDefaultPlan } from './exporter.js';
import { installQueueFlusher } from './api.js';
import { applyEvaluation } from './session.js';
import { renderToday } from './views/today.js';
import { renderProgress } from './views/progress.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderSettings } from './views/settings.js';

const routes = {
  '#today': renderToday,
  '#progress': renderProgress,
  '#portfolio': renderPortfolio,
  '#settings': renderSettings
};

const main = document.getElementById('main');

function route() {
  const hash = routes[location.hash] ? location.hash : '#today';
  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });
  routes[hash](main);
}

function updateOnlineBadge() {
  const badge = document.getElementById('offline-badge');
  badge.hidden = navigator.onLine;
}

async function boot() {
  await seedDefaultPlan();

  // When a queued judgment call finally succeeds, apply it to its session block.
  installQueueFlusher(async (queueItem, result) => {
    const { sessionId, blockIndex, ledgerAlreadyApplied } = queueItem.context || {};
    if (sessionId !== undefined && blockIndex !== undefined) {
      await applyEvaluation(sessionId, blockIndex, result, ledgerAlreadyApplied);
      if (location.hash === '#today' || location.hash === '') route();
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);
  updateOnlineBadge();
  route();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
  }
}

boot();
