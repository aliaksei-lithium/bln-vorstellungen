import {
  CATEGORY_LABELS,
  clashes,
  formatDateTime,
  formatPrice,
  type AgendaItem,
  type EventDetail,
  type EventListItem,
  type MyEvent,
  type Reason,
} from '@bln/shared';

/**
 * Compact markdown for MCP tool results (docs/06: the client model pays for every token). One line per event, with
 * a link the user can open and the slug the model needs for get_event and mark_event.
 */

type Row = EventListItem & { score?: number | null; reasons?: Reason[] };

const link = (origin: string, slug: string) => `${origin}/e/${slug}`;

export function eventLine(origin: string, e: Row): string {
  const parts = [
    formatDateTime(e.next.startLocal, e.category),
    e.venueName && (e.district ? `${e.venueName} (${e.district})` : e.venueName),
    formatPrice(e),
    CATEGORY_LABELS[e.category],
    e.moreDates > 0 ? `+${e.moreDates} more dates` : null,
    e.score != null ? `score ${e.score}` : null,
  ].filter(Boolean);
  const why = e.reasons?.find((r) => r.kind !== 'rule')?.text;
  return `- [${e.title}](${link(origin, e.slug)}) · ${parts.join(' · ')}${why ? ` — ${why}` : ''} · \`${e.slug}\``;
}

export const eventLines = (origin: string, rows: Row[]) => rows.map((r) => eventLine(origin, r)).join('\n');

export function eventMarkdown(origin: string, e: EventDetail, mine: MyEvent | null, now = new Date()): string {
  const upcoming = e.occurrences.filter((o) => o.status !== 'cancelled' && Date.parse(o.startUtc) >= now.getTime());
  const price = formatPrice(e);
  const lines = [
    `# ${e.title}`,
    [CATEGORY_LABELS[e.category], ...e.genres].join(', '),
    e.venue
      ? `Venue: ${e.venue.name}${e.venue.address ? `, ${e.venue.address}` : ''}${e.venue.district ? ` (${e.venue.district})` : ''}`
      : null,
    price ? `Price: ${price}${e.priceNote ? ` (${e.priceNote})` : ''}` : null,
    e.performers.length ? `With: ${e.performers.map((p) => p.name).join(', ')}` : null,
    `Link: ${link(origin, e.slug)}`,
    e.urlTickets ? `Tickets: ${e.urlTickets}` : e.urlOfficial ? `Official page: ${e.urlOfficial}` : null,
    `Slug: \`${e.slug}\` · Language: ${e.lang}`,
  ];
  if (mine) {
    lines.push(
      '',
      mine.score != null ? `**Score for you: ${mine.score}/100**` : 'Not scored for you yet.',
      ...mine.reasons.map(
        (r) => `- ${r.kind === 'against' ? 'Against' : r.kind === 'rule' ? 'Rule' : 'For'}: ${r.text}`,
      ),
      mine.state ? `Your mark: ${mine.state}` : '',
    );
  }
  lines.push(
    '',
    upcoming.length ? `## Dates (${upcoming.length})` : '## No upcoming dates',
    ...upcoming
      .slice(0, 30)
      .map(
        (o) =>
          `- ${formatDateTime(o.startLocal, e.category)}${o.note ? ` — ${o.note}` : ''}${o.status === 'sold_out' ? ' (sold out)' : ''}`,
      ),
    upcoming.length > 30 ? `- … and ${upcoming.length - 30} more` : '',
  );
  if (e.description) lines.push('', '## About', e.description.slice(0, 1500));
  return lines
    .filter((l) => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function agendaMarkdown(origin: string, items: AgendaItem[]): string {
  if (!items.length) return 'The agenda is empty. Mark events as interested or maybe to put them here.';
  const clash = clashes(items);
  return items
    .map((a) => {
      const parts = [formatDateTime(a.startLocal, a.category), a.venueName, formatPrice(a), a.state].filter(Boolean);
      const warn = clash.get(a.occurrenceId);
      return `- [${a.title}](${link(origin, a.slug)}) · ${parts.join(' · ')}${warn ? ` · ⚠ clashes with ${warn}` : ''} · \`${a.slug}\``;
    })
    .join('\n');
}
