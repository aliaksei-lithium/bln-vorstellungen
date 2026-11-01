import { CATEGORY_LABELS, Category, formatDateTime, formatPrice, type ExtractedEvent, type Scan } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { AlertTriangle, Check, ChevronLeft, Loader2, Pencil, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CategoryChip } from '@/components/CategoryChip';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Review a scan (docs/09, 2026-11-01 "Scans"): what the AI read from a photo or text, one card per event, all
 * ticked. Untick what is wrong, fix what is close, then add. Known events merge instead of duplicating.
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

function Review({ scan }: { scan: Scan }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    setDrafts(scan.candidates.map((c, key) => ({ ...c, key, on: true })));
  }, [scan.candidates]);

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
  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

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
            <b>{drafts.length}</b> {drafts.length === 1 ? 'event' : 'events'} found. Untick anything wrong, tap Edit to
            fix a detail.
          </p>
          <Button
            size="sm"
            onClick={() => setDrafts((ds) => ds.map((d) => ({ ...d, on: !allOn })))}
            aria-pressed={allOn}
          >
            {allOn ? 'Untick all' : 'Tick all'}
          </Button>
        </div>
      </div>

      <section className="border border-ink bg-surface">
        {drafts.map((d) => (
          <Candidate
            key={d.key}
            d={d}
            editing={editing === d.key}
            onToggle={() => update(d.key, { on: !d.on })}
            onEdit={() => setEditing(editing === d.key ? null : d.key)}
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
  editing,
  onToggle,
  onEdit,
  onChange,
}: {
  d: Draft;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const first = d.occurrences[0]!;
  const price = formatPrice({
    isFree: !!d.price?.free,
    priceMin: d.price?.min ?? null,
    priceMax: d.price?.max ?? null,
  });
  const field = 'grid gap-1 text-xs font-extrabold tracking-[.08em] text-sub uppercase';
  const input =
    'h-11 w-full border border-ink bg-surface px-3 text-[15px] font-semibold tracking-normal text-ink normal-case outline-none focus-visible:outline-2 focus-visible:outline-moss';
  return (
    <div className={cn('border-b border-line last:border-b-0', !d.on && 'opacity-55')}>
      <div className="flex items-start gap-3 px-3 py-2.5">
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
          <div className="text-[15.5px] leading-5 font-bold [overflow-wrap:anywhere]" lang={d.lang}>
            {d.title}
          </div>
          <div className="mt-1 text-[13px] text-sub">
            <b className="text-ink">{formatDateTime(first.start, d.category)}</b>
            {d.occurrences.length > 1 && ` +${d.occurrences.length - 1}`}
            {d.venue && ` · ${d.venue.name}`}
            {price && ` · ${price}`}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <CategoryChip category={d.category} />
            {d.needsReview && (
              <span className="inline-flex items-center gap-1 text-xs font-bold text-warn">
                <AlertTriangle className="size-3.5" aria-hidden />
                Check against the photo
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-expanded={editing}>
          {editing ? <X aria-hidden /> : <Pencil aria-hidden />}
          {editing ? 'Close' : 'Edit'}
        </Button>
      </div>
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
