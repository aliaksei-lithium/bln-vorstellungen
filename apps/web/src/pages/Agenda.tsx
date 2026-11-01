import { clashes, formatDay, formatPrice, formatTime } from '@bln/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CalendarDays, Copy, Heart, HelpCircle } from 'lucide-react';
import { useState } from 'react';
import { TopBar } from '@/components/AppShell';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { relativeDay } from '@/lib/dates';
import { SignedOut } from './Inbox';

type Tab = 'all' | 'interested' | 'maybe';

export function AgendaPage() {
  const { user, isPending } = useMe();
  if (isPending) return <TopBar right="Agenda" />;
  if (!user) {
    return (
      <>
        <TopBar right="Agenda" />
        <SignedOut title="Nothing planned yet" />
      </>
    );
  }
  return <Agenda />;
}

function Agenda() {
  const [tab, setTab] = useState<Tab>('all');
  const [calUrl, setCalUrl] = useState<string | null>(null);
  const agenda = useQuery({ queryKey: ['agenda'], queryFn: api.agenda });
  const subscribe = useMutation({ mutationFn: api.calendarLink, onSuccess: (r) => setCalUrl(r.url) });

  const items = agenda.data?.items ?? [];
  const clash = clashes(items);
  const shown = items.filter((a) => tab === 'all' || a.state === tab);
  const days = [...new Set(shown.map((a) => a.startLocal.slice(0, 10)))];
  const going = items.filter((a) => a.state === 'interested').length;

  return (
    <>
      <TopBar right="Agenda">
        <div className="flex flex-wrap justify-between gap-2 pb-3">
          <div className="flex gap-2" role="group" aria-label="Show">
            {(
              [
                ['all', 'All', items.length],
                ['interested', 'Going', going],
                ['maybe', 'Maybe', items.length - going],
              ] as const
            ).map(([v, l, n]) => (
              <Button key={v} size="sm" aria-pressed={tab === v} onClick={() => setTab(v)}>
                {l} <span className="tabular-nums">{n}</span>
              </Button>
            ))}
          </div>
          <Button size="sm" variant="default" disabled={subscribe.isPending} onClick={() => subscribe.mutate()}>
            <CalendarDays aria-hidden />
            Subscribe
          </Button>
        </div>
      </TopBar>

      {agenda.isPending ? (
        <ListSkeleton />
      ) : agenda.isError ? (
        <ErrorState message={agenda.error.message} onRetry={() => agenda.refetch()} />
      ) : days.length === 0 ? (
        <EmptyState
          title="Nothing planned yet"
          action={
            <Button asChild variant="default">
              <Link to="/inbox">Open Inbox</Link>
            </Button>
          }
        >
          Mark events as interested or maybe in your Inbox and they show up here by day.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {days.map((day) => {
            const its = shown.filter((a) => a.startLocal.startsWith(day));
            return (
              <section key={day} className="border border-ink bg-surface-a" aria-label={formatDay(`${day}T00:00`)}>
                <div className="flex h-8 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.08em] text-on-ink uppercase">
                  <span className="tabular-nums">
                    {formatDay(`${day}T00:00`)}
                    {relativeDay(day) && ` · ${relativeDay(day)}`}
                  </span>
                  <span className="tabular-nums">{its.length}</span>
                </div>
                {its.map((a) => (
                  <Link
                    key={a.occurrenceId}
                    to="/e/$slug"
                    params={{ slug: a.slug }}
                    className="flex min-h-16 items-center gap-3 border-b border-line px-3 py-2 text-ink no-underline last:border-b-0"
                  >
                    <div className="w-[52px] shrink-0 text-base font-extrabold tabular-nums">
                      {formatTime(a.startLocal, a.category)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15.5px] leading-5 font-bold">{a.title}</div>
                      <div className="mt-[3px] truncate text-[12.5px] text-sub">{a.venueName}</div>
                      {clash.has(a.occurrenceId) && (
                        <div className="mt-1.5 inline-flex items-center gap-1 border border-danger px-1.5 py-0.5 text-[11.5px] font-bold text-danger">
                          <AlertTriangle className="size-3" strokeWidth={2.2} aria-hidden />
                          Clash with {clash.get(a.occurrenceId)}
                        </div>
                      )}
                    </div>
                    <div className="grid shrink-0 justify-items-end gap-1">
                      {a.state === 'interested' ? (
                        <span className="inline-flex items-center gap-1 bg-moss px-1.5 py-0.5 text-[11px] font-extrabold tracking-[.06em] text-on-moss uppercase">
                          <Heart className="size-3" strokeWidth={2.4} aria-hidden />
                          Going
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 border border-ink px-1.5 py-0.5 text-[11px] font-extrabold tracking-[.06em] uppercase">
                          <HelpCircle className="size-3" strokeWidth={2.4} aria-hidden />
                          Maybe
                        </span>
                      )}
                      <span className="text-[13px] font-bold tabular-nums">{formatPrice(a) ?? ''}</span>
                    </div>
                  </Link>
                ))}
              </section>
            );
          })}
        </div>
      )}

      <Sheet open={calUrl !== null} onOpenChange={(o) => !o && setCalUrl(null)}>
        <SheetContent side="bottom" className="mx-auto max-w-[600px] border-x border-ink">
          <SheetHeader>
            <SheetTitle>Subscribe in your calendar</SheetTitle>
            <SheetDescription className="text-[15px] leading-5">
              Add this address as a calendar subscription (Google Calendar: Other calendars → From URL; Apple Calendar:
              File → New Calendar Subscription). It stays private: anyone with the link sees your agenda, so making a
              new one switches the old one off.
            </SheetDescription>
          </SheetHeader>
          {calUrl && (
            <CopyField
              value={calUrl}
              openHref={calUrl.replace(/^https?:/, 'webcal:')}
              openLabel="Open in calendar app"
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

export function CopyField({ value, openHref, openLabel }: { value: string; openHref?: string; openLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-4 mb-6 grid gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="h-11 w-full border border-ink bg-surface px-3 text-sm"
        aria-label="Link"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          <Copy aria-hidden />
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        {openHref && (
          <Button asChild>
            <a href={openHref}>{openLabel}</a>
          </Button>
        )}
      </div>
    </div>
  );
}
