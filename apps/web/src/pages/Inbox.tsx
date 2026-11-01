import { formatDay, formatPrice, formatTime, type InboxResponse, type ScoredItem, type UserState } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight, Clock, Heart, HelpCircle, MapPin, Ticket, Undo2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryChip } from '@/components/CategoryChip';
import { hatchAngle } from '@/components/EventRow';
import { ScoreBox, WhyThis } from '@/components/Score';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/utils';

type Range = 'week' | 'all';
const SWIPE_PX = 90;

/** Invite-only: what anonymous visitors see on personal tabs. */
export function SignedOut({ title }: { title: string }) {
  return (
    <EmptyState
      title={title}
      action={
        <Button asChild>
          <Link to="/">Browse all events</Link>
        </Button>
      }
    >
      Personal picks are for invited people. The site stays open to everyone; ask the owner for a login link to get your
      own ranked inbox.
    </EmptyState>
  );
}

export function InboxPage() {
  const { user, isPending } = useMe();
  if (isPending) return <TopBar right="Inbox" />;
  if (!user) {
    return (
      <>
        <TopBar right="Inbox" />
        <SignedOut title="Your picks land here" />
      </>
    );
  }
  return <Inbox />;
}

function Inbox() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('all');
  const [cursor, setCursor] = useState(0);
  const [undo, setUndo] = useState<string[]>([]);
  const inbox = useQuery({ queryKey: ['inbox', range], queryFn: () => api.inbox(range) });
  const items = inbox.data?.items ?? [];
  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];

  const triage = useMutation({
    mutationFn: ({ slug, state }: { slug: string; state: UserState | null }) => api.setState(slug, { state }),
    onMutate: ({ slug, state }) => {
      // Optimistic: the card leaves at once; the server answer only refreshes counts.
      if (state === null) return;
      qc.setQueryData<InboxResponse>(['inbox', range], (d) =>
        d ? { ...d, items: d.items.filter((i) => i.slug !== slug), done: d.done + 1 } : d,
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['agenda'] });
    },
  });

  const act = useCallback(
    (state: UserState) => {
      if (!current) return;
      triage.mutate({ slug: current.slug, state });
      setUndo((u) => [...u, current.slug].slice(-20));
    },
    [current, triage],
  );
  const undoLast = useCallback(() => {
    const slug = undo.at(-1);
    if (!slug) return;
    setUndo((u) => u.slice(0, -1));
    setCursor(0);
    triage.mutate({ slug, state: null });
  }, [undo, triage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, [role=dialog]'))
        return;
      const keys: Record<string, () => void> = {
        j: () => setCursor((c) => Math.min(c + 1, Math.max(0, items.length - 1))),
        k: () => setCursor((c) => Math.max(c - 1, 0)),
        i: () => act('interested'),
        m: () => act('maybe'),
        x: () => act('skipped'),
        h: () => act('hidden'),
        u: undoLast,
        Enter: () => current && void navigate({ to: '/e/$slug', params: { slug: current.slug } }),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, undoLast, current, items.length, navigate]);

  const total = inbox.data?.total ?? 0;
  const done = inbox.data?.done ?? 0;
  const segments = Array.from({ length: 10 }, (_, i) => i < Math.round((done / Math.max(total, 1)) * 10));

  const head = (
    <TopBar right="Inbox">
      <div className="flex items-end justify-between gap-3 pb-3">
        <div>
          <div className="eyebrow tabular-nums" aria-live="polite">
            {total ? `${Math.min(done + 1, total)} of ${total}` : '0 of 0'}
          </div>
          <div className="mt-2 flex w-[150px] gap-0.5" aria-hidden>
            {segments.map((on, i) => (
              <span key={i} className={cn('h-2 flex-1 border border-ink', on ? 'bg-ink' : 'bg-surface')} />
            ))}
          </div>
        </div>
        <div className="flex gap-2" role="group" aria-label="Range">
          {(['week', 'all'] as const).map((r) => (
            <Button
              key={r}
              size="sm"
              aria-pressed={range === r}
              onClick={() => {
                setRange(r);
                setCursor(0);
              }}
            >
              {r === 'week' ? 'Next 7 days' : 'All'}
            </Button>
          ))}
        </div>
      </div>
    </TopBar>
  );

  if (inbox.isPending)
    return (
      <>
        {head}
        <ListSkeleton />
      </>
    );
  if (inbox.isError)
    return (
      <>
        {head}
        <ErrorState message={inbox.error.message} onRetry={() => inbox.refetch()} />
      </>
    );

  if (!current) {
    const pending = inbox.data.pending;
    return (
      <>
        {head}
        {!inbox.data.hasTaste && total === 0 ? (
          <EmptyState
            title="Tell us what you like"
            action={
              <Button asChild variant="default">
                <Link to="/me">Describe your taste</Link>
              </Button>
            }
          >
            A sentence or two is enough, in your own words. Every upcoming event is then ranked for you.
          </EmptyState>
        ) : total === 0 && pending > 0 ? (
          <EmptyState title="Ranking events for you">
            {pending} events are being scored against your taste. This takes a minute or two after you save your taste
            or new events arrive.
          </EmptyState>
        ) : total === 0 ? (
          <EmptyState
            title="Tell us what you like"
            action={
              <Button asChild variant="default">
                <Link to="/me">Describe your taste</Link>
              </Button>
            }
          >
            A sentence or two is enough, in your own words. Every upcoming event is then ranked for you.
          </EmptyState>
        ) : (
          <EmptyState
            title="Inbox done"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant="default">
                  <Link to="/agenda">Open Agenda</Link>
                </Button>
                <Button asChild>
                  <Link to="/">Browse all</Link>
                </Button>
                {undo.length > 0 && (
                  <Button variant="ghost" onClick={undoLast}>
                    <Undo2 aria-hidden />
                    Undo
                  </Button>
                )}
              </div>
            }
          >
            You have sorted all {total} picks. New events land here ranked by your taste as sources update.
          </EmptyState>
        )}
      </>
    );
  }

  const next = items.slice(cursor + 1, cursor + 4);
  return (
    <InboxCard slug={current.slug}>
      {head}
      <Deck
        key={current.slug}
        item={current}
        onAct={act}
        onOpen={() => void navigate({ to: '/e/$slug', params: { slug: current.slug } })}
      />
      <div className="kbd-help mt-2.5 hidden flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-sub">
        <span>
          <kbd>j</kbd>
          <kbd>k</kbd> next / previous
        </span>
        <span>
          <kbd>i</kbd> interested
        </span>
        <span>
          <kbd>m</kbd> maybe
        </span>
        <span>
          <kbd>x</kbd> skip
        </span>
        <span>
          <kbd>h</kbd> hide
        </span>
        <span>
          <kbd>u</kbd> undo
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
      </div>
      {undo.length > 0 && (
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={undoLast}>
            <Undo2 aria-hidden />
            Undo
          </Button>
        </div>
      )}
      {next.length > 0 && (
        <>
          <div className="mt-5 mb-2 text-xs font-extrabold tracking-[.1em] text-sub uppercase">Up next</div>
          <section className="border border-ink bg-surface-a">
            {next.map((n) => (
              <Link
                key={n.slug}
                to="/e/$slug"
                params={{ slug: n.slug }}
                className="flex min-h-16 items-center gap-3 border-b border-line px-3 py-2 text-ink no-underline last:border-b-0"
              >
                <ScoreBox score={n.score} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15.5px] leading-5 font-bold">{n.title}</div>
                  <div className="mt-[3px] truncate text-[12.5px] text-sub tabular-nums">
                    <b className="text-ink">{formatTime(n.next.startLocal)}</b> · {formatDay(n.next.startLocal)}
                    {n.venueName ? ` · ${n.venueName}` : ''}
                  </div>
                </div>
                <CategoryChip category={n.category} className="w-[88px] shrink-0" />
              </Link>
            ))}
          </section>
        </>
      )}
    </InboxCard>
  );
}

