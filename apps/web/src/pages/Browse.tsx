import { CATEGORY_LABELS, Category, berlinToday, formatDay, type EventListItem } from '@bln/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Search, SlidersHorizontal, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryDot } from '@/components/CategoryChip';
import { EventRow } from '@/components/EventRow';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { WHEN_LABELS, relativeDay, whenRange, type When } from '@/lib/dates';

const DISTRICTS = [
  'Mitte',
  'Kreuzberg',
  'Friedrichshain',
  'Prenzlauer Berg',
  'Neukölln',
  'Charlottenburg',
  'Schöneberg',
  'Tiergarten',
];
const LIST_CATEGORIES = Category.options.filter((c) => c !== 'other');

type Filters = { when: When; category?: Category; district?: string };

function groupByDay(items: EventListItem[]) {
  const groups = new Map<string, EventListItem[]>();
  for (const it of items) {
    const day = it.next.startLocal.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), it]);
  }
  return [...groups.entries()];
}

export function BrowsePage() {
  const today = berlinToday();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [filters, setFilters] = useState<Filters>({ when: 'all' });
  const [sheetOpen, setSheetOpen] = useState(false);

  const params = {
    ...whenRange(filters.when, today),
    category: filters.category,
    district: filters.district,
    q: query || undefined,
  };
  const events = useQuery({
    queryKey: ['events', params],
    queryFn: () => api.events(params),
    placeholderData: keepPreviousData,
  });
  const groups = useMemo(() => groupByDay(events.data?.items ?? []), [events.data]);

  const active: { key: keyof Filters; label: string }[] = [];
  if (filters.when !== 'all') active.push({ key: 'when', label: WHEN_LABELS[filters.when] });
  if (filters.category) active.push({ key: 'category', label: CATEGORY_LABELS[filters.category] });
  if (filters.district) active.push({ key: 'district', label: filters.district });
  const clear = () => {
    setFilters({ when: 'all' });
    setQ('');
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
            {active.length > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center bg-moss px-1 text-xs font-extrabold text-on-moss">
                {active.length}
              </span>
            )}
          </Button>
        </div>
        {active.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-2.5">
            {active.map((a) => (
              <Button
                key={a.key}
                variant="dark"
                size="sm"
                className="min-h-8 px-2"
                aria-label={`Remove filter ${a.label}`}
                onClick={() => setFilters((f) => ({ ...f, [a.key]: a.key === 'when' ? 'all' : undefined }))}
              >
                {a.label}
                <X className="size-3.5" aria-hidden />
              </Button>
            ))}
            <Button variant="ghost" size="sm" className="min-h-8" onClick={clear}>
              Clear all
            </Button>
          </div>
        )}
      </TopBar>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {events.isPending ? (
          <ListSkeleton />
        ) : events.isError ? (
          <ErrorState message={events.error.message} onRetry={() => events.refetch()} />
        ) : groups.length === 0 ? (
          active.length || query ? (
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
          groups.map(([day, items]) => (
            <section key={day} aria-label={formatDay(`${day}T00:00`)} className="border border-ink bg-surface-a">
              <div className="flex h-8 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.08em] text-on-ink uppercase">
                <span className="tabular-nums">
                  {formatDay(`${day}T00:00`)}
                  {relativeDay(day, today) && ` · ${relativeDay(day, today)}`}
                </span>
                <span className="tabular-nums">{items.length}</span>
              </div>
              {items.map((it) => (
                <EventRow key={it.slug} item={it} />
              ))}
            </section>
          ))
        )}
      </div>

      <FilterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        filters={filters}
        onChange={setFilters}
        count={events.data?.items.length}
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
  count: number | undefined;
}) {
  const label = 'mb-2.5 mt-5 text-xs font-extrabold tracking-[.1em] text-sub uppercase';
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
            {LIST_CATEGORIES.map((c) => (
              <Chip
                key={c}
                pressed={filters.category === c}
                onClick={() => onChange({ ...filters, category: filters.category === c ? undefined : c })}
              >
                <CategoryDot category={c} className="size-2" />
                {CATEGORY_LABELS[c]}
              </Chip>
            ))}
          </div>
          <div className={label}>District</div>
          <div className="flex flex-wrap gap-2">
            {DISTRICTS.map((d) => (
              <Chip
                key={d}
                pressed={filters.district === d}
                onClick={() => onChange({ ...filters, district: filters.district === d ? undefined : d })}
              >
                {d}
              </Chip>
            ))}
          </div>
        </div>
        <SheetFooter className="flex-row gap-2 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          <Button size="lg" className="w-28" onClick={() => onChange({ when: 'all' })}>
            Reset
          </Button>
          <Button size="lg" variant="default" className="flex-1" onClick={() => onOpenChange(false)}>
            {count === undefined ? 'Show events' : count === 0 ? 'No events match' : `Show ${count} events`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
