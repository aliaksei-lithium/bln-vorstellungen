import { z } from 'zod';

/** Single source of truth for event shapes, API payloads and MCP tool inputs. See docs/03 and docs/04. */

export const Category = z.enum([
  'concert',
  'club',
  'theatre',
  'opera',
  'dance',
  'exhibition',
  'talk',
  'cinema',
  'festival',
  'market',
  'other',
]);
export type Category = z.infer<typeof Category>;

export const Lang = z.enum(['de', 'en', 'other']);
export type Lang = z.infer<typeof Lang>;

/** "2026-10-30T20:00" — wall-clock time in Europe/Berlin, no offset. */
export const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:mm');
/** "2026-10-30T19:00:00.000Z" — a UTC instant. */
export const UtcInstant = z.iso.datetime();

export const EventStatus = z.enum(['draft', 'published', 'cancelled', 'merged']);
export const OccurrenceStatus = z.enum(['scheduled', 'cancelled', 'sold_out']);
export const PerformerKind = z.enum(['artist', 'band', 'ensemble', 'company', 'speaker']);

export const Venue = z.object({
  id: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  address: z.string().nullish(),
  district: z.string().nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  url: z.url().nullish(),
});
export type Venue = z.infer<typeof Venue>;

export const Performer = z.object({
  id: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  kind: PerformerKind,
  musicbrainzId: z.string().nullish(),
  spotifyId: z.string().nullish(),
  genres: z.array(z.string()).default([]),
});
export type Performer = z.infer<typeof Performer>;

export const Occurrence = z.object({
  id: z.string(),
  eventId: z.string(),
  startLocal: LocalDateTime,
  startUtc: UtcInstant,
  endLocal: LocalDateTime.nullish(),
  doorsLocal: LocalDateTime.nullish(),
  note: z.string().nullish(),
  status: OccurrenceStatus,
});
export type Occurrence = z.infer<typeof Occurrence>;

export const Event = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string().min(1),
  titleEn: z.string().nullish(),
  description: z.string().nullish(),
  descriptionEn: z.string().nullish(),
  lang: Lang,
  category: Category,
  genres: z.array(z.string()).default([]),
  venueId: z.string().nullish(),
  priceMin: z.number().nullish(),
  priceMax: z.number().nullish(),
  isFree: z.boolean(),
  priceNote: z.string().nullish(),
  urlOfficial: z.url().nullish(),
  urlTickets: z.url().nullish(),
  imageKey: z.string().nullish(),
  status: EventStatus,
  mergedInto: z.string().nullish(),
  firstStartAt: UtcInstant.nullish(),
  lastStartAt: UtcInstant.nullish(),
  dedupKey: z.string(),
  createdBy: z.string(),
  createdAt: UtcInstant,
  updatedAt: UtcInstant,
});
export type Event = z.infer<typeof Event>;

/** What the LLM extractor (or a structured adapter's mapItem) must produce. */
export const ExtractedEvent = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  lang: Lang,
  category: Category,
  genres: z.array(z.string()),
  occurrences: z
    .array(
      z.object({
        start: LocalDateTime,
        end: LocalDateTime.optional(),
        doorsAt: LocalDateTime.optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
  venue: z.object({ name: z.string().min(1), address: z.string().optional() }).nullable(),
  performers: z.array(z.object({ name: z.string().min(1), role: z.string().optional() })),
  price: z
    .object({
      min: z.number().nonnegative().optional(),
      max: z.number().nonnegative().optional(),
      currency: z.literal('EUR'),
      free: z.boolean().optional(),
      note: z.string().optional(),
    })
    .nullable(),
  urls: z.object({ official: z.url().optional(), tickets: z.url().optional() }),
  imageUrl: z.url().optional(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  sourceQuote: z.string(),
});
export type ExtractedEvent = z.infer<typeof ExtractedEvent>;

export const SourceVisibility = z.enum(['public', 'private']);

/** A `sources` row as created or edited by the owner. `config` is validated by the adapter's own schema. */
export const SourceConfig = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  scheduleMinutes: z
    .number()
    .int()
    .min(15)
    .max(7 * 24 * 60),
  enabled: z.boolean().default(true),
  visibility: SourceVisibility.default('public'),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

/* ---------- API payloads ---------- */

export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(['ok', 'error']),
  dbLatencyMs: z.number(),
  time: UtcInstant,
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const EventsQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  category: Category.optional(),
  district: z.string().optional(),
  q: z.string().max(100).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

/** One row of the public list: the event once, at its next occurrence in range. */
export const EventListItem = z.object({
  slug: z.string(),
  title: z.string(),
  category: Category,
  venueName: z.string().nullable(),
  district: z.string().nullable(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  isFree: z.boolean(),
  next: z.object({ startLocal: LocalDateTime, startUtc: UtcInstant }),
  moreDates: z.number().int().nonnegative(),
});
export type EventListItem = z.infer<typeof EventListItem>;

export const EventsResponse = z.object({ items: z.array(EventListItem) });
export type EventsResponse = z.infer<typeof EventsResponse>;

export const EventDetail = Event.extend({
  venue: Venue.nullable(),
  occurrences: z.array(Occurrence),
  performers: z.array(Performer.pick({ id: true, name: true, kind: true })),
});
export type EventDetail = z.infer<typeof EventDetail>;