/** Scrolls back to the top when the next card comes in, so its score and title are in view. */
function InboxCard({ slug, children }: { slug: string; children: ReactNode }) {
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [slug]);
  return <>{children}</>;
}

/** The current card. Drag right for interested, left for skip; buttons and keys do the same. */
function Deck({ item, onAct, onOpen }: { item: ScoredItem; onAct: (s: UserState) => void; onOpen: () => void }) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const price = formatPrice(item);

  const down = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const move = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const x = e.clientX - s.x;
    if (Math.abs(x) > 8 && Math.abs(x) > Math.abs(e.clientY - s.y)) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDx(x);
    }
  };
  const up = () => {
    start.current = null;
    if (dx > SWIPE_PX) onAct('interested');
    else if (dx < -SWIPE_PX) onAct('skipped');
    setDx(0);
  };

  return (
    <div className="relative">
      <div
        className="absolute inset-0 flex items-center justify-between px-5 text-[13px] font-extrabold tracking-[.08em] uppercase"
        aria-hidden
      >
        <span className="flex items-center gap-1.5 text-moss">
          <Heart className="size-[18px]" strokeWidth={2} /> Interested
        </span>
        <span className="flex items-center gap-1.5 text-danger">
          Skip <X className="size-[18px]" strokeWidth={2} />
        </span>
      </div>
      <article
        aria-label={item.title}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={cn(
          'relative touch-pan-y border border-ink bg-surface select-none',
          dx === 0 && 'transition-transform duration-150',
        )}
        style={{ transform: dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined }}
      >
        <span
          className="absolute top-[18px] left-4 border-2 bg-surface px-2.5 py-1 text-sm font-extrabold tracking-[.1em] text-moss uppercase"
          style={{ opacity: Math.max(0, Math.min(1, dx / SWIPE_PX)) }}
          aria-hidden
        >
          Interested
        </span>
        <span
          className="absolute top-[18px] right-4 border-2 bg-surface px-2.5 py-1 text-sm font-extrabold tracking-[.1em] text-danger uppercase"
          style={{ opacity: Math.max(0, Math.min(1, -dx / SWIPE_PX)) }}
          aria-hidden
        >
          Skip
        </span>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 p-4">
          <WhyThis score={item.score} reasons={item.reasons} />
          <div className="flex items-start gap-3">
            <div
              className="hatch h-[84px] w-16 shrink-0"
              style={{ ['--hatch-angle' as string]: hatchAngle(item.slug) }}
            />
            <div className="grid min-w-0 gap-2">
              <h2
                lang={item.lang}
                className="m-0 text-[26px] leading-[1.12] font-extrabold tracking-tight text-balance hyphens-auto [overflow-wrap:anywhere]"
              >
                {item.title}
              </h2>
              <div>
                <CategoryChip category={item.category} />
              </div>
            </div>
          </div>
          <div className="grid gap-1.5 text-sm text-sub">
            <div className="flex items-center gap-2">
              <Clock className="size-[18px] shrink-0" aria-hidden />
              <span className="tabular-nums">
                <b className="text-ink">
                  {formatDay(item.next.startLocal)} · {formatTime(item.next.startLocal)}
                </b>
                {item.moreDates > 0 && ` (+${item.moreDates} dates)`}
              </span>
            </div>
            {item.venueName && (
              <div className="flex items-center gap-2">
                <MapPin className="size-[18px] shrink-0" aria-hidden />
                <span>
                  <b className="text-ink">{item.venueName}</b>
                  {item.district ? ` · ${item.district}` : ''}
                </span>
              </div>
            )}
            {price && (
              <div className="flex items-center gap-2">
                <Ticket className="size-[18px] shrink-0" aria-hidden />
                <b className="text-ink tabular-nums">{price}</b>
              </div>
            )}
          </div>
          <Button className="justify-self-start" onClick={onOpen}>
            Details
            <ChevronRight aria-hidden />
            <kbd>↵</kbd>
          </Button>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-2 px-4 pb-4 [&>button]:min-w-0 [&>button]:px-2">
          <Button size="lg" className="min-h-14" onClick={() => onAct('skipped')}>
            <X strokeWidth={2} aria-hidden />
            Skip
            <kbd>x</kbd>
          </Button>
          <Button size="lg" className="min-h-14" onClick={() => onAct('maybe')}>
            <HelpCircle aria-hidden />
            Maybe
            <kbd>m</kbd>
          </Button>
          <Button size="lg" variant="default" className="min-h-14" onClick={() => onAct('interested')}>
            <Heart strokeWidth={2} aria-hidden />
            Interested
            <kbd>i</kbd>
          </Button>
        </div>
      </article>
    </div>
  );
}
