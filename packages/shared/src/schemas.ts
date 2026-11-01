import { z } from 'zod';

/** Single source of truth for event shapes, API payloads and MCP tool inputs. See docs/03 and docs/04. */

/** `kink` is opt-in: see OPT_IN_CATEGORIES. */
export const Category = z.enum([
  'concert',
  'club',
  'kink',
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

/** A photo or pasted text turned into candidate events for review (docs/09, 2026-11-01 "Scans"). */
export const ScanStatus = z.enum(['queued', 'reading', 'ready', 'failed', 'done']);
export const Scan = z.object({
  id: z.string(),
  kind: z.enum(['photo', 'text']),
  status: ScanStatus,
  createdAt: z.string(),
  candidates: z.array(ExtractedEvent),
  /** After confirming: what was added and what merged into events that were already listed. */
  result: z
    .object({
      added: z.number(),
      merged: z.number(),
      events: z.array(z.object({ slug: z.string(), title: z.string(), created: z.boolean() })),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type Scan = z.infer<typeof Scan>;

export const ScanText = z.object({ text: z.string().trim().min(10, 'Paste a bit more text.').max(20000) });
export const ScanCreated = z.object({ id: z.string() });
export type ScanCreated = z.infer<typeof ScanCreated>;
export const ScanConfirm = z.object({ events: z.array(ExtractedEvent).min(1, 'Pick at least one event.').max(100) });
export type ScanConfirm = z.infer<typeof ScanConfirm>;

/** AI spend for the owner's overview (Me page). Whole site, not per user; days are UTC. */
export const UsageDay = z.object({
  day: z.string(),
  claudeUsd: z.number(),
  claudeCalls: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  neurons: z.number(),
  extractCalls: z.number(),
  scoreCalls: z.number(),
});
export type UsageDay = z.infer<typeof UsageDay>;
export const UsageOverview = z.object({
  /** Oldest first; the last one is today. */
  days: z.array(UsageDay),
  claudeDailyUsd: z.number().nullable(),
  neuronBudget: z.number(),
  models: z.object({ extract: z.string(), score: z.string() }),
});
export type UsageOverview = z.infer<typeof UsageOverview>;

/** Read-only overview of where events come from, for signed-in users (Me page). No URLs or settings. */
export const SourceSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  everyMinutes: z.number(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  /** Upcoming events this source contributed to. */
  upcoming: z.number(),
});
export type SourceSummary = z.infer<typeof SourceSummary>;
export const SourcesOverview = z.object({ sources: z.array(SourceSummary) });
export const SourceSwitch = z.object({ on: z.boolean() });
export type SourcesOverview = z.infer<typeof SourcesOverview>;

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

/** Admin API: create a source. The schedule defaults to the adapter's own interval. */
export const SourceCreate = SourceConfig.extend({ scheduleMinutes: SourceConfig.shape.scheduleMinutes.optional() });
export type SourceCreate = z.infer<typeof SourceCreate>;

/** Partial update; no defaults here, so omitted fields stay as they are. */
export const SourceUpdate = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  scheduleMinutes: SourceConfig.shape.scheduleMinutes.optional(),
  enabled: z.boolean().optional(),
  visibility: SourceVisibility.optional(),
});
export type SourceUpdate = z.infer<typeof SourceUpdate>;

export const SourceView = SourceConfig.extend({
  id: z.string(),
  cursor: z.string().nullable(),
  nextRunAt: UtcInstant.nullable(),
  lastRunAt: UtcInstant.nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  stats: z.record(z.string(), z.number()),
});
export type SourceView = z.infer<typeof SourceView>;

export const SourceRunView = z.object({
  id: z.string(),
  workflowId: z.string().nullable(),
  startedAt: UtcInstant,
  finishedAt: UtcInstant.nullable(),
  status: z.enum(['running', 'ok', 'error']),
  fetched: z.number(),
  newItems: z.number(),
  eventsCreated: z.number(),
  eventsUpdated: z.number(),
  error: z.string().nullable(),
});
export type SourceRunView = z.infer<typeof SourceRunView>;

/* ---------- API payloads ---------- */

export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(['ok', 'error']),
  dbLatencyMs: z.number(),
  time: UtcInstant,
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Several values: "concert,theatre" in a query string, an array in code. Any of them matches. */
const anyOf = <T extends z.ZodType>(item: T) =>
  z
    .preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : v,
      z.array(item).max(12),
    )
    .optional();

export const Via = z.enum(['telegram', 'scans', 'spotify']);
export type Via = z.infer<typeof Via>;

export const EventsQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  category: anyOf(Category),
  district: anyOf(z.string().max(40)),
  q: z.string().max(100).optional(),
  /** Only events that came this way: Telegram channels, added by people from photos and text, my Spotify artists. */
  via: anyOf(Via),
  /** Opaque, from the previous page's `nextCursor`. */
  cursor: z.string().max(100).optional(),
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
  /** Language of the title, for correct hyphenation of long German words. */
  lang: Lang.optional(),
  /** Ids of the sources that list this event (none for events added from photos and text). */
  sources: z.array(z.string()).optional(),
});
export type EventListItem = z.infer<typeof EventListItem>;

export const EventsResponse = z.object({ items: z.array(EventListItem), nextCursor: z.string().nullable() });
export type EventsResponse = z.infer<typeof EventsResponse>;

/** Similar events and search by meaning: a short ranked list, no paging. */
export const EventsList = z.object({ items: z.array(EventListItem) });
export type EventsList = z.infer<typeof EventsList>;

