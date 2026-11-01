import { CATEGORY_LABELS, formatDay, formatPrice, formatTime, type MyEvent, type UserState } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  EyeOff,
  ExternalLink,
  Heart,
  HelpCircle,
  MapPin,
  Plus,
  Ticket,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CategoryChip } from '@/components/CategoryChip';
import { EventRow, hatchAngle } from '@/components/EventRow';
import { WhyThis } from '@/components/Score';
import { EmptyState, ErrorState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useListFilter } from '@/lib/marks';
import { relativeDay } from '@/lib/dates';
import { cn } from '@/lib/utils';

function Box({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-ink bg-surface">
      <div className="flex h-9 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function EventPage({ slug }: { slug: string }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const ev = useQuery({ queryKey: ['event', slug], queryFn: () => api.event(slug) });
  const { user } = useMe();
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['my-event', slug], queryFn: () => api.myEvent(slug), enabled: !!user });
  const mark = useMutation({
    mutationFn: (u: { state: UserState | null; occurrenceId?: string }) => api.setState(slug, u),
    onMutate: (u) =>
      qc.setQueryData<MyEvent>(['my-event', slug], (d) =>
        d ? { ...d, state: u.state, occurrenceId: u.occurrenceId ?? (u.state ? d.occurrenceId : null) } : d,
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['my-event', slug] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
    },
  });
  const my = mine.data;

  const head = (
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-2 grid h-14 grid-cols-[44px_1fr_44px] items-center bg-background">
      <Button variant="ghost" size="icon" aria-label="Back" onClick={() => router.history.back()}>
        <ChevronLeft className="size-[26px]" aria-hidden />
      </Button>
      <h1 className="text-center text-base font-extrabold tracking-[.06em] uppercase">Event</h1>
    </div>
  );

  if (ev.isPending)
    return (
      <>
        {head}
        <div className="hatch h-40 animate-pulse border border-ink" />
      </>
    );
  if (ev.isError) {
    return (
      <>
        {head}
        {ev.error instanceof ApiError && ev.error.status === 404 ? (
          <EmptyState
            title="This event is gone"
            action={
              <Button asChild>
                <Link to="/">Browse events</Link>
              </Button>
            }
          >
            It may have been cancelled or merged into another listing.
          </EmptyState>
        ) : (
          <ErrorState message={ev.error.message} onRetry={() => ev.refetch()} />
        )}
      </>
    );
  }

  const e = ev.data;
  const now = new Date().toISOString();
  const upcoming = e.occurrences.filter((o) => o.startUtc >= now);
  const dates = showAll ? upcoming : upcoming.slice(0, 5);
  const price = formatPrice(e);
  const v = e.venue;
  const maps =
    v && `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name} ${v.address ?? ''} Berlin`)}`;

  return (
    <>
      {head}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div
          className="hatch flex h-40 items-end border border-ink p-2.5"
          style={{ ['--hatch-angle' as string]: hatchAngle(e.slug) }}
          role="img"
          aria-label="No image yet"
        >
          <CategoryChip category={e.category} className="bg-surface" />
        </div>
        <div className="grid gap-1.5">
          <h2
            lang={e.lang === 'other' ? undefined : e.lang}
            className="text-[30px] leading-[1.08] font-extrabold tracking-tight text-balance hyphens-auto [overflow-wrap:anywhere]"
          >
            {e.title}
          </h2>
          <p className="text-sm text-sub">
            {[v?.name, e.lang === 'de' ? 'In German' : e.lang === 'en' ? 'In English' : null, price]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        {my && (
          <section className="border border-ink bg-surface">
            {my.score !== null && (
              <div className="border-b border-line p-3">
                <WhyThis score={my.score} reasons={my.reasons} />
              </div>
            )}
            <div className="grid grid-cols-4 gap-1.5 p-2" role="group" aria-label="Your choice">
              {(
                [
                  ['interested', 'Interested', Heart],
                  ['maybe', 'Maybe', HelpCircle],
                  ['skipped', 'Skip', X],
                  ['hidden', 'Hide', EyeOff],
                ] as const
              ).map(([state, label, Icon]) => {
                const on = my.state === state;
                return (
                  <Button
                    key={state}
                    size="sm"
                    variant={on && state === 'interested' ? 'default' : 'outline'}
                    aria-pressed={on}
                    className="min-h-11 flex-col gap-0.5 px-1 text-[12px]"
                    onClick={() => mark.mutate({ state: on ? null : state })}
                  >
                    <Icon className="size-[18px]" strokeWidth={on ? 2.4 : 1.75} aria-hidden />
                    {label}
                  </Button>
                );
              })}
            </div>
          </section>
        )}

        <Box title="Dates" right={<span className="tabular-nums">{upcoming.length}</span>}>
          {dates.length === 0 && <p className="p-3 text-sub">No upcoming dates.</p>}
          {dates.map((o) => {
            const day = o.startLocal.slice(0, 10);
            // With no date picked, the agenda uses the next one.
            const inAgenda =
              !!my &&
              (my.state === 'interested' || my.state === 'maybe') &&
              (my.occurrenceId ? my.occurrenceId === o.id : o.id === upcoming[0]?.id);
            return (
              <div
                key={o.id}
                className="flex min-h-12 items-center justify-between gap-2.5 border-b border-line px-3 tabular-nums last:border-b-0"
              >
                <span>
                  <b>{formatDay(o.startLocal)}</b>
                  {formatTime(o.startLocal, e.category) && ` · ${formatTime(o.startLocal, e.category)}`}
                  {relativeDay(day) && <span className="text-sub"> · {relativeDay(day)}</span>}
                </span>
                {o.status !== 'scheduled' ? (
                  <span className="text-xs font-extrabold tracking-[.05em] text-warn uppercase">
                    {o.status === 'sold_out' ? 'Sold out' : 'Cancelled'}
                  </span>
                ) : (
                  my && (
                    <Button
                      size="sm"
                      variant={inAgenda ? 'default' : 'outline'}
                      aria-pressed={inAgenda}
                      className={cn('shrink-0', inAgenda && 'pointer-events-none')}
                      onClick={() =>
                        mark.mutate({
                          state: my.state === 'interested' || my.state === 'maybe' ? my.state : 'interested',
                          occurrenceId: o.id,
                        })
                      }
                    >
                      {inAgenda ? (
                        <>
                          <Check strokeWidth={2.4} aria-hidden />
                          In agenda
                        </>
                      ) : (
                        <>
                          <Plus strokeWidth={2} aria-hidden />
                          This date
                        </>
                      )}
                    </Button>
                  )
                )}
              </div>
            );
          })}
          {upcoming.length > 5 && (
            <div className="px-1 py-1">
              <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                {showAll ? 'Show fewer' : `Show all ${upcoming.length} dates`}
                <ChevronDown className={showAll ? 'rotate-180' : ''} aria-hidden />
              </Button>
            </div>
          )}
        </Box>

        {v && (
          <Box title="Venue">
            <div className="grid gap-2.5 p-3">
              <div>
                <div className="text-[17px] font-extrabold">{v.name}</div>
                <div className="text-sm text-sub">{[v.address, v.district].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {maps && (
                  <Button asChild>
                    <a href={maps} target="_blank" rel="noopener noreferrer">
                      <MapPin aria-hidden />
                      Open in maps
                    </a>
                  </Button>
                )}
                {v.url && (
                  <Button asChild>
                    <a href={v.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink aria-hidden />
                      Venue site
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </Box>
        )}

        <Box title="Details">
          <dl className="grid grid-cols-[96px_1fr] gap-2 p-3 text-[14.5px]">
            {e.performers.length > 0 && (
              <>
                <dt className="pt-0.5 text-[11.5px] font-extrabold tracking-[.1em] text-sub uppercase">With</dt>
                <dd>{e.performers.map((p) => p.name).join(', ')}</dd>
              </>
            )}
            {price && (
              <>
                <dt className="pt-0.5 text-[11.5px] font-extrabold tracking-[.1em] text-sub uppercase">Price</dt>
                <dd className="tabular-nums">
                  {price}
                  {e.priceNote ? ` · ${e.priceNote}` : ''}
                </dd>
              </>
            )}
            <dt className="pt-0.5 text-[11.5px] font-extrabold tracking-[.1em] text-sub uppercase">Category</dt>
            <dd>{CATEGORY_LABELS[e.category]}</dd>
          </dl>
          {(e.urlOfficial || e.urlTickets) && (
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              {e.urlTickets && (
                <Button asChild variant="default">
                  <a href={e.urlTickets} target="_blank" rel="noopener noreferrer">
                    <Ticket aria-hidden />
                    Tickets
                  </a>
                </Button>
              )}
              {e.urlOfficial && (
                <Button asChild>
                  <a href={e.urlOfficial} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden />
                    Official page
                  </a>
                </Button>
              )}
            </div>
          )}
        </Box>

        {e.description && (
          <Box title="About">
            <p className="p-3 leading-[21px] whitespace-pre-line">{e.description}</p>
          </Box>
        )}

        <Similar slug={slug} />
      </div>
    </>
  );
}

/** "More like this", ranked by embedding similarity. Hidden when there is nothing close enough. */
function Similar({ slug }: { slug: string }) {
  const similar = useQuery({ queryKey: ['similar', slug], queryFn: () => api.similar(slug), retry: false });
  const shows = useListFilter();
  const items = (similar.data?.items ?? []).filter(shows);
  if (!items.length) return null;
  return (
    <section className="border border-ink bg-surface" aria-label="Similar events">
      <div className="flex h-9 items-center bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase">
        More like this
      </div>
      {items.map((it) => (
        <EventRow key={it.slug} item={it} showDay />
      ))}
    </section>
  );
}
