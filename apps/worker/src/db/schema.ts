import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * D1 schema per docs/04. Instants are UTC ISO strings; Berlin wall-clock times sit next to them as `*_local`.
 * AI outputs keep provenance: model, prompt_version and the raw item they came from.
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const updatedAt = () =>
  text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

/* ---------- auth (better-auth core tables, plural model names; wired up in phase 2) ---------- */

export const users = sqliteTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: text('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: text('access_token_expires_at'),
    refreshTokenExpiresAt: text('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const verifications = sqliteTable('verifications', {
  id: id(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_user_idx').on(t.userId)],
);

/* ---------- catalogue ---------- */

export const venues = sqliteTable('venues', {
  id: id(),
  name: text('name').notNull(),
  aliases: json<string[]>('aliases').notNull().default([]),
  address: text('address'),
  district: text('district'),
  lat: real('lat'),
  lng: real('lng'),
  url: text('url'),
  geocodeSource: text('geocode_source'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const performers = sqliteTable('performers', {
  id: id(),
  name: text('name').notNull(),
  aliases: json<string[]>('aliases').notNull().default([]),
  kind: text('kind', { enum: ['artist', 'band', 'ensemble', 'company', 'speaker'] }).notNull(),
  musicbrainzId: text('musicbrainz_id'),
  spotifyId: text('spotify_id'),
  genres: json<string[]>('genres').notNull().default([]),
  popularity: integer('popularity'),
  createdAt: createdAt(),
});

export const events = sqliteTable(
  'events',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    titleEn: text('title_en'),
    description: text('description'),
    descriptionEn: text('description_en'),
    lang: text('lang', { enum: ['de', 'en', 'other'] }).notNull(),
    category: text('category').notNull(),
    genres: json<string[]>('genres').notNull().default([]),
    venueId: text('venue_id').references(() => venues.id),
    priceMin: real('price_min'),
    priceMax: real('price_max'),
    isFree: integer('is_free', { mode: 'boolean' }).notNull().default(false),
    priceNote: text('price_note'),
    urlOfficial: text('url_official'),
    urlTickets: text('url_tickets'),
    imageKey: text('image_key'),
    status: text('status', { enum: ['draft', 'published', 'cancelled', 'merged'] })
      .notNull()
      .default('published'),
    mergedInto: text('merged_into'),
    firstStartAt: text('first_start_at'),
    lastStartAt: text('last_start_at'),
    /** Next non-cancelled date from now, kept fresh by resolve and the cron sweep; drives the public list. */
    nextStartUtc: text('next_start_utc'),
    nextStartLocal: text('next_start_local'),
    upcomingCount: integer('upcoming_count').notNull().default(0),
    dedupKey: text('dedup_key').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('events_status_first_idx').on(t.status, t.firstStartAt),
    index('events_dedup_idx').on(t.dedupKey),
    index('events_venue_idx').on(t.venueId),
    index('events_next_idx').on(t.nextStartUtc),
    index('events_category_next_idx').on(t.category, t.nextStartUtc),
  ],
);

export const occurrences = sqliteTable(
  'occurrences',
  {
    id: id(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    startLocal: text('start_local').notNull(),
    startUtc: text('start_utc').notNull(),
    endLocal: text('end_local'),
    doorsLocal: text('doors_local'),
    note: text('note'),
    status: text('status', { enum: ['scheduled', 'cancelled', 'sold_out'] })
      .notNull()
      .default('scheduled'),
  },
  (t) => [
    uniqueIndex('occurrences_event_start_uq').on(t.eventId, t.startUtc),
    index('occurrences_start_idx').on(t.startUtc),
    index('occurrences_event_idx').on(t.eventId),
  ],
);

export const eventPerformers = sqliteTable(
  'event_performers',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    performerId: text('performer_id')
      .notNull()
      .references(() => performers.id, { onDelete: 'cascade' }),
    role: text('role'),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.performerId] })],
);

export const tags = sqliteTable('tags', {
  id: id(),
  name: text('name').notNull().unique(),
});

export const eventTags = sqliteTable(
  'event_tags',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.tagId] })],
);

