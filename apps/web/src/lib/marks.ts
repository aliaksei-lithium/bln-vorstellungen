import type { Category, MyStates, UserState } from '@bln/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from './api';
import { useMe } from './auth';
import { toast } from './toast';
import { useVisitorSources } from './visitorSources';

/** The signed-in user's marks by slug, shared by every list row (one small request, cached). */
export function useMyStates() {
  const { user } = useMe();
  const q = useQuery({ queryKey: ['states'], queryFn: api.states, enabled: !!user, staleTime: 60_000 });
  return { signedIn: !!user, states: q.data?.states ?? {} };
}

const MESSAGES: Record<UserState, string> = {
  interested: 'Added to Agenda',
  maybe: 'Saved as maybe',
  skipped: 'Skipped. It won’t come back to your Inbox',
  hidden: 'Hidden',
  went: 'Marked as went',
};

/**
 * Marks an event from a list row: updates the rows at once, saves, refreshes the views that show marks, and offers
 * Undo, which puts back the previous mark.
 */
export function useMark() {
  const qc = useQueryClient();
  const save = useCallback(
    async (slug: string, state: UserState | null) => {
      qc.setQueryData<MyStates>(['states'], (d) => {
        const states = { ...d?.states };
        if (state) states[slug] = state;
        else delete states[slug];
        return { states };
      });
      try {
        await api.setState(slug, { state });
      } catch {
        toast('Could not save that. Check your connection and try again.');
      }
      void qc.invalidateQueries({ queryKey: ['states'] });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['my-event', slug] });
    },
    [qc],
  );
  return useCallback(
    (slug: string, state: UserState | null, opts: { message?: string; prev?: UserState | null } = {}) => {
      const prev = opts.prev !== undefined ? opts.prev : (qc.getQueryData<MyStates>(['states'])?.states[slug] ?? null);
      void save(slug, state);
      toast(opts.message ?? (state ? MESSAGES[state] : 'Removed from Agenda'), () => void save(slug, prev));
    },
    [qc, save],
  );
}

/**
 * Whether a list row shows for this user: never an event they hid, not a category they switched off on the Me page
 * (unless they picked that category in the filter themselves), and not an event all of whose sources they switched
 * off. Signed out, only the source switches apply, kept in this browser.
 */
export function useListFilter(picked: Category[] = []) {
  const { signedIn, states } = useMyStates();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile, enabled: signedIn, staleTime: 60_000 });
  const off = profile.data?.prefs.categoriesOff ?? [];
  const visitor = useVisitorSources(!signedIn);
  const srcOff = signedIn ? (profile.data?.prefs.sourcesOff ?? []) : visitor.off;
  return useCallback(
    (e: { slug: string; category: Category; sources?: string[] }) =>
      states[e.slug] !== 'hidden' &&
      (picked.includes(e.category) || !off.includes(e.category)) &&
      !(e.sources?.length && e.sources.every((s) => srcOff.includes(s))),
    [states, off, srcOff, picked],
  );
}
