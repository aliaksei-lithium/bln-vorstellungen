import { formatDateTime, utcToBerlinLocal, type ScanListItem } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { ChevronLeft, Loader2, Trash2, Type } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * "Your scans" (docs/09, 2026-11-03): every photo and text the user had read, newest first. A scan is read in the
 * background, so one can be started, left, and reviewed from here later; each can be opened, read again from its
 * review page, or deleted with its photo.
 */
export function ScansPage() {
  const router = useRouter();
  const { user, isPending } = useMe();
  const scans = useQuery({
    queryKey: ['scans'],
    queryFn: api.scans,
    enabled: !!user,
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'queued' || s.status === 'reading') ? 3000 : false),
  });

  return (
    <>
      <div className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-2 grid h-14 grid-cols-[44px_1fr_44px] items-center bg-background">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={() => router.history.back()}>
          <ChevronLeft className="size-[26px]" aria-hidden />
        </Button>
        <h1 className="text-center text-base font-extrabold tracking-[.06em] uppercase">Your scans</h1>
      </div>
      {!isPending && !user ? (
        <EmptyState title="Sign in to see your scans">Scans belong to the account that made them.</EmptyState>
      ) : scans.isError ? (
        <EmptyState
          title="Couldn’t load your scans"
          action={<Button onClick={() => scans.refetch()}>Try again</Button>}
        >
          {scans.error.message}
        </EmptyState>
      ) : !scans.data ? (
        <p className="flex items-center gap-2 text-sm text-sub">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </p>
      ) : !scans.data.length ? (
        <EmptyState title="No scans yet">
          Photograph a poster or a magazine page with the + button. It is read in the background and waits here.
        </EmptyState>
      ) : (
        <section className="border border-ink bg-surface">
          {scans.data.map((s) => (
            <Row key={s.id} scan={s} />
          ))}
        </section>
      )}
    </>
  );
}

function status(s: ScanListItem): { label: string; tone: 'busy' | 'todo' | 'done' | 'bad' } {
  if (s.status === 'queued' || s.status === 'reading') return { label: 'Reading…', tone: 'busy' };
  if (s.status === 'failed') return { label: 'Couldn’t read', tone: 'bad' };
  if (s.status === 'done') return { label: `Added ${s.added ?? 0}`, tone: 'done' };
  return s.found ? { label: `${s.found} to review`, tone: 'todo' } : { label: 'Nothing upcoming found', tone: 'bad' };
}

function Row({ scan }: { scan: ScanListItem }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const drop = useMutation({
    mutationFn: () => api.deleteScan(scan.id),
    onSuccess: () => {
      qc.setQueryData<ScanListItem[]>(['scans'], (list) => list?.filter((s) => s.id !== scan.id));
      qc.removeQueries({ queryKey: ['scan', scan.id] });
      toast('Scan deleted');
    },
    onError: (err) => toast(err.message),
  });
  const st = status(scan);
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-3 p-3">
        <Link
          to="/scan/$id"
          params={{ id: scan.id }}
          className="flex min-w-0 flex-1 items-center gap-3 text-ink no-underline"
        >
          {scan.kind === 'photo' ? (
            <img
              src={`/api/me/scans/${scan.id}/image`}
              alt=""
              loading="lazy"
              className="size-14 shrink-0 border border-ink object-cover"
            />
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center border border-ink bg-background">
              <Type className="size-6 text-sub" aria-hidden />
            </span>
          )}
          <span className="grid min-w-0 gap-0.5">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-xs font-extrabold tracking-[.08em] uppercase',
                st.tone === 'todo' ? 'text-moss' : st.tone === 'bad' ? 'text-danger' : 'text-sub',
              )}
            >
              {st.tone === 'busy' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {st.label}
            </span>
            <span className="line-clamp-2 font-bold">
              {scan.preview ?? (scan.kind === 'photo' ? 'Photo' : 'Pasted text')}
            </span>
            <span className="text-sm text-sub">{formatDateTime(utcToBerlinLocal(scan.createdAt))}</span>
          </span>
        </Link>
        {!confirming && (
          <Button variant="ghost" size="icon" aria-label="Delete scan" onClick={() => setConfirming(true)}>
            <Trash2 className="size-5" aria-hidden />
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-background px-3 py-2.5">
          <span className="min-w-48 flex-1 text-sm">
            Delete this scan{scan.kind === 'photo' ? ' and its photo' : ''}?
            {scan.status === 'done' ? ' Events you added stay.' : ''}
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button size="sm" variant="dark" disabled={drop.isPending} onClick={() => drop.mutate()}>
              {drop.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
