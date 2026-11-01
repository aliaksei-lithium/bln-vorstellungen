import { hasTime, type AgendaItem, type Category } from '@bln/shared';

/**
 * iCalendar export of an agenda (RFC 5545). Times are Berlin wall-clock with TZID, so calendar apps keep 20:00 at
 * 20:00 across the DST switch; a VTIMEZONE block is included for apps that do not know IANA names.
 */

/** Typical length when a source gives no end time, in minutes. */
const DURATION: Partial<Record<Category, number>> = {
  club: 300,
  opera: 180,
  theatre: 150,
  concert: 150,
  dance: 120,
  cinema: 130,
  talk: 90,
  exhibition: 90,
};

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

const stamp = (local: string) => `${local.replace(/[-:]/g, '').slice(0, 13)}00`;
const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** Folds lines at 75 octets as the RFC requires (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function addMinutes(local: string, minutes: number): string {
  const ms = Date.parse(`${local}:00Z`) + minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 16);
}

export function agendaIcs(items: AgendaItem[], origin: string, name: string, now = new Date()): string {
  const dtstamp = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const events = items.flatMap((it) => {
    const end = it.endLocal ?? addMinutes(it.startLocal, DURATION[it.category] ?? 120);
    // No time from the source: an all-day entry instead of a fake midnight start.
    const when = hasTime(it.startLocal, it.category)
      ? [`DTSTART;TZID=Europe/Berlin:${stamp(it.startLocal)}`, `DTEND;TZID=Europe/Berlin:${stamp(end)}`]
      : [
          `DTSTART;VALUE=DATE:${it.startLocal.slice(0, 10).replace(/-/g, '')}`,
          `DTEND;VALUE=DATE:${addMinutes(it.startLocal, 24 * 60)
            .slice(0, 10)
            .replace(/-/g, '')}`,
        ];
    return [
      'BEGIN:VEVENT',
      `UID:${it.occurrenceId}@bln-vorstellungen`,
      `DTSTAMP:${dtstamp}`,
      ...when,
      `SUMMARY:${escapeText(it.state === 'maybe' ? `(maybe) ${it.title}` : it.title)}`,
      ...(it.venueName ? [`LOCATION:${escapeText(`${it.venueName}, Berlin`)}`] : []),
      `URL:${origin}/e/${it.slug}`,
      `STATUS:${it.state === 'maybe' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT',
    ];
  });
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BLN Vorstellungen//Agenda//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    ...VTIMEZONE,
    ...events,
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n')
    .concat('\r\n');
}
