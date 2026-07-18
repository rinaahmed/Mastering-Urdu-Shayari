// Deploy version. There is no build step (Cloudflare Pages serves public/ as
// static files), so version.json is a plain committed file whose contents
// get bumped by hand as the last step of every push — see getVersionInfo()'s
// callers (topbar badge in app.js, About card in Settings) and README.md
// § Versioning.
//
// Fetched with cache: 'no-store' so it always reflects the deployed file
// rather than whatever the browser's HTTP cache thinks is current; the
// service worker separately does a network-first-with-cache-fallback for
// this one path so the badge still shows the last known value offline.

let cached = null;

export async function getVersionInfo() {
  if (cached) return cached;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    cached = await res.json();
    return cached;
  } catch {
    return null;
  }
}

export function formatVersionBadge(info) {
  if (!info || !info.version) return '';
  return `v${info.version}`;
}

export function formatBuiltAt(info) {
  if (!info || !info.builtAt) return '';
  try {
    const d = new Date(info.builtAt);
    return d.toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
  } catch {
    return info.builtAt;
  }
}
