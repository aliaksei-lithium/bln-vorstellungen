import type { TrackBatch, TrackItem, TrackPage } from '@bln/shared';
import type { AnyRouter } from '@tanstack/react-router';

/**
 * Usage counts for signed-in people (docs/09, 2026-11-09): app opens, page views and clicks, by page kind only.
 * Nothing about which event, what was typed or what was pressed. Counts collect in memory and go to
 * /api/me/track every FLUSH_MS and when the tab is hidden; anonymous visitors send nothing.
 */
const FLUSH_MS = 30_000;
const MAX_COUNT = 500;

const counts = new Map<string, number>();
/** null until /api/me has answered: counts wait, and are dropped if the visitor turns out to be anonymous. */
let signedIn: boolean | null = null;
let page: TrackPage = 'other';

export function pageOf(pathname: string): TrackPage {
  if (pathname === '/') return 'browse';
  const first = pathname.split('/')[1] ?? '';
  if (first === 'e') return 'event';
  if (first === 'inbox') return 'for-you';
  return (
    (['venue', 'discover', 'for-you', 'agenda', 'me', 'scan', 'scans'] as const).find((p) => p === first) ?? 'other'
  );
}

function add(kind: TrackItem['kind'], on: TrackPage) {
  if (signedIn === false) return;
  const key = `${kind} ${on}`;
  counts.set(key, Math.min(MAX_COUNT, (counts.get(key) ?? 0) + 1));
}

function flush() {
  if (!signedIn || counts.size === 0) return;
  const items = [...counts].map(([key, count]): TrackItem => {
    const [kind, on] = key.split(' ') as [TrackItem['kind'], TrackPage];
    return { kind, page: on, count };
  });
  counts.clear();
  const body = JSON.stringify({ items } satisfies TrackBatch);
  // A beacon survives the tab closing; analytics must never surface an error, so failures are dropped.
  try {
    if (navigator.sendBeacon?.('/api/me/track', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/me/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch {
    /* dropped */
  }
}

/** Called with the session state once known (AppShell). Signing out drops what was not sent yet. */
export function setTrackingUser(user: boolean | null) {
  signedIn = user;
  if (user === false) counts.clear();
}

export function startTracking(router: AnyRouter) {
  if (typeof window === 'undefined') return;
  let last: string | null = null;
  router.subscribe('onResolved', ({ toLocation }) => {
    const path = toLocation.pathname;
    // Filters and searches change the address, not the page.
    if (path === last) return;
    if (last === null) add('open', pageOf(path));
    last = path;
    page = pageOf(path);
    add('view', page);
  });
  document.addEventListener(
    'click',
    (e) => {
      if (e.target instanceof Element && e.target.closest('a, button, summary, [role="button"]')) add('click', page);
    },
    { capture: true, passive: true },
  );
  window.setInterval(flush, FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
