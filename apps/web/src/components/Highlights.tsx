import { formatDateTime, formatPrice, type InboxReview, type ReviewKind, type ReviewPick } from '@bln/shared';
import { Link } from '@tanstack/react-router';
import {
  CalendarClock,
  Clock,
  Compass,
  ExternalLink,
  Heart,
  Loader2,
  Newspaper,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { CategoryChip } from '@/components/CategoryChip';
import { ScoreBox } from '@/components/Score';

/**
 * Highlights (docs/09, 2026-11-02): the daily review, grouped by category. Each pick says why it stands out now:
 * book early, made for you, last chance, what critics say, a clash with your plans, or something new. The same view
 * serves a signed-in user's own highlights and the public edition.
 */

const KIND: Record<ReviewKind, { label: string; publicLabel?: string; Icon: LucideIcon }> = {
  book_early: { label: 'Book early', Icon: Ticket },
  perfect_match: { label: 'Made for you', publicLabel: 'Unmissable', Icon: Heart },
  last_chance: { label: 'Last chance', Icon: Clock },
  critics: { label: 'Critics like it', Icon: Newspaper },
  plan_check: { label: 'Check your plan', Icon: CalendarClock },
  something_new: { label: 'Something new', Icon: Compass },
};

export function HighlightsView({
  review,
  personal,
  empty,
}: {
  review: InboxReview;
  personal: boolean;
  /** Shown when there is no review yet (with the action to prepare one). */
  empty: ReactNode;
}) {
  if (review.status === 'preparing' && !review.sections.length) {
    return (
      <div className="flex items-start gap-3 border border-ink bg-surface p-3.5" aria-live="polite">
        <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" aria-hidden />
        <div>
          <div className="font-extrabold">Preparing {personal ? 'your' : 'today’s'} highlights…</div>
          <p className="mt-1 mb-0 text-sm text-sub">
            Going through the coming months, looking up reviews and ticket demand. About a minute.
          </p>
        </div>
      </div>
    );
  }
  if (!review.day) return <>{empty}</>;
  return (
    <div className="grid gap-3">
      <div className="border border-ink bg-surface p-3.5">
        <p className="m-0 text-[16px] leading-[22px] font-semibold text-balance">{review.summary}</p>
        <p className="mt-1.5 mb-0 text-xs text-sub">
          {when(review.day)}
          {review.searches > 0 && ` · checked ${review.searches} sources online`}
          {review.status === 'preparing' && ' · a fresh one is on its way'}
        </p>
      </div>
      {review.sections.length === 0 && (
        <p className="m-0 border border-line bg-surface p-3 text-sm text-sub">
          Nothing in this edition is still open. The next one comes tomorrow morning.
        </p>
      )}
      {review.sections.map((s) => (
        <section key={s.category} className="border border-ink bg-surface">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <CategoryChip category={s.category} />
            <span className="text-xs text-sub tabular-nums">{s.picks.length}</span>
          </div>
          {s.picks.map((p) => (
            <Pick key={p.event.slug} p={p} personal={personal} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Pick({ p, personal }: { p: ReviewPick; personal: boolean }) {
  const k = KIND[p.kind];
  const price = formatPrice(p.event);
  return (
    <div className="border-b border-line last:border-b-0">
      <Link
        to="/e/$slug"
        params={{ slug: p.event.slug }}
        className="flex items-start gap-3 px-3 pt-2.5 pb-2 text-ink no-underline"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-extrabold tracking-[.1em] text-moss uppercase">
            <k.Icon className="size-3.5" strokeWidth={2.4} aria-hidden />
            {(!personal && k.publicLabel) || k.label}
          </div>
          <div className="text-[15.5px] leading-5 font-bold [overflow-wrap:anywhere]" lang={p.event.lang}>
            {p.event.title}
          </div>
          <div className="mt-[3px] text-[12.5px] text-sub tabular-nums">
            <b className="text-ink">{formatDateTime(p.event.next.startLocal, p.event.category)}</b>
            {p.event.moreDates > 0 && ` +${p.event.moreDates}`}
            {p.event.venueName && ` · ${p.event.venueName}`}
            {price && ` · ${price}`}
          </div>
          <p className="mt-1 mb-0 text-[14px] leading-[19px]">{p.why}</p>
        </div>
        {p.event.image && (
          <img
            src={p.event.image}
            alt=""
            loading="lazy"
            decoding="async"
            className="mt-0.5 size-16 shrink-0 border border-line object-cover"
          />
        )}
        {p.score != null && <ScoreBox score={p.score} />}
      </Link>
      {p.sourceUrl && (
        <a
          href={p.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mb-2.5 ml-3 inline-flex items-center gap-1 text-xs font-bold text-moss"
        >
          What others say
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

function when(day: string): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  if (day === today) return 'This morning';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Berlin' });
}
