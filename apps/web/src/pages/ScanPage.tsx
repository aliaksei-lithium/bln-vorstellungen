import {
  CATEGORY_LABELS,
  Category,
  actsOf,
  artistKey,
  formatDateTime,
  formatPrice,
  type ExtractedEvent,
  type Scan,
  type ScanInsight,
} from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  ChevronLeft,
  Headphones,
  Info,
  ListMusic,
  Loader2,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { CategoryChip } from '@/components/CategoryChip';
import { ScoreBox } from '@/components/Score';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Review a scan (docs/09, 2026-11-01 "Scans"): what the AI read from a photo or text, one card per event, all
 * ticked. Untick what is wrong, fix what is close, then add. Known events merge instead of duplicating. Events come
 * ranked for the user with genres ("Scan insights"); "More" explains one, "Listen" opens an act on Spotify, and the
 * ticked ones can become a Spotify playlist.
 */

type Draft = ExtractedEvent & { key: number; on: boolean };

export function ScanPage({ id }: { id: string }) {
  const router = useRouter();
  const { user, isPending } = useMe();
  const scan = useQuery({
    queryKey: ['scan', id],
    queryFn: () => api.scan(id),
    enabled: !!user,
    refetchInterval: (q) => (q.state.data && ['queued', 'reading'].includes(q.state.data.status) ? 2000 : false),
  });

  const head = (
    <div className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-2 grid h-14 grid-cols-[44px_1fr_44px] items-center bg-background">
      <Button variant="ghost" size="icon" aria-label="Back" onClick={() => router.history.back()}>
        <ChevronLeft className="size-[26px]" aria-hidden />
      </Button>
      <h1 className="text-center text-base font-extrabold tracking-[.06em] uppercase">Review</h1>
    </div>
  );

  if (!isPending && !user) {
    return (
      <>
        {head}
        <EmptyState title="Sign in to add events">Scans belong to the account that made them.</EmptyState>
      </>
    );
  }
  if (scan.isError) {
    return (
      <>
        {head}
        <EmptyState title="Scan not found">It may belong to another account.</EmptyState>
      </>
    );
  }
  const s = scan.data;
  return (
    <>
      {head}
      {!s || s.status === 'queued' || s.status === 'reading' ? (
        <Reading id={id} kind={s?.kind ?? 'photo'} />
      ) : s.status === 'failed' ? (
        <EmptyState title="Could not read this">
          {s.error ?? 'Try a sharper photo, or paste the text instead.'}
        </EmptyState>
      ) : s.status === 'done' ? (
        <Done scan={s} />
      ) : (
        <Review scan={s} />
      )}
    </>
  );
}

function Photo({ id, className }: { id: string; className?: string }) {
  return (
    <a href={`/api/me/scans/${id}/image`} target="_blank" rel="noreferrer" className="shrink-0">
      <img
        src={`/api/me/scans/${id}/image`}
        alt="Your photo"
        className={cn('w-[72px] border border-ink object-cover', className)}
      />
    </a>
  );
}

function Reading({ id, kind }: { id: string; kind: Scan['kind'] }) {
  return (
    <div className="grid gap-3 border border-ink bg-surface p-3" aria-live="polite">
      <div className="flex gap-3">
        {kind === 'photo' ? <Photo id={id} className="h-24" /> : null}
        <div>
          <div className="flex items-center gap-2 font-extrabold">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            Reading the {kind === 'photo' ? 'photo' : 'text'}…
          </div>
          <p className="mt-1.5 mb-0 text-sm text-sub">
            Finding titles, dates, venues and prices. A poster takes a few seconds, a full listing page up to a minute.
            You can leave this page and come back.
          </p>
        </div>
      </div>
    </div>
  );
}

