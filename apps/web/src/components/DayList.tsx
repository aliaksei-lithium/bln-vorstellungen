import { formatDay, type EventListItem } from '@bln/shared';
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EventRow } from '@/components/EventRow';
import { relativeDay } from '@/lib/dates';
import { dayHighlights } from '@/lib/highlights';

export function groupByDay(items: EventListItem[]) {
  const groups = new Map<string, EventListItem[]>();
  for (const it of items) {
    const day = it.next.startLocal.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), it]);
  }
  return [...groups.entries()];
}

/**
 * Events by day, one framed section each. `compact` shows each day's highlights (lib/highlights.ts) with the rest
 * behind "Show all N", opened day by day.
 */
export function DayList({
  items,
  today,
  compact = false,
}: {
  items: EventListItem[];
  today: string;
  compact?: boolean;
}) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  return (
    <>
      {groups.map(([day, all]) => {
        const shown = compact && !open.has(day) ? dayHighlights(all) : all;
        const hidden = all.length - shown.length;
        return (
          <section key={day} aria-label={formatDay(`${day}T00:00`)} className="border border-ink bg-surface">
            <div className="flex h-8 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.08em] text-on-ink uppercase">
              <span className="tabular-nums">
                {formatDay(`${day}T00:00`)}
                {relativeDay(day, today) && ` · ${relativeDay(day, today)}`}
              </span>
              <span className="tabular-nums">{all.length}</span>
            </div>
            {shown.map((it) => (
              <EventRow key={it.slug} item={it} />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setOpen((s) => new Set(s).add(day))}
                className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-line text-[13px] font-bold text-moss hover:bg-chip/60"
              >
                Show all {all.length} on {formatDay(`${day}T00:00`)}
                <ChevronDown className="size-4" aria-hidden />
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}