export const EventDetail = Event.extend({
  venue: Venue.nullable(),
  occurrences: z.array(Occurrence),
  performers: z.array(Performer.pick({ id: true, name: true, kind: true })),
});
export type EventDetail = z.infer<typeof EventDetail>;

/* ---------- people (phase 2) ---------- */

/** Pre-defined users only: the owner creates them, they sign in with one-time login links (docs/09). */
export const Me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  isOwner: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const MeResponse = z.object({ user: Me.nullable() });
export type MeResponse = z.infer<typeof MeResponse>;

export const LoginRequest = z.object({ token: z.string().min(20).max(200) });

/** Optional passwords (docs/09, 2026-11-01): sign in with email and password once one is set. */
export const PasswordLogin = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});
export type PasswordLogin = z.infer<typeof PasswordLogin>;
export const PasswordSet = z.object({
  password: z.string().max(200),
  /** Needed when a password is already set. */
  current: z.string().max(200).optional(),
});
export type PasswordSet = z.infer<typeof PasswordSet>;
export const PasswordStatus = z.object({ set: z.boolean() });

/** Spotify connection (docs/09, 2026-11-01): the artists that boost ranking and back the "My artists" filter. */
export const SpotifyStatus = z.object({
  connected: z.boolean(),
  syncedAt: z.string().nullable(),
  /** Top artists first, then followed ones. */
  artists: z.array(z.string()),
  /** Genres read from those artists, most weight first; added to the taste behind the scenes. */
  genres: z.array(z.string()).default([]),
});
export type SpotifyStatus = z.infer<typeof SpotifyStatus>;
export type PasswordStatus = z.infer<typeof PasswordStatus>;

export const LoginLink = z.object({ url: z.url(), expiresAt: UtcInstant });
export type LoginLink = z.infer<typeof LoginLink>;

export const UserCreate = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(200),
  owner: z.boolean().default(false),
});
export type UserCreate = z.infer<typeof UserCreate>;

export const TASTE_MAX = 600;

export const Prefs = z.object({
  /** Categories the user never wants to see in the inbox. */
  categoriesOff: z.array(Category).default([]),
  /** Events whose lowest price is above this are filtered out. Null = no limit. */
  maxPrice: z.number().int().min(0).max(1000).nullable().default(null),
  /** Opt-in categories (OPT_IN_CATEGORIES) the user switched on; all others in that list stay hidden. */
  categoriesOn: z.array(Category).default([]),
  /**
   * How often a category should come up in the inbox and picks; missing means often. Off is `categoriesOff` (or not
   * being in `categoriesOn` for opt-in ones). See FREQUENCY_MIN_SCORE.
   */
  frequency: z.partialRecord(Category, z.enum(['less', 'rarely'])).default({}),
  /**
   * Sources this user switched off: an event all of whose sources are off leaves their Browse, inbox and picks; their
   * agenda keeps it. Set through PUT /api/me/sources/:id, never by saving the taste.
   */
  sourcesOff: z.array(z.string()).default([]),
});
export type Prefs = z.infer<typeof Prefs>;

export const Profile = z.object({
  tasteText: z.string().max(TASTE_MAX),
  prefs: Prefs,
  /** Bumps on every change; scores computed for an older version are recomputed. */
  version: z.number().int(),
});
export type Profile = z.infer<typeof Profile>;

export const ProfileUpdate = z.object({ tasteText: z.string().max(TASTE_MAX), prefs: Prefs });
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

export const UserState = z.enum(['interested', 'maybe', 'skipped', 'hidden', 'went']);
export type UserState = z.infer<typeof UserState>;

export const Reason = z.object({ kind: z.enum(['for', 'against', 'rule']), text: z.string() });
export type Reason = z.infer<typeof Reason>;

export const ScoredItem = EventListItem.extend({
  score: z.number().int().min(0).max(100),
  reasons: z.array(Reason),
});
export type ScoredItem = z.infer<typeof ScoredItem>;

export const InboxResponse = z.object({
  items: z.array(ScoredItem),
  /** Scored upcoming events in range, sorted or not; `done` of them already have a state. */
  total: z.number().int(),
  done: z.number().int(),
  /** Events still waiting for a score (embedding or scoring run pending). */
  pending: z.number().int(),
  /** False until the user has described their taste; ranking needs it. */
  hasTaste: z.boolean(),
});
export type InboxResponse = z.infer<typeof InboxResponse>;

/** The signed-in user's marks by event slug, for showing them on list rows. */
export const MyStates = z.object({ states: z.record(z.string(), UserState) });
export type MyStates = z.infer<typeof MyStates>;

export const StateUpdate = z.object({
  /** Null removes the state (undo). */
  state: UserState.nullable(),
  occurrenceId: z.string().nullish(),
});
export type StateUpdate = z.infer<typeof StateUpdate>;

/** The signed-in user's view of one event: score, reasons and their own state. */
export const MyEvent = z.object({
  score: z.number().int().nullable(),
  reasons: z.array(Reason),
  state: UserState.nullable(),
  occurrenceId: z.string().nullable(),
});
export type MyEvent = z.infer<typeof MyEvent>;

export const AgendaItem = z.object({
  slug: z.string(),
  title: z.string(),
  category: Category,
  venueName: z.string().nullable(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  isFree: z.boolean(),
  state: z.enum(['interested', 'maybe']),
  occurrenceId: z.string(),
  startLocal: LocalDateTime,
  endLocal: LocalDateTime.nullable(),
});
export type AgendaItem = z.infer<typeof AgendaItem>;

export const AgendaResponse = z.object({ items: z.array(AgendaItem) });
export type AgendaResponse = z.infer<typeof AgendaResponse>;

export const CalendarLink = z.object({ url: z.url() });