export const eventEmbeddings = sqliteTable('event_embeddings', {
  eventId: text('event_id')
    .primaryKey()
    .references(() => events.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  dims: integer('dims').notNull(),
  vector: blob('vector', { mode: 'buffer' }).notNull(),
  textHash: text('text_hash').notNull(),
  createdAt: createdAt(),
});

export const enrichments = sqliteTable(
  'enrichments',
  {
    id: id(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    rawItemId: text('raw_item_id'),
    payload: json<Record<string, unknown>>('payload').notNull(),
    citations: json<{ url: string; title?: string }[]>('citations').notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index('enrichments_event_idx').on(t.eventId)],
);

/* ---------- sourcing ---------- */

export const sources = sqliteTable(
  'sources',
  {
    id: id(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: json<Record<string, unknown>>('config').notNull(),
    scheduleMinutes: integer('schedule_minutes').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    cursor: text('cursor'),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    ownerUserId: text('owner_user_id').references(() => users.id),
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('public'),
    stats: json<Record<string, number>>('stats').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sources_due_idx').on(t.enabled, t.nextRunAt)],
);

export const sourceRuns = sqliteTable(
  'source_runs',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    status: text('status', { enum: ['running', 'ok', 'error'] }).notNull(),
    fetched: integer('fetched').notNull().default(0),
    newItems: integer('new_items').notNull().default(0),
    eventsCreated: integer('events_created').notNull().default(0),
    eventsUpdated: integer('events_updated').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('source_runs_source_idx').on(t.sourceId, t.startedAt)],
);

export const uploads = sqliteTable('uploads', {
  id: id(),
  userId: text('user_id').references(() => users.id),
  r2Key: text('r2_key').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  status: text('status', { enum: ['uploaded', 'processing', 'extracted', 'failed'] })
    .notNull()
    .default('uploaded'),
  createdAt: createdAt(),
});

export const rawItems = sqliteTable(
  'raw_items',
  {
    id: id(),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    uploadId: text('upload_id').references(() => uploads.id),
    externalId: text('external_id').notNull(),
    contentHash: text('content_hash').notNull(),
    kind: text('kind', { enum: ['text', 'html', 'markdown', 'image', 'ical', 'json'] }).notNull(),
    content: text('content'),
    r2Key: text('r2_key'),
    url: text('url'),
    publishedAt: text('published_at'),
    fetchedAt: text('fetched_at').notNull(),
    extractionStatus: text('extraction_status', { enum: ['pending', 'done', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
  },
  (t) => [
    uniqueIndex('raw_items_source_hash_uq').on(t.sourceId, t.contentHash),
    index('raw_items_source_status_idx').on(t.sourceId, t.extractionStatus),
  ],
);

export const eventSources = sqliteTable(
  'event_sources',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    rawItemId: text('raw_item_id')
      .notNull()
      .references(() => rawItems.id, { onDelete: 'cascade' }),
    extracted: json<Record<string, unknown>>('extracted').notNull(),
    confidence: real('confidence').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.rawItemId] })],
);

export const reviewQueue = sqliteTable(
  'review_queue',
  {
    id: id(),
    kind: text('kind', { enum: ['low_confidence', 'possible_duplicate', 'manual'] }).notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    eventId: text('event_id').references(() => events.id, { onDelete: 'set null' }),
    rawItemId: text('raw_item_id').references(() => rawItems.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['open', 'approved', 'merged', 'rejected'] })
      .notNull()
      .default('open'),
    resolvedBy: text('resolved_by'),
    resolvedAt: text('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [index('review_queue_status_idx').on(t.status)],
);

/* ---------- per user ---------- */

export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  tasteText: text('taste_text').notNull().default(''),
  prefs: json<Record<string, unknown>>('prefs').notNull().default({}),
  spotify: json<Record<string, unknown>>('spotify'),
  profileEmbedding: blob('profile_embedding', { mode: 'buffer' }),
  profileVersion: integer('profile_version').notNull().default(1),
  updatedAt: updatedAt(),
});

export const userEventState = sqliteTable(
  'user_event_state',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['inbox', 'interested', 'maybe', 'skipped', 'hidden', 'went'] }).notNull(),
    occurrenceId: text('occurrence_id').references(() => occurrences.id, { onDelete: 'set null' }),
    rating: integer('rating'),
    note: text('note'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index('user_event_state_idx').on(t.userId, t.state)],
);

export const userEventScores = sqliteTable(
  'user_event_scores',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    reasons: json<{ kind: 'for' | 'against' | 'rule'; text: string; weight?: number }[]>('reasons')
      .notNull()
      .default([]),
    model: text('model'),
    promptVersion: text('prompt_version'),
    profileVersion: integer('profile_version').notNull(),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index('user_event_scores_rank_idx').on(t.userId, t.score)],
);

export const usageCounters = sqliteTable(
  'usage_counters',
  {
    day: text('day').notNull(),
    metric: text('metric').notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] })],
);
