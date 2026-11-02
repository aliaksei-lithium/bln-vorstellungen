import { formatDay, formatPrice, formatTime, type EventListItem } from '@bln/shared';
import { Link } from '@tanstack/react-router';
import { CalendarDays, EyeOff, Heart, HelpCircle } from 'lucide-react';
import { useMark, useMyStates } from '@/lib/marks';
import { CategoryChip } from './CategoryChip';
import { SwipeRow } from './SwipeRow';

const ANGLES = [90, 60, 145, 35, 120, 0, 160, 75];

/** Stable pseudo-random hatch angle per event: the thumbnail's background, and the thumbnail when there is no image. */
export function hatchAngle(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${ANGLES[Math.abs(h) % ANGLES.length]}deg`;
}

/**
 * time · title · tagline (what it is, when known) · venue · price · category. The event appears once; "+N" counts its further dates. `showDay` adds
 * the weekday and date for lists that are not grouped by day (similar events, search by meaning). Signed in, the row
 * shows the user's mark and swipes: right for interested (again to undo), left for Calendar and Hide. Hidden events
 * are not shown.
 */
export function EventRow({ item, showDay = false }: { item: EventListItem; showDay?: boolean }) {
  const price = formatPrice(item);
  const { signedIn, states } = useMyStates();
  const mark = useMark();
  const state = states[item.slug];
  if (state === 'hidden') return null;
  const icon = 'size-[22px]';
  return (
    <SwipeRow
      id={item.slug}
      enabled={signedIn}
      right={{
        label: state === 'interested' ? 'Remove' : 'Interested',
        icon: <Heart className={icon} strokeWidth={2} aria-hidden />,
        className: 'bg-moss text-on-moss',
        run: () => mark(item.slug, state === 'interested' ? null : 'interested'),
      }}
      actions={[
        {
          label: 'Calendar',
          icon: <CalendarDays className={icon} strokeWidth={2} aria-hidden />,
          className: 'bg-cal text-on-ink',
          run: () => mark(item.slug, 'interested', { message: 'Added to Agenda and calendar' }),
        },
        {
          label: 'Hide',
          icon: <EyeOff className={icon} strokeWidth={2} aria-hidden />,
          className: 'bg-danger text-on-ink',
          run: () => mark(item.slug, 'hidden', { message: `Hidden “${item.title}”` }),
        },
      ]}
    >
      <RowLink item={item} showDay={showDay} price={price} state={state} />
    </SwipeRow>
  );
}

function RowLink({
  item,
  showDay,
  price,
  state,
}: {
  item: EventListItem;
  showDay: boolean;
  price: string | null;
  state: string | undefined;
}) {
  return (
    <Link
      to="/e/$slug"
      params={{ slug: item.slug }}
      draggable={false}
      className="flex min-h-16 items-center gap-3 px-3 py-2 text-ink no-underline hover:bg-chip/60"
    >
      <div
        className="hatch size-12 shrink-0 overflow-hidden"
        style={{ ['--hatch-angle' as string]: hatchAngle(item.slug) }}
      >
        {item.image && (
          <img src={item.image} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[15.5px] leading-5 font-bold">
          <span className="truncate">{item.title}</span>
          {state === 'interested' && (
            <Heart className="size-[15px] shrink-0 text-moss" strokeWidth={2.2} aria-label="Interested" />
          )}
          {state === 'maybe' && (
            <HelpCircle className="size-[15px] shrink-0 text-moss" strokeWidth={2.2} aria-label="Maybe" />
          )}
        </div>
        {item.tagline && (
          <div className="mt-px line-clamp-2 text-[13px] leading-[17px] text-ink/75" lang="en">
            {item.tagline}
          </div>
        )}
        <div className="mt-[3px] flex h-5 items-center text-[12.5px] text-sub">
          <span
            className={`flex shrink-0 items-baseline gap-1 font-bold text-ink tabular-nums ${showDay ? 'w-[124px]' : 'w-16'}`}
          >
            {showDay && `${formatDay(item.next.startLocal)} `}
            {formatTime(item.next.startLocal, item.category)}
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
