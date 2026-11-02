import {
  formatDay,
  formatPrice,
  formatTime,
  type DiscoverEdition,
  type DiscoverKind,
  type DiscoverPick,
  type DiscoverStory,
} from '@bln/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  AudioLines,
  CalendarDays,
  Gift,
  Map as MapIcon,
  MapPin,
  Palette,
  Shuffle,
  Sparkles,
  Sprout,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryDot } from '@/components/CategoryChip';
import { hatchAngle } from '@/components/EventRow';
import { InviteRequest } from '@/components/InviteRequest';
import { ScoreBox } from '@/components/Score';
import { EmptyState, ErrorState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useVisitorSources } from '@/lib/visitorSources';
import { cn } from '@/lib/utils';

/**
 * Discover (docs/09, 2026-11-02 "Discover"): the day's edition as a page to read, not a list to sort. A headline and
 * lede, the lead story with what to focus on, then stories laid out by what they are: rails for dates (the weekend,
 * new, free), a programme strip for a place (a venue, a district), and column cards for ideas (a scene, a theme,
 * booking ahead, art, something outside the usual). Signed in it is scored for you; otherwise the public edition.
 */

const KIND: Record<DiscoverKind, { label: string; publicLabel?: string; Icon: LucideIcon }> = {
  theme: { label: 'Theme', Icon: Sparkles },
  scene: { label: 'Scene', Icon: AudioLines },
  venue: { label: 'Venue spotlight', Icon: MapPin },
  district: { label: 'Neighbourhood', Icon: MapIcon },
  weekend: { label: 'This weekend', Icon: CalendarDays },
  free: { label: 'Free', Icon: Gift },
  art: { label: 'Art', Icon: Palette },
  ahead: { label: 'Book ahead', Icon: Ticket },
  fresh: { label: 'Just added', Icon: Sprout },
  stretch: { label: 'Beyond your usual', publicLabel: 'Something different', Icon: Shuffle },
};

/** How a story is laid out. */
const SHAPE: Record<DiscoverKind, 'rail' | 'strip' | 'card'> = {
  weekend: 'rail',
  fresh: 'rail',
  free: 'rail',
  venue: 'strip',
  district: 'strip',
  theme: 'card',
  scene: 'card',
  ahead: 'card',
  art: 'card',
  stretch: 'card',
};

const imageOf = (p: DiscoverPick) => p.event.image ?? null;
const anchor = (key: string) => `story-${key}`;

export function DiscoverPage() {
  const { user, isPending } = useMe();
  if (isPending) return <TopBar right="Discover" />;
  return user ? <MyDiscover /> : <PublicDiscover />;
}

function MyDiscover() {
  const q = useQuery({ queryKey: ['discover'], queryFn: api.discover, staleTime: 120_000 });
  return (
    <Edition
      query={q}
      personal
      empty={
        <EmptyState
          title="Discover fills up with your taste"
          action={
            <Button asChild>
              <Link to="/me">Describe your taste</Link>
            </Button>
          }
        >
          Once a few events are scored for you, each morning brings stories about the coming weeks: scenes, venues, what
          to book ahead.
        </EmptyState>
      }
    />
  );
}

function PublicDiscover() {
  const q = useQuery({ queryKey: ['discover-public'], queryFn: api.publicDiscover, staleTime: 300_000 });
  const { off } = useVisitorSources();
  // The visitor's own source switches, kept in this browser: picks only switched-off sources list go.
  const filtered = useMemo(() => {
    if (!q.data || !off.length) return q.data;
    const offSet = new Set(off);
    const stories = q.data.stories.flatMap((s) => {
      const picks = s.picks.filter((p) => !p.event.sources?.length || !p.event.sources.every((id) => offSet.has(id)));
      return picks.length ? [{ ...s, picks }] : [];
    });
    const keys = new Set(stories.map((s) => s.key));
    return {
      ...q.data,
      stories,
      lead: q.data.lead && keys.has(q.data.lead) ? q.data.lead : null,
      focus: q.data.focus.map((f) => ({ ...f, story: f.story && keys.has(f.story) ? f.story : null })),
    };
  }, [q.data, off]);
  return (
    <Edition
      query={{ ...q, data: filtered } as typeof q}
      personal={false}
      empty={<EmptyState title="The first edition is on its way">Discover comes out every morning.</EmptyState>}
      footer={<InviteRequest />}
    />
  );
}