function Done({ scan }: { scan: Scan }) {
  const r = scan.result!;
  return (
    <div className="grid gap-3">
      <p className="m-0 border border-moss bg-moss-soft p-3 text-sm">
        <b>{r.added}</b> new {r.added === 1 ? 'event' : 'events'} added
        {r.merged > 0 && (
          <>
            , <b>{r.merged}</b> matched {r.merged === 1 ? 'an event' : 'events'} already listed and got their dates
            merged
          </>
        )}
        . They are listed now and ranked for you within a few minutes.
      </p>
      <section className="border border-ink bg-surface">
        {r.events.map((e) => (
          <Link
            key={e.slug}
            to="/e/$slug"
            params={{ slug: e.slug }}
            className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-3 font-bold text-ink no-underline last:border-b-0"
          >
            <span className="truncate">{e.title}</span>
            <span className="shrink-0 text-xs font-extrabold tracking-[.06em] text-sub uppercase">
              {e.created ? 'New' : 'Merged'}
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}

type More = NonNullable<ScanInsight['more']>;
/** The first ranked events worth a "More" note in one go, and how many may go into one playlist. */
const TOP = 5;
const TOP_MIN = 60;
const PLAYLIST_MAX = 25;

const listenHref = (name: string) => `/spotify/listen?artist=${encodeURIComponent(name)}`;

function Review({ scan }: { scan: Scan }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useMe();
  const spotify = useQuery({ queryKey: ['spotify'], queryFn: api.spotify, enabled: !!user });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const ranked = scan.insights.some((i) => i?.score != null);
  const [byTaste, setByTaste] = useState(true);
  const [mores, setMores] = useState<Record<number, More>>(() =>
    Object.fromEntries(scan.insights.flatMap((i, k) => (i?.more ? [[k, i.more]] : []))),
  );
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Set<number>>(new Set());
  useEffect(() => {
    setDrafts(scan.candidates.map((c, key) => ({ ...c, key, on: true })));
  }, [scan.candidates]);

  const scoreOf = (key: number) => scan.insights[key]?.score ?? -1;
  const shown = ranked && byTaste ? [...drafts].sort((a, b) => scoreOf(b.key) - scoreOf(a.key)) : drafts;
  const top = new Set(
    [...drafts]
      .sort((a, b) => scoreOf(b.key) - scoreOf(a.key))
      .filter((d) => scoreOf(d.key) >= TOP_MIN)
      .slice(0, TOP)
      .map((d) => d.key),
  );

  const chosen = drafts.filter((d) => d.on);
  const add = useMutation({
    mutationFn: () =>
      api.confirmScan(scan.id, {
        events: chosen.map(({ key: _k, on: _o, ...e }) => e),
      }),
    onSuccess: (r) => {
      toast(`Added ${r.added} new, merged ${r.merged}`);
      void qc.invalidateQueries({ queryKey: ['scan', scan.id] });
      void qc.invalidateQueries({ queryKey: ['events'] });
    },
  });
  const playlist = useMutation({
    mutationFn: () =>
      api.scanPlaylist(
        scan.id,
        chosen.map((d) => d.key),
      ),
  });
  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const toggle = (set: Set<number>, key: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  /** One note at a time: each is a model call and a few Spotify lookups. */
  const explain = async (keys: number[]) => {
    for (const key of keys) {
      if (mores[key]) {
        setOpen((o) => toggle(o, key, true));
        continue;
      }
      setBusy((b) => toggle(b, key, true));
      try {
        const r = await api.scanMore(scan.id, key);
        if (r.more) setMores((m) => ({ ...m, [key]: r.more! }));
        setOpen((o) => toggle(o, key, true));
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not explain this one.');
        return;
      } finally {
        setBusy((b) => toggle(b, key, false));
      }
    }
  };

  if (!scan.candidates.length) {
    return (
      <div className="grid gap-3">
        <div className="flex gap-3 border border-ink bg-surface p-3">
          {scan.kind === 'photo' && <Photo id={scan.id} className="h-24" />}
          <div>
            <div className="font-extrabold">Nothing to add</div>
            <p className="mt-1.5 mb-0 text-sm text-sub">{scan.error ?? 'No dated events found.'}</p>
          </div>
        </div>
      </div>
    );
  }

  const allOn = chosen.length === drafts.length;
  const topMissing = [...top].filter((k) => !mores[k]);
  const sp = spotify.data;
  return (
    <div className="grid gap-3 pb-24">
      <div className="flex gap-3 border border-ink bg-surface p-3">
        {scan.kind === 'photo' && <Photo id={scan.id} className="h-24" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-extrabold tracking-[.1em] text-sub uppercase">
            <Sparkles className="size-4" aria-hidden />
            Read by AI
          </div>
          <p className="mt-1.5 mb-2 text-[15px] leading-5">
            <b>{drafts.length}</b> {drafts.length === 1 ? 'event' : 'events'} found
            {ranked && byTaste ? ', best for you first' : ''}. Untick anything wrong, tap Edit to fix a detail.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => setDrafts((ds) => ds.map((d) => ({ ...d, on: !allOn })))}
              aria-pressed={allOn}
            >
              {allOn ? 'Untick all' : 'Tick all'}
            </Button>
            {ranked && (
              <Button size="sm" onClick={() => setByTaste(!byTaste)}>
                <ArrowDownUp aria-hidden />
                {byTaste ? 'As read' : 'Best for me'}
              </Button>
            )}
            {topMissing.length > 0 && (
              <Button size="sm" disabled={busy.size > 0} onClick={() => void explain([...top])}>
                {busy.size > 0 ? <Loader2 className="animate-spin" aria-hidden /> : <Info aria-hidden />}
                Explain top {top.size}
              </Button>
            )}
          </div>
        </div>
      </div>

      {sp?.connected && (
        <div className="grid gap-2 border border-ink bg-surface p-3">
          <div className="flex items-center gap-1.5 text-xs font-extrabold tracking-[.1em] text-sub uppercase">
            <ListMusic className="size-4" aria-hidden />
            Listen first
          </div>
          {sp.canPlaylist ? (
            <>
              <p className="m-0 text-sm leading-5">
                A private Spotify playlist with two tracks per act of the ticked events (up to {PLAYLIST_MAX}).
              </p>
              {playlist.data ? (
                <p className="m-0 text-sm leading-5">
                  <a href={playlist.data.url} target="_blank" rel="noreferrer" className="font-extrabold text-moss">
                    Open the playlist in Spotify
                  </a>{' '}
                  · {playlist.data.tracks} tracks
                  {playlist.data.missing.length > 0 && (
                    <span className="text-sub"> · not on Spotify: {playlist.data.missing.join(', ')}</span>
                  )}
                </p>
              ) : (
                <Button
                  size="sm"
                  className="justify-self-start"
                  disabled={!chosen.length || chosen.length > PLAYLIST_MAX || playlist.isPending}
                  onClick={() => playlist.mutate()}
                >
                  {playlist.isPending && <Loader2 className="animate-spin" aria-hidden />}
                  {chosen.length > PLAYLIST_MAX
                    ? `Tick at most ${PLAYLIST_MAX}`
                    : `Make a playlist from ${chosen.length} ${chosen.length === 1 ? 'event' : 'events'}`}
                </Button>
              )}
              {playlist.isError && (
                <p role="alert" className="m-0 text-sm font-semibold text-danger">
                  {playlist.error.message}
                </p>
              )}
            </>
          ) : (
            <p className="m-0 text-sm leading-5">
              To make playlists from scans, Spotify needs one more permission.{' '}
              <a href="/spotify/connect" className="font-extrabold text-moss">
                Reconnect Spotify
              </a>
            </p>
          )}
        </div>
      )}

      <section className="border border-ink bg-surface">
        {shown.map((d) => (
          <Candidate
            key={d.key}
            d={d}
            insight={scan.insights[d.key] ?? null}
            more={mores[d.key]}
            top={top.has(d.key)}
            moreOpen={open.has(d.key)}
            moreBusy={busy.has(d.key)}
            editing={editing === d.key}
            onToggle={() => update(d.key, { on: !d.on })}
            onEdit={() => setEditing(editing === d.key ? null : d.key)}
            onMore={() => (mores[d.key] ? setOpen((o) => toggle(o, d.key, !o.has(d.key))) : void explain([d.key]))}
            onChange={(patch) => update(d.key, patch)}
          />
        ))}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ink bg-surface-a pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-md">
        <div className="gutter mx-auto flex max-w-[600px] gap-2 py-2.5">
          <Button className="w-28" onClick={() => router.history.back()}>
            Discard
          </Button>
          <Button
            variant="default"
            className="flex-1"
            disabled={!chosen.length || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'event' : 'events'}` : 'Nothing ticked'}
          </Button>
        </div>
        {add.isError && (
          <p role="alert" className="gutter mx-auto m-0 max-w-[600px] pb-2 text-sm font-semibold text-danger">
            {add.error.message}
          </p>
        )}
      </div>
    </div>
  );
}

function Candidate({
  d,
  insight,
  more,
  top,
  moreOpen,
  moreBusy,
  editing,
  onToggle,
  onEdit,
  onMore,
  onChange,
}: {
  d: Draft;
  insight: ScanInsight | null;
  more: More | undefined;
  top: boolean;
  moreOpen: boolean;
  moreBusy: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onMore: () => void;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const first = d.occurrences[0]!;
  const price = formatPrice({
    isFree: !!d.price?.free,
    priceMin: d.price?.min ?? null,
    priceMax: d.price?.max ?? null,
  });
  const acts = actsOf(d);
  const field = 'grid gap-1 text-xs font-extrabold tracking-[.08em] text-sub uppercase';
  const input =
    'h-11 w-full border border-ink bg-surface px-3 text-[15px] font-semibold tracking-normal text-ink normal-case outline-none focus-visible:outline-2 focus-visible:outline-moss';
  return (
    <div className={cn('border-b border-line last:border-b-0', !d.on && 'opacity-55')}>
      <div className="flex items-start gap-3 px-3 pt-2.5">
        <button
          type="button"
          role="checkbox"
          aria-checked={d.on}
          aria-label={`Add ${d.title}`}
          onClick={onToggle}
          className={cn(
            'mt-0.5 grid size-6 shrink-0 place-items-center border border-ink',
            d.on ? 'bg-moss text-on-moss' : 'bg-surface',
          )}
        >
          {d.on && <Check className="size-4" strokeWidth={3} aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          {top && <div className="mb-0.5 text-[11px] font-extrabold tracking-[.1em] text-moss uppercase">Top pick</div>}
          <div className="text-[15.5px] leading-5 font-bold [overflow-wrap:anywhere]" lang={d.lang}>
            {d.title}
          </div>
          <div className="mt-1 text-[13px] text-sub">
            <b className="text-ink">{formatDateTime(first.start, d.category)}</b>
            {d.occurrences.length > 1 && ` +${d.occurrences.length - 1}`}
            {d.venue && ` · ${d.venue.name}`}
            {price && ` · ${price}`}
          </div>
          {insight?.reason && <p className="mt-1 mb-0 text-[13.5px] leading-[18px]">{insight.reason}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <CategoryChip category={d.category} />
            {insight?.genres.map((g) => (
              <span key={g} className="border border-line px-1.5 py-0.5 text-xs font-semibold text-sub">
                {g}
              </span>
            ))}
            {d.needsReview && (
              <span className="inline-flex items-center gap-1 text-xs font-bold text-warn">
                <AlertTriangle className="size-3.5" aria-hidden />
                Check against the photo
              </span>
            )}
          </div>
        </div>
        {insight?.score != null && <ScoreBox score={insight.score} />}
      </div>
      <div className="flex flex-wrap gap-1 px-2 pt-1 pb-1.5 pl-11">
        <Button variant="ghost" size="sm" onClick={onMore} aria-expanded={moreOpen} disabled={moreBusy}>
          {moreBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Info aria-hidden />}
          More
        </Button>
        {acts[0] && (
          <Button variant="ghost" size="sm" asChild>
            <a href={listenHref(acts[0])} target="_blank" rel="noreferrer">
              <Headphones aria-hidden />
              Listen
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onEdit} aria-expanded={editing}>
          {editing ? <X aria-hidden /> : <Pencil aria-hidden />}
          {editing ? 'Close' : 'Edit'}
        </Button>
      </div>
      {more && moreOpen && <MoreNote more={more} acts={acts} />}
      {editing && (
        <div className="grid gap-3 border-t border-line bg-background/60 px-3 py-3">
          <label className={field}>
            Title
            <input className={input} value={d.title} onChange={(e) => onChange({ title: e.target.value })} />
          </label>
          <label className={field}>
            Venue
            <input
              className={input}
              value={d.venue?.name ?? ''}
              onChange={(e) => onChange({ venue: e.target.value.trim() ? { ...d.venue, name: e.target.value } : null })}
            />
          </label>
          <label className={field}>
            With (comma between names)
            <NamesInput
              className={input}
              names={d.performers.map((p) => p.name)}
              onChange={(names) => onChange({ performers: names.map((name) => ({ name })) })}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className={field}>
              Category
              <select
                className={input}
                value={d.category}
                onChange={(e) => onChange({ category: e.target.value as Category })}
              >
                {Category.options.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              From (€, 0 = free)
              <input
                className={input}
                inputMode="decimal"
                value={d.price?.free ? '0' : (d.price?.min ?? '')}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.').trim();
                  const n = Number(v);
                  onChange({
                    price:
                      v === '' || Number.isNaN(n)
                        ? null
                        : n === 0
                          ? { currency: 'EUR', free: true }
                          : {
                              currency: 'EUR',
                              min: n,
                              ...(d.price?.max && d.price.max >= n ? { max: d.price.max } : {}),
                            },
                  });
                }}
              />
            </label>
          </div>
          <div className={field}>
            Dates
            {d.occurrences.map((o, i) => (
              <div key={`${o.start}-${i}`} className="flex gap-2">
                <input
                  type="datetime-local"
                  className={input}
                  value={o.start}
                  onChange={(e) =>
                    e.target.value &&
                    onChange({
                      occurrences: d.occurrences.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)),
                    })
                  }
                />
                {d.occurrences.length > 1 && (
                  <Button
                    size="icon"
                    aria-label="Remove this date"
                    onClick={() => onChange({ occurrences: d.occurrences.filter((_, j) => j !== i) })}
                  >
                    <X aria-hidden />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {d.sourceQuote && <p className="m-0 text-xs text-sub">Read from: “{d.sourceQuote}”</p>}
        </div>
      )}
    </div>
  );
}

/** What it is, why it may suit, and each act on Spotify ("Listen" searches for acts not found there). */
function MoreNote({ more, acts }: { more: More; acts: string[] }) {
  const found = new Set(more.artists.map((a) => artistKey(a.name)));
  return (
    <div className="grid gap-2 border-t border-line bg-background/60 px-3 py-3 text-[14px] leading-5">
      <p className="m-0">{more.about}</p>
      <p className="m-0 font-semibold">{more.why}</p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {more.artists.map((a) => (
          <li key={a.url} className="flex items-center gap-2">
            {a.image && <img src={a.image} alt="" className="size-8 shrink-0 border border-line object-cover" />}
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <b>{a.name}</b>
              {a.genres.length > 0 && <span className="text-sub"> · {a.genres.join(', ')}</span>}
            </span>
            <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-extrabold text-moss">
              Listen
            </a>
          </li>
        ))}
        {acts
          .filter((n) => !found.has(artistKey(n)))
          .slice(0, 3)
          .map((n) => (
            <li key={n} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <b>{n}</b> <span className="text-sub">· not found by exact name</span>
              </span>
              <a
                href={listenHref(n)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-sm font-extrabold text-moss"
              >
                Search
              </a>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Comma-separated names; keeps the raw text while typing so a trailing comma is not swallowed. */
function NamesInput({
  names,
  onChange,
  className,
}: {
  names: string[];
  onChange: (names: string[]) => void;
  className: string;
}) {
  const [text, setText] = useState(() => names.join(', '));
  return (
    <input
      className={className}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
