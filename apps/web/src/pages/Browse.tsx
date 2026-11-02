import {
  CATEGORY_LABELS,
  Category,
  DISTRICTS,
  berlinToday,
  formatDay,
  hiddenCategories,
  Via,
  type Prefs,
  type Profile,
} from '@bln/shared';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Search, SlidersHorizontal } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { TopBar } from '@/components/AppShell';
import { BelarusFlag } from '@/components/BelarusFlag';
import { CategoryDot } from '@/components/CategoryChip';
import { DayList } from '@/components/DayList';
import { EventRow } from '@/components/EventRow';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useListFilter, useListFilterReady } from '@/lib/marks';
import { toast } from '@/lib/toast';
import { WHEN_LABELS, whenRange, type When } from '@/lib/dates';
import { PER_DAY } from '@/lib/highlights';
import { useVisitorOptIn } from '@/lib/visitorSources';

/**
 * Filter chips: every category but `other`; opt-in ones only for users (or visitors, in their browser) who turned
 * them on. Switched-off categories
 * keep their chip: picking one is how to look at them on purpose.
 */
const listCategories = (prefs?: Pick<Prefs, 'categoriesOn'>) => {
  const hidden = hiddenCategories(prefs);
  return Category.options.filter((c) => c !== 'other' && !hidden.includes(c));
};

/** Within a group, choices add up: any of them matches (concert or theatre, Wedding or Mitte). */
type Filters = { when: When; category: Category[]; district: string[]; via: Via[] };
const NO_FILTERS: Filters = { when: 'all', category: [], district: [], via: [] };
const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const list = (s?: string) => (s ? s.split(',').filter(Boolean) : []);
const joined = (a: string[]) => (a.length ? a.join(',') : undefined);

const VIEW_KEY = 'bln.browseView';
/** Events per page: about a week of whole days. */
const PAGE = 100;

/** Source kinds, not single venues (docs/09): where an event came from. Spotify joins when it is connected. */
const VIA_LABELS: Record<Exclude<Via, Community>, string> = {
  spotify: 'My artists',
  spotifylike: 'Close to my music taste',
  telegram: 'Telegram channels',
  scans: 'Added from photos & text',
};

/** Communities: events from their own sources or about them (services/events.ts). */
type Community = 'belarusian';
const COMMUNITIES: { via: Community; label: string; Mark: () => React.ReactNode }[] = [
  { via: 'belarusian', label: 'Belarusian', Mark: () => <BelarusFlag /> },
];

/**
 * Browse filters live in the address (?when=week&via=telegram&q=jazz), so Back from an event, a reload or a shared
 * link shows the same list. Unknown values are dropped rather than failing the page.
 */
export const BrowseSearch = z.object({
  when: z
    .enum(Object.keys(WHEN_LABELS) as [When, ...When[]])
    .optional()
    .catch(undefined),
  // Comma lists, checked value by value below.
  category: z.string().max(200).optional().catch(undefined),
  district: z.string().max(400).optional().catch(undefined),
  via: z.string().max(60).optional().catch(undefined),
  q: z.string().max(100).optional().catch(undefined),
});
export type BrowseSearch = z.infer<typeof BrowseSearch>;