function Edition({
  query,
  personal,
  empty,
  footer,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null; data?: DiscoverEdition; refetch: () => unknown };
  personal: boolean;
  empty: ReactNode;
  footer?: ReactNode;
}) {
  const head = <TopBar right="Discover" />;
  if (query.isPending) {
    return (
      <>
        {head}
        <EditionSkeleton />
      </>
    );
  }
  if (query.isError || !query.data) {
    return (
      <>
        {head}
        <ErrorState message={query.error?.message ?? 'No edition'} onRetry={() => query.refetch()} />
      </>
    );
  }
  const ed = query.data;
  const lead = ed.stories.find((s) => s.key === ed.lead) ?? null;
  const rest = ed.stories.filter((s) => s !== lead);
  return (
    <>
      {head}
      {!ed.stories.length ? (
        <div className="grid gap-4">
          {empty}
          {footer}
        </div>
      ) : (
        <article className="grid gap-7 md:gap-10">
          <Masthead ed={ed} personal={personal} />
          {(lead || ed.focus.length > 0) && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] md:gap-6">
              {lead ? <LeadStory story={lead} personal={personal} /> : <div />}
              {ed.focus.length > 0 && <FocusPanel focus={ed.focus} stories={ed.stories} />}
            </div>
          )}
          {blocks(rest).map((b) =>
            b.shape === 'cards' ? (
              <div key={b.stories[0]!.key} className="grid gap-4 md:grid-cols-2 md:gap-6">
                {b.stories.map((s, i) => (
                  <CardStory
                    key={s.key}
                    story={s}
                    personal={personal}
                    wide={b.stories.length % 2 === 1 && i === b.stories.length - 1}
                  />
                ))}
              </div>
            ) : b.shape === 'rail' ? (
              <RailStory key={b.stories[0]!.key} story={b.stories[0]!} personal={personal} />
            ) : (
              <StripStory key={b.stories[0]!.key} story={b.stories[0]!} personal={personal} />
            ),
          )}
          <footer className="grid gap-4 border-t border-line pt-4">
            <p className="m-0 text-xs text-sub">
              {ed.written
                ? 'Written each morning from the venues’ own programmes. Picks drop out once they have passed.'
                : 'Today’s plain edition; the written one comes with tomorrow morning’s update.'}{' '}
              <Link to="/" className="font-bold text-moss">
                Browse everything
              </Link>
            </p>
            {footer && <div className="max-w-[600px]">{footer}</div>}
          </footer>
        </article>
      )}
    </>
  );
}

/** Consecutive card stories share a two-column grid; rails and strips run full width. */
function blocks(stories: DiscoverStory[]): { shape: 'cards' | 'rail' | 'strip'; stories: DiscoverStory[] }[] {
  const out: { shape: 'cards' | 'rail' | 'strip'; stories: DiscoverStory[] }[] = [];
  for (const s of stories) {
    const shape = SHAPE[s.kind];
    const last = out[out.length - 1];
    if (shape === 'card') {
      if (last?.shape === 'cards') last.stories.push(s);
      else out.push({ shape: 'cards', stories: [s] });
    } else out.push({ shape, stories: [s] });
  }
  return out;
}

function dateline(day: string | null): string {
  const d = day ? new Date(`${day}T12:00:00Z`) : new Date();
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' });
}

function Masthead({ ed, personal }: { ed: DiscoverEdition; personal: boolean }) {
  return (
    <header className="border-b-2 border-ink pb-5 md:pb-7">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="eyebrow text-moss">{personal ? 'Discover · your edition' : 'Discover · Berlin'}</div>
        <div className="text-xs font-semibold text-sub tabular-nums">{dateline(ed.day)}</div>
      </div>
      <h1 className="mt-3 mb-0 max-w-[22ch] text-[32px] leading-[1.04] font-extrabold tracking-[-0.02em] text-balance md:text-[52px]">
        {ed.headline}
      </h1>
      {ed.lede && (
        <p className="mt-3 mb-0 max-w-[62ch] text-[17px] leading-[25px] text-pretty md:mt-4 md:text-[19px] md:leading-[29px]">
          {ed.lede}
        </p>
      )}
    </header>
  );
}

