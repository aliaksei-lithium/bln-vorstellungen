import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { ChevronLeft, ExternalLink, MapPin } from 'lucide-react';
import { useMemo } from 'react';
import { EventRow } from '@/components/EventRow';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { useMyStates } from '@/lib/marks';

/** One venue's programme: where it is, then every upcoming event there by day. */
export function VenuePage({ id }: { id: string }) {
  const router = useRouter();
  const venue = useQuery({ queryKey: ['venue', id], queryFn: () => api.venue(id) });
  const events = useInfiniteQuery({
    queryKey: ['events', { venue: id }],
    queryFn: ({ pageParam }) => api.events({ venue: id, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Someone who opens a venue wants its programme, so source and category switches do not apply here; events they
  // hid stay out (opt-in categories are left out by the server, as everywhere).
  const { states } = useMyStates();
  const items = useMemo(
    () => (events.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => states[i.slug] !== 'hidden'),
    [events.data, states],
  );

  const head = (
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-2 grid h-14 grid-cols-[44px_1fr_44px] items-center bg-background">
      <Button variant="ghost" size="icon" aria-label="Back" onClick={() => router.history.back()}>
        <ChevronLeft className="size-[26px]" aria-hidden />
      </Button>
      <h1 className="text-center text-base font-extrabold tracking-[.06em] uppercase">Venue</h1>
    </div>
  );

  if (venue.isPending) {
    return (
      <>
        {head}
        <ListSkeleton />
      </>
    );
  }
  if (venue.isError) {
    return (
      <>
        {head}
        {venue.error instanceof ApiError && venue.error.status === 404 ? (
          <EmptyState
            title="No such venue"
            action={
              <Button asChild>
                <Link to="/">Browse events</Link>
              </Button>
            }
          >
            It may have been merged into another one.
          </EmptyState>
        ) : (
          <ErrorState message={venue.error.message} onRetry={() => venue.refetch()} />
        )}
      </>
    );
  }

  const v = venue.data;
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address ?? ''} Berlin`)}`;
  return (
    <>
      {head}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <section className="grid gap-2.5 border border-ink bg-surface p-3">
          <div>
            <h2 className="m-0 text-[28px] leading-[1.1] font-extrabold tracking-tight text-balance">{v.name}</h2>
            <p className="mt-1 mb-0 text-sm text-sub">
              {[v.address, v.district].filter(Boolean).join(' · ')}
              {v.address || v.district ? ' · ' : ''}
              {v.upcoming === 1 ? '1 upcoming event' : `${v.upcoming} upcoming events`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={maps} target="_blank" rel="noopener noreferrer">
                <MapPin aria-hidden />
                Open in maps
              </a>
            </Button>
            {v.url && (
              <Button asChild>
                <a href={v.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden />
                  Venue site
                </a>
              </Button>
            )}
          </div>
        </section>
        {events.isPending ? (
          <ListSkeleton />
        ) : events.isError ? (
          <ErrorState message={events.error.message} onRetry={() => events.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing coming up here">
            No upcoming events at {v.name} in the programme right now.
          </EmptyState>
        ) : (
          <section className="border border-ink bg-surface" aria-label="Upcoming">
            <div className="flex h-8 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.08em] text-on-ink uppercase">
              <span>Upcoming</span>
              <span className="tabular-nums">{v.upcoming}</span>
            </div>
            {items.map((it) => (
              <EventRow key={it.slug} item={it} showDay />
            ))}
          </section>
        )}
        {events.hasNextPage && (
          <Button
            size="lg"
            className="w-full bg-surface"
            disabled={events.isFetchingNextPage}
            onClick={() => events.fetchNextPage()}
          >
            {events.isFetchingNextPage ? 'Loading…' : 'Show more events'}
          </Button>
        )}
      </div>
    </>
  );
}
