import { formatDay, formatPrice, formatTime, type EventListItem } from '@bln/shared';
import { Link } from '@tanstack/react-router';
import { CategoryChip } from './CategoryChip';

const ANGLES = [90, 60, 145, 35, 120, 0, 160, 75];

/** Stable pseudo-random hatch angle per event, standing in for a thumbnail until images exist. */
export function hatchAngle(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${ANGLES[Math.abs(h) % ANGLES.length]}deg`;
}

/**
 * time · title · venue · price · category. The event appears once; "+N" counts its further dates. `showDay` adds
 * the weekday and date for lists that are not grouped by day (similar events, search by meaning).
 */
export function EventRow({ item, showDay = false }: { item: EventListItem; showDay?: boolean }) {
  const price = formatPrice(item);
  return (
    <Link
      to="/e/$slug"
      params={{ slug: item.slug }}
      className="flex min-h-16 items-center gap-3 border-b border-line px-3 py-2 text-ink no-underline last:border-b-0 hover:bg-surface/60"
    >
      <div className="hatch size-12 shrink-0" style={{ ['--hatch-angle' as string]: hatchAngle(item.slug) }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15.5px] leading-5 font-bold">{item.title}</div>
        <div className="mt-[3px] flex h-5 items-center text-[12.5px] text-sub">
          <span
            className={`flex shrink-0 items-baseline gap-1 font-bold text-ink tabular-nums ${showDay ? 'w-[124px]' : 'w-16'}`}
          >
            {showDay && `${formatDay(item.next.startLocal)} `}
            {formatTime(item.next.startLocal)}
            {item.moreDates > 0 && <small className="text-[11px] font-semibold text-sub">+{item.moreDates}</small>}
          </span>
          <span className="truncate">{item.venueName ?? 'Venue to be announced'}</span>
        </div>
      </div>
      <div className="grid w-[88px] shrink-0 justify-items-end gap-[3px]">
        <div className="text-sm leading-5 font-bold tabular-nums">{price ?? ''}</div>
        <CategoryChip category={item.category} className="w-[88px]" />
      </div>
    </Link>
  );
}