function KindLine({ kind, personal, className }: { kind: DiscoverKind; personal: boolean; className?: string }) {
  const k = KIND[kind];
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[11px] font-extrabold tracking-[.12em] text-moss uppercase',
        className,
      )}
    >
      <k.Icon className="size-3.5" strokeWidth={2.4} aria-hidden />
      {(!personal && k.publicLabel) || k.label}
    </div>
  );
}

/** The lead: the story the headline is about, its events numbered like a feature's running order. */
function LeadStory({ story, personal }: { story: DiscoverStory; personal: boolean }) {
  const cover = story.picks.map(imageOf).find(Boolean);
  return (
    <section id={anchor(story.key)} className="scroll-mt-20 border border-ink bg-surface">
      {cover && (
        <img
          src={cover}
          alt=""
          loading="lazy"
          className="block aspect-[16/7] w-full border-b border-ink object-cover"
        />
      )}
      <div className="p-4 md:p-5">
        <KindLine kind={story.kind} personal={personal} />
        <h2 className="mt-1.5 mb-0 text-[22px] leading-[26px] font-extrabold text-balance md:text-[26px] md:leading-[30px]">
          {story.title}
        </h2>
        <p className="mt-1.5 mb-0 text-[15px] leading-[21px] text-sub">{story.blurb}</p>
      </div>
      <ol className="m-0 list-none border-t border-line p-0">
        {story.picks.slice(0, 4).map((p, i) => (
          <li key={p.event.slug} className="border-b border-line last:border-b-0">
            <Link
              to="/e/$slug"
              params={{ slug: p.event.slug }}
              className="flex items-start gap-3 px-4 py-3 text-ink no-underline hover:bg-moss-soft md:px-5"
            >
              <span
                className="w-7 shrink-0 text-[26px] leading-[26px] font-extrabold text-moss tabular-nums"
                aria-hidden
              >
                {i + 1}
              </span>
              <PickText p={p} big />
              {personal && p.score != null && <ScoreBox score={p.score} />}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FocusPanel({ focus, stories }: { focus: DiscoverEdition['focus']; stories: DiscoverStory[] }) {
  const keys = new Set(stories.map((s) => s.key));
  return (
    <aside
      className="self-start border border-ink bg-ink p-4 text-on-ink md:sticky md:top-20 md:p-5"
      aria-label="Focus on"
    >
      <div className="eyebrow opacity-80">Focus on</div>
      <ol className="mt-3 mb-0 grid list-none gap-0 p-0">
        {focus.map((f, i) => (
          <li key={i} className="border-t border-on-ink/25 first:border-t-0">
            {f.story && keys.has(f.story) ? (
              <a href={`#${anchor(f.story)}`} className="group flex items-start gap-3 py-3 text-on-ink no-underline">
                <FocusText n={i + 1} text={f.text} />
                <ArrowRight
                  className="mt-0.5 size-4 shrink-0 opacity-70 transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </a>
            ) : (
              <div className="flex items-start gap-3 py-3">
                <FocusText n={i + 1} text={f.text} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

function FocusText({ n, text }: { n: number; text: string }) {
  return (
    <>
      <span className="text-[13px] leading-5 font-extrabold tabular-nums opacity-70">0{n}</span>
      <span className="flex-1 text-[16px] leading-[21px] font-bold text-balance">{text}</span>
    </>
  );
}

/** Title, then when and where, then the one fact worth knowing. */
function PickText({ p, big = false }: { p: DiscoverPick; big?: boolean }) {
  const e = p.event;
  const time = formatTime(e.next.startLocal, e.category);
  const price = formatPrice(e);
  return (
    <span className="min-w-0 flex-1">
      <span
        className={cn(
          'block font-bold [overflow-wrap:anywhere]',
          big ? 'text-[17px] leading-[21px]' : 'text-[15px] leading-[19px]',
        )}
        lang={e.lang}
      >
        {e.title}
      </span>
      <span className="mt-[3px] flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-sub tabular-nums">
        <CategoryDot category={e.category} />
        <b className="text-ink">{formatDay(e.next.startLocal)}</b>
        {time && <span>{time}</span>}
        {e.moreDates > 0 && <span>+{e.moreDates}</span>}
        {e.venueName && <span>· {e.venueName}</span>}
        {price && <span>· {price}</span>}
      </span>
      {p.about && <span className="mt-1 block text-[13.5px] leading-[18px] text-ink/85">{p.about}</span>}
      {p.note && <span className="mt-0.5 block text-[12.5px] font-bold text-moss">{p.note}</span>}
    </span>
  );
}

function StoryHead({ story, personal, more }: { story: DiscoverStory; personal: boolean; more?: ReactNode }) {
  return (
    <div className="grid gap-1">
      <KindLine kind={story.kind} personal={personal} />
      <h2 className="m-0 text-[21px] leading-[25px] font-extrabold text-balance md:text-[24px] md:leading-[28px]">
        {story.title}
      </h2>
      <p className="m-0 max-w-[60ch] text-[14.5px] leading-[20px] text-sub">{story.blurb}</p>
      {more}
    </div>
  );
}

/** A link to the story's whole list: Browse with its filter, or the venue's page. */
function BrowseMore({ story }: { story: DiscoverStory }) {
  const cls = 'mt-1 inline-flex w-fit items-center gap-1 text-xs font-extrabold tracking-[.06em] text-moss uppercase';
  const label = (
    <>
      See all <ArrowRight className="size-3.5" aria-hidden />
    </>
  );
  if (story.kind === 'weekend')
    return (
      <Link to="/" search={{ when: 'weekend' }} className={cls}>
        {label}
      </Link>
    );
  if (story.kind === 'art')
    return (
      <Link to="/" search={{ category: 'exhibition' }} className={cls}>
        {label}
      </Link>
    );
  if (story.kind === 'district' && story.subject)
    return (
      <Link to="/" search={{ district: story.subject, when: 'week' }} className={cls}>
        {label}
      </Link>
    );
  // A venue story's key is "venue-<venue id>" (services/discover.ts): its page has the whole programme.
  if (story.kind === 'venue' && story.key.startsWith('venue-'))
    return (
      <Link to="/venue/$id" params={{ id: story.key.slice('venue-'.length) }} className={cls}>
        {label}
      </Link>
    );
  if (story.kind === 'scene' && story.subject)
    return (
      <Link to="/" search={{ q: story.subject }} className={cls}>
        {label}
      </Link>
    );
  return null;
}

/** Ideas: a scene, a theme, what to book, art, something different. A framed card with a compact list. */
function CardStory({ story, personal, wide }: { story: DiscoverStory; personal: boolean; wide: boolean }) {
  return (
    <section
      id={anchor(story.key)}
      className={cn('scroll-mt-20 border border-ink bg-surface', wide && 'md:col-span-2')}
    >
      <div className="p-4 pb-3">
        <StoryHead story={story} personal={personal} more={<BrowseMore story={story} />} />
      </div>
      <ul className={cn('m-0 list-none border-t border-line p-0', wide && 'md:grid md:grid-cols-2')}>
        {story.picks.map((p) => (
          <li key={p.event.slug} className={cn('border-b border-line last:border-b-0', wide && 'md:odd:border-r')}>
            <Link
              to="/e/$slug"
              params={{ slug: p.event.slug }}
              className="flex items-start gap-3 px-4 py-2.5 text-ink no-underline hover:bg-moss-soft"
            >
              <PickText p={p} />
              {personal && p.score != null && <ScoreBox score={p.score} />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Dates: the weekend, what is new, what is free. A rail of small cards that scrolls sideways. */
function RailStory({ story, personal }: { story: DiscoverStory; personal: boolean }) {
  return (
    <section id={anchor(story.key)} className="grid scroll-mt-20 gap-3">
      <StoryHead story={story} personal={personal} more={<BrowseMore story={story} />} />
      <ul
        className="-mx-4 m-0 flex list-none snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:thin] md:mx-0 md:scroll-px-0 md:px-0"
        aria-label={story.title}
      >
        {story.picks.map((p) => {
          const img = imageOf(p);
          const time = formatTime(p.event.next.startLocal, p.event.category);
          return (
            <li key={p.event.slug} className="w-[min(72vw,236px)] shrink-0 snap-start">
              <Link
                to="/e/$slug"
                params={{ slug: p.event.slug }}
                className="flex h-full flex-col border border-ink bg-surface text-ink no-underline hover:bg-moss-soft"
              >
                {img ? (
                  <img
                    src={img}
                    alt=""
                    loading="lazy"
                    className="block aspect-[3/2] w-full border-b border-ink object-cover"
                  />
                ) : (
                  <div
                    className="hatch flex aspect-[3/1] items-end border-b border-ink p-2.5"
                    style={{ ['--hatch-angle' as string]: hatchAngle(p.event.slug) }}
                  >
                    <span className="bg-surface px-1.5 py-0.5 text-[13px] font-extrabold tabular-nums">
                      {formatDay(p.event.next.startLocal)}
                      {time && ` · ${time}`}
                    </span>
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-1 p-3">
                  {img && (
                    <span className="text-[12.5px] font-extrabold tabular-nums">
                      {formatDay(p.event.next.startLocal)}
                      {time && ` · ${time}`}
                    </span>
                  )}
                  <span
                    className="line-clamp-3 text-[15px] leading-[19px] font-bold [overflow-wrap:anywhere]"
                    lang={p.event.lang}
                  >
                    {p.event.title}
                  </span>
                  {p.event.venueName && <span className="text-[12.5px] text-sub">{p.event.venueName}</span>}
                  {p.about && <span className="line-clamp-3 text-[13px] leading-[17px] text-ink/85">{p.about}</span>}
                  <span className="mt-auto flex items-end justify-between gap-2 pt-1">
                    <span className="text-[12px] font-bold text-moss">{p.note ?? formatPrice(p.event) ?? ''}</span>
                    {personal && p.score != null && <ScoreBox score={p.score} />}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A place: a venue or a district. Its name set large, then its programme as a strip of dates. */
function StripStory({ story, personal }: { story: DiscoverStory; personal: boolean }) {
  return (
    <section id={anchor(story.key)} className="scroll-mt-20 border-y-2 border-ink">
      <div className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] md:gap-8 md:py-6">
        <div className="grid content-start gap-1">
          <KindLine kind={story.kind} personal={personal} />
          <h2 className="m-0 text-[30px] leading-[1.02] font-extrabold tracking-[-0.015em] text-balance md:text-[40px]">
            {story.title}
          </h2>
          <p className="mt-1 mb-0 text-[14.5px] leading-[20px] text-sub">{story.blurb}</p>
          <BrowseMore story={story} />
        </div>
        <ol className="m-0 list-none border border-ink bg-surface p-0">
          {story.picks.map((p) => {
            const time = formatTime(p.event.next.startLocal, p.event.category);
            return (
              <li key={p.event.slug} className="border-b border-line last:border-b-0">
                <Link
                  to="/e/$slug"
                  params={{ slug: p.event.slug }}
                  className="flex items-stretch text-ink no-underline hover:bg-moss-soft"
                >
                  <span className="grid w-[92px] shrink-0 content-center border-r border-line px-2.5 py-2 whitespace-nowrap tabular-nums">
                    <b className="text-[14px] leading-[18px]">{formatDay(p.event.next.startLocal)}</b>
                    <span className="text-[12px] text-sub">{time || '—'}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span
                        className="block text-[15px] leading-[19px] font-bold [overflow-wrap:anywhere]"
                        lang={p.event.lang}
                      >
                        {p.event.title}
                      </span>
                      {story.kind === 'district' && p.event.venueName && (
                        <span className="block text-[12.5px] text-sub">{p.event.venueName}</span>
                      )}
                      {p.about && (
                        <span className="mt-0.5 block text-[13px] leading-[17px] text-ink/85">{p.about}</span>
                      )}
                      {p.note && <span className="block text-[12.5px] font-bold text-moss">{p.note}</span>}
                    </span>
                    {personal && p.score != null && <ScoreBox score={p.score} />}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function EditionSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading Discover">
      <div className="grid gap-3 border-b-2 border-ink pb-5">
        <div className="h-3 w-40 bg-chip" />
        <div className="h-9 w-4/5 bg-chip" />
        <div className="h-9 w-3/5 bg-chip" />
        <div className="h-4 w-full max-w-[60ch] bg-chip" />
      </div>
      <div className="grid gap-4 md:grid-cols-[1.45fr_1fr]">
        <div className="hatch h-72 animate-pulse border border-ink motion-reduce:animate-none" />
        <div className="h-48 bg-ink opacity-80" />
      </div>
    </div>
  );
}
