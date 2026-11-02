import type { Category } from '@bln/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Source switches for visitors (docs/09, 2026-11-02): kept in this browser, not on an account. Until a visitor
 * touches one, the site's defaults apply (a few venues start off). Signed-in users use prefs.sourcesOff instead.
 */

const KEY = 'bln.sourcesOff';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener('storage', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', fn);
  };
}

function parse(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function useVisitorSources(enabled = true) {
  const sources = useQuery({ queryKey: ['public-sources'], queryFn: api.publicSources, enabled, staleTime: 300_000 });
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const defaults = sources.data?.sources.filter((s) => s.defaultOff).map((s) => s.id) ?? [];
  const off = parse(raw) ?? defaults;
  const set = useCallback(
    (id: string, on: boolean) => {
      const next = on ? off.filter((s) => s !== id) : [...new Set([...off, id])];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked (private mode): the switch still holds until the page reloads.
      }
      listeners.forEach((fn) => fn());
    },
    [off],
  );
  // Ready once the visitor's own switches or the site's defaults are known (an error falls back to none off).
  const ready = raw != null || !sources.isPending || !enabled;
  return { sources, off, set, ready };
}

const OPT_IN_KEY = 'bln.categoriesOn';
const readOptIn = () => {
  try {
    return localStorage.getItem(OPT_IN_KEY);
  } catch {
    return null;
  }
};

/** Opt-in categories (sex-positive and kink) a visitor switched on in this browser; none by default. */
export function useVisitorOptIn() {
  const raw = useSyncExternalStore(subscribe, readOptIn, () => null);
  const on = (parse(raw) ?? []) as Category[];
  const set = useCallback(
    (c: Category, value: boolean) => {
      const next = value ? [...new Set([...on, c])] : on.filter((x) => x !== c);
      try {
        localStorage.setItem(OPT_IN_KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: holds until the page reloads.
      }
      listeners.forEach((fn) => fn());
    },
    [on],
  );
  return { on, set };
}