export function BrowsePage() {
  const today = berlinToday();
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  // Each change replaces the address, so Back leaves Browse instead of stepping through filter changes.
  const setSearch = (next: BrowseSearch) =>
    void navigate({
      search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as BrowseSearch,
      replace: true,
    });
  const filters: Filters = {
    when: search.when ?? 'all',
    category: list(search.category).filter((c): c is Category => Category.safeParse(c).success),
    district: list(search.district),
    via: list(search.via).filter((v): v is Via => Via.safeParse(v).success),
  };
  const setFilters = (f: Filters | ((prev: Filters) => Filters)) => {
    const n = typeof f === 'function' ? f(filters) : f;
    setSearch({
      when: n.when === 'all' ? undefined : n.when,
      category: joined(n.category),
      district: joined(n.district),
      via: joined(n.via),
      q: search.q,
    });
  };
  const [q, setQState] = useState(search.q ?? '');
  const setQ = (v: string) => {
    setQState(v);
    setSearch({ ...search, q: v.trim() || undefined });
  };
  const query = useDeferredValue(q.trim());
  const [sheetOpen, setSheetOpen] = useState(false);

  // The user's saved default filters apply when Browse opens with none in the address (once per visit, so "Clear
  // all" still shows everything until the next visit).
  const { user } = useMe();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile, enabled: !!user });
  const applied = useRef(false);
  const noFilters = !search.when && !search.category && !search.district && !search.via;
  // Applying the default is a navigation, which lands a moment later: until it has, the list waits.
  const [awaitingDefault, setAwaitingDefault] = useState(false);
  useEffect(() => {
    if (applied.current || !profile.data) return;
    applied.current = true;
    const saved = profile.data.prefs.browseDefault;
    if (saved && noFilters) {
      const next = Object.fromEntries(new URLSearchParams(saved)) as BrowseSearch;
      // Only wait when the default sets a filter; otherwise nothing would ever land.
      if (next.when || next.category || next.district || next.via) setAwaitingDefault(true);
      setSearch({ ...next, q: search.q });
    }
  }, [profile.data, noFilters, search.q, setSearch]);
  useEffect(() => {
    if (awaitingDefault && !noFilters) setAwaitingDefault(false);
  }, [awaitingDefault, noFilters]);

  const params = {
    ...whenRange(filters.when, today),
    category: filters.category.length ? filters.category : undefined,
    district: filters.district.length ? filters.district : undefined,
    via: filters.via.length ? filters.via : undefined,
    q: query || undefined,
  };
  // Wait for the switches (and a signed-in user's saved default filters) before asking for events: a list drawn
  // earlier would show rows that vanish a moment later, or an unfiltered page while the saved filters land.
  const savedDefault = new URLSearchParams(profile.data?.prefs.browseDefault ?? '');
  const defaultFilters = ['when', 'category', 'district', 'via'].some((k) => savedDefault.get(k));
  const defaultPending = noFilters && (awaitingDefault || (!applied.current && defaultFilters));
  const ready = useListFilterReady() && !defaultPending;
  const events = useInfiniteQuery({
    queryKey: ['events', params],
    // A big page covers several whole days, which matters when each day shows only its highlights.
    queryFn: ({ pageParam }) => api.events({ ...params, cursor: pageParam, limit: PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: ready,
  });
  // Hidden events and switched-off categories stay out here, so no day is left empty.
  const shows = useListFilter(filters.category);
  const items = useMemo(() => {
    const all = (events.data?.pages.flatMap((p) => p.items) ?? []).filter(shows);
    // The last day of a page may go on in the next one: it waits for that page, so its count and "Show all" are true.
    if (!events.hasNextPage || !all.length) return all;
    const lastDay = all.at(-1)!.next.startLocal.slice(0, 10);
    const complete = all.filter((i) => i.next.startLocal.slice(0, 10) !== lastDay);
    return complete.length ? complete : all;
  }, [events.data, events.hasNextPage, shows]);
  // Search by meaning complements keyword search: "jazz tonight" also finds a quartet that never says "jazz".
  const meaning = useQuery({
    queryKey: ['meaning', query],
    queryFn: () => api.searchByMeaning(query),
    enabled: query.length >= 3,
    retry: false,
  });
  const related = useMemo(() => {
    const shown = new Set(items.map((i) => i.slug));
    return (meaning.data?.items ?? []).filter((i) => !shown.has(i.slug) && shows(i)).slice(0, 8);
  }, [meaning.data, items, shows]);
  // Highlights (default) or everything: a few strong events a day, so a long day stays readable. Plain browsing
  // only: a search, a category or a source asks for all of it.
  const [view, setViewState] = useState<'highlights' | 'all'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'all' ? 'all' : 'highlights';
    } catch {
      return 'highlights';
    }
  });
  const setView = (v: 'highlights' | 'all') => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  };
  const plain = !query && !filters.category.length && !filters.via.length;
  const compact = plain && view === 'highlights';

  // How many filters are on, for the badge on the Filter button (the chips themselves live in the sheet).
  const active =
    (filters.when !== 'all' ? 1 : 0) + filters.category.length + filters.via.length + filters.district.length;

  const clear = () => {
    setQState('');
    setSearch({});
  };

  return (
    <>
      <TopBar right={formatDay(`${today}T00:00`)}>
        <div className="flex gap-2 pb-2">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 border border-ink bg-surface px-3 text-sub focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-moss">
            <Search className="size-5 shrink-0" aria-hidden />
            <span className="sr-only">Search events</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search events"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-sub"
            />
          </label>
          <Button onClick={() => setSheetOpen(true)}>
            <SlidersHorizontal aria-hidden />
            Filter
            {active > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center bg-moss px-1 text-xs font-extrabold text-on-moss">
                {active}
              </span>
            )}
          </Button>
        </div>
      </TopBar>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {events.isPending || !ready ? (
          <ListSkeleton />
        ) : events.isError ? (
          <ErrorState message={events.error.message} onRetry={() => events.refetch()} />
        ) : items.length === 0 ? (
          query.length >= 3 && related.length > 0 ? (
            <p className="m-0 border border-ink bg-surface px-3 py-2.5 text-sm">
              No exact matches for “{query}”. Closest by meaning:
            </p>
          ) : active || query ? (
            <EmptyState title="No events match" action={<Button onClick={clear}>Clear search and filters</Button>}>
              Nothing fits {query ? `“${query}” with ` : ''}these filters yet.
            </EmptyState>
          ) : (
            <EmptyState title="No events yet">
              The first Berlin sources are being connected. Theatre, opera and concert listings appear here as soon as
              they are imported.
            </EmptyState>
          )
        ) : (
          <>
            {plain && (
              <div className="flex items-center justify-between gap-3">
                <div
                  className="inline-flex border border-ink bg-surface"
                  role="radiogroup"
                  aria-label="How much to show"
                >
                  {(
                    [
                      ['highlights', 'Highlights'],
                      ['all', 'Everything'],
                    ] as const
                  ).map(([v, name]) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={view === v}
                      onClick={() => setView(v)}
                      className={
                        view === v
                          ? 'h-9 bg-ink px-3 text-[13px] font-extrabold text-on-ink'
                          : 'h-9 px-3 text-[13px] font-bold text-sub'
                      }
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <span className="text-right text-xs text-sub">
                  {compact ? `Up to ${PER_DAY} a day, most liked first` : 'Every event, by time'}
                </span>
              </div>
            )}
            <DayList items={items} today={today} compact={compact} />
          </>
        )}
        {query.length >= 3 && related.length > 0 && (
          <section className="border border-ink bg-surface" aria-label="Related by meaning">
            <div className="flex h-8 items-center justify-between bg-moss px-3 text-xs font-extrabold tracking-[.08em] text-on-moss uppercase">
              <span>Related by meaning</span>
              <span className="tabular-nums">{related.length}</span>
            </div>
            {related.map((it) => (
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

      <FilterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        filters={filters}
        onChange={setFilters}
        count={events.isPending ? undefined : { n: items.length, more: events.hasNextPage }}
      />
    </>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button aria-pressed={pressed} onClick={onClick}>
      {pressed && <Check className="size-4" strokeWidth={2.4} aria-hidden />}
      {children}
    </Button>
  );
}

/** These filters as the address query they live in, for saving as the default ("" when nothing is set). */
const filterQuery = (f: Filters) =>
  new URLSearchParams(
    Object.entries({
      when: f.when === 'all' ? undefined : f.when,
      category: joined(f.category),
      district: joined(f.district),
      via: joined(f.via),
    }).filter((e): e is [string, string] => !!e[1]),
  ).toString();

function FilterSheet({
  open,
  onOpenChange,
  filters,
  onChange,
  count,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: Filters;
  onChange: (f: Filters) => void;
  count: { n: number; more: boolean } | undefined;
}) {
  const label = 'mb-2.5 mt-5 text-xs font-extrabold tracking-[.1em] text-sub uppercase';
  // Opt-in categories appear as a filter only for signed-in users who switched them on.
  const { user } = useMe();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile, enabled: !!user && open });
  const optIn = useVisitorOptIn();
  const categories = listCategories(user ? profile.data?.prefs : { categoriesOn: optIn.on });
  const spotify = useQuery({ queryKey: ['spotify'], queryFn: api.spotify, enabled: !!user && open });
  const youtube = useQuery({ queryKey: ['youtube'], queryFn: api.youtube, enabled: !!user && open });
  const music = !!spotify.data?.connected || !!youtube.data?.connected;
  const qc = useQueryClient();
  const saved = profile.data?.prefs.browseDefault ?? '';
  const current = filterQuery(filters);
  const saveDefault = useMutation({
    mutationFn: (search: string) => api.setBrowseDefault(search),
    onSuccess: ({ search }) => {
      qc.setQueryData<Profile>(['profile'], (p) => (p ? { ...p, prefs: { ...p.prefs, browseDefault: search } } : p));
      toast(search ? 'Saved: Browse opens with these filters' : 'Default cleared: Browse opens with everything');
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-h-[88vh] max-w-[600px] overflow-y-auto border-x border-ink">
        <SheetHeader className="pb-0">
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="px-4">
          <div className={label}>When</div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(WHEN_LABELS) as When[]).map((w) => (
              <Chip key={w} pressed={filters.when === w} onClick={() => onChange({ ...filters, when: w })}>
                {WHEN_LABELS[w]}
              </Chip>
            ))}
          </div>
          <div className={label}>Category</div>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <Chip
                key={c}
                pressed={filters.category.includes(c)}
                onClick={() => onChange({ ...filters, category: toggle(filters.category, c) })}
              >
                <CategoryDot category={c} className="size-2" />
                {CATEGORY_LABELS[c]}
              </Chip>
            ))}
          </div>
          <div className={label}>Source</div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(VIA_LABELS) as (keyof typeof VIA_LABELS)[])
              .filter((v) => !v.startsWith('spotify') || music)
              .map((v) => (
                <Chip
                  key={v}
                  pressed={filters.via.includes(v)}
                  onClick={() => onChange({ ...filters, via: toggle(filters.via, v) })}
                >
                  {VIA_LABELS[v]}
                </Chip>
              ))}
          </div>
          <div className={label}>Community</div>
          <div className="flex flex-wrap gap-2">
            {COMMUNITIES.map(({ via, label: name, Mark }) => (
              <Chip
                key={via}
                pressed={filters.via.includes(via)}
                onClick={() => onChange({ ...filters, via: toggle(filters.via, via) })}
              >
                <Mark />
                {name}
              </Chip>
            ))}
          </div>
          <div className={label}>District</div>
          <div className="flex flex-wrap gap-2">
            {DISTRICTS.map((d) => (
              <Chip
                key={d}
                pressed={filters.district.includes(d)}
                onClick={() => onChange({ ...filters, district: toggle(filters.district, d) })}
              >
                {d}
              </Chip>
            ))}
          </div>
        </div>
        {user && (
          <div className="flex flex-wrap items-center gap-2 px-4 pt-5 text-sm">
            {saved && saved === current ? (
              <span className="font-bold text-moss">These are your default filters</span>
            ) : (
              <Button
                size="sm"
                disabled={saveDefault.isPending || !current}
                onClick={() => saveDefault.mutate(current)}
              >
                Save as my default
              </Button>
            )}
            {saved && (
              <Button size="sm" variant="ghost" disabled={saveDefault.isPending} onClick={() => saveDefault.mutate('')}>
                Clear default
              </Button>
            )}
          </div>
        )}
        <SheetFooter className="flex-row gap-2 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          <Button size="lg" className="w-28" onClick={() => onChange(NO_FILTERS)}>
            Reset
          </Button>
          <Button size="lg" variant="default" className="flex-1" onClick={() => onOpenChange(false)}>
            {count === undefined
              ? 'Show events'
              : count.n === 0
                ? 'No events match'
                : `Show ${count.n}${count.more ? '+' : ''} events`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
