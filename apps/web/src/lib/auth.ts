import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** The signed-in user, or null for anonymous visitors (the default; the public site needs no account). */
export function useMe() {
  const q = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });
  return { user: q.data?.user ?? null, isPending: q.isPending };
}
