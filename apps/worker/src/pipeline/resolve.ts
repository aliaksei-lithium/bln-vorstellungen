import {
  berlinLocalToUtc,
  dedupKey,
  districtFromAddress,
  normalizeTitle,
  slugify,
  type ExtractedEvent,
} from '@bln/shared';
import { refreshNextDate } from './next-dates';

/**
 * Resolve step (docs/03): match candidates against venues and existing events, then create or merge. Adapters
 * never write to D1; this module is the single place that does, so the DB contract lives here.
 *
 * Matching rule: same normalized title at the same venue = same event, as long as that event is still active
 * (its last date is at most MERGE_WINDOW_DAYS ago). A production with 12 Vorstellungen published as 12 separate
 * feed items therefore becomes one event with 12 occurrences. `dedup_key` keeps the docs/04 format
 * (title|venue|first date) and its prefix is what we look up.
 */

const MERGE_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export type Provenance = {
  rawItemId: string;
  /** "adapter:ical@1" for structured sources, the model id for LLM extraction. */
  model: string;
  promptVersion: string | null;
  createdBy: string;
};

/** Feed locations that are not places. */
const NO_VENUE = /^(online|virtual|livestream|zoom|tba|tbd|to be announced|n\/a|berlin)$/i;

type VenueRow = { id: string; name: string; aliases: string; address: string | null };

/** All venues, keyed by normalized name and aliases. Loaded once per resolve step (a few hundred rows). */
export class VenueIndex {
  private byKey = new Map<string, VenueRow>();
  private constructor(private db: D1Database) {}

  static async load(db: D1Database): Promise<VenueIndex> {
    const idx = new VenueIndex(db);
    const { results } = await db.prepare('SELECT id, name, aliases, address FROM venues').all<VenueRow>();
    for (const v of results) idx.add(v);
    return idx;
  }

  private add(v: VenueRow) {
    const aliases = JSON.parse(v.aliases || '[]') as string[];
    for (const n of [v.name, ...aliases]) {
      const k = normalizeTitle(n);
      if (k && !this.byKey.has(k)) this.byKey.set(k, v);
    }
  }

  /** Exact or alias match on the normalized name; otherwise a new venue with the district read from the address. */
  async resolve(venue: ExtractedEvent['venue']): Promise<string | null> {
    if (!venue || NO_VENUE.test(venue.name.trim())) return null;
    const key = normalizeTitle(venue.name);
    if (!key) return null;
    const hit = this.byKey.get(key);
    if (hit) {
      if (!hit.address && venue.address) {
        hit.address = venue.address;
        await this.db
          .prepare('UPDATE venues SET address = ?, district = COALESCE(district, ?) WHERE id = ?')
          .bind(venue.address, districtFromAddress(venue.address), hit.id)
          .run();
      }
      return hit.id;
    }
    const row: VenueRow = { id: crypto.randomUUID(), name: venue.name, aliases: '[]', address: venue.address ?? null };
    await this.db
      .prepare('INSERT INTO venues (id, name, aliases, address, district) VALUES (?, ?, ?, ?, ?)')
      .bind(row.id, row.name, row.aliases, row.address, districtFromAddress(row.address))
      .run();
    this.add(row);
    return row.id;
  }
}

type ExistingEvent = { id: string; last_start_at: string | null };

export type ResolveResult = { eventId: string; created: boolean };

export async function resolveEvent(
  db: D1Database,
  venues: VenueIndex,
  ev: ExtractedEvent,
  prov: Provenance,
  now: Date = new Date(),
): Promise<ResolveResult> {
  const venueId = await venues.resolve(ev.venue);
  const occurrences = [...ev.occurrences].sort((a, b) => a.start.localeCompare(b.start));
  const firstLocal = occurrences[0]!.start;
  const prefix = `${normalizeTitle(ev.title)}|${venueId ?? '-'}|`;

  const existing = await db
    .prepare(
      `SELECT id, last_start_at FROM events
        WHERE dedup_key >= ? AND dedup_key < ? AND status != 'merged'
        ORDER BY last_start_at DESC LIMIT 1`,
    )
    .bind(prefix, `${prefix}￿`)
    .first<ExistingEvent>();
  const windowStart = new Date(now.getTime() - MERGE_WINDOW_DAYS * DAY_MS).toISOString();
  const match = existing && (!existing.last_start_at || existing.last_start_at >= windowStart) ? existing : null;

  const eventId = match?.id ?? crypto.randomUUID();
  const price = ev.price;
  const isFree = price?.free ? 1 : 0;
  const stmts: D1PreparedStatement[] = [];

  if (match) {
    // Merge: fill gaps, never overwrite what an earlier source (or a human) already set.
    stmts.push(
      db
        .prepare(
          `UPDATE events SET
             description = COALESCE(description, ?), price_min = COALESCE(price_min, ?),
             price_max = COALESCE(price_max, ?), is_free = MAX(is_free, ?),
             url_official = COALESCE(url_official, ?), url_tickets = COALESCE(url_tickets, ?),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`,
        )
        .bind(
          ev.description ?? null,
          price?.min ?? null,
          price?.max ?? null,
          isFree,
          ev.urls.official ?? null,
          ev.urls.tickets ?? null,
          eventId,
        ),
    );
  } else {
    const draft = ev.needsReview || ev.confidence < 0.6;
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (id, slug, title, description, lang, category, genres, venue_id, price_min, price_max,
             is_free, price_note, url_official, url_tickets, status, dedup_key, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          await uniqueSlug(db, ev.title, eventId),
          ev.title,
          ev.description ?? null,
          ev.lang,
          ev.category,
          JSON.stringify(ev.genres),
          venueId,
          price?.min ?? null,
          price?.max ?? null,
          isFree,
          price?.note ?? null,
          ev.urls.official ?? null,
          ev.urls.tickets ?? null,
          draft ? 'draft' : 'published',
          dedupKey(ev.title, venueId, firstLocal),
          prov.createdBy,
        ),
    );
    if (draft) {
      stmts.push(
        db
          .prepare(`INSERT INTO review_queue (id, kind, payload, event_id, raw_item_id) VALUES (?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), 'low_confidence', JSON.stringify(ev), eventId, prov.rawItemId),
      );
    }
  }

  for (const o of occurrences) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO occurrences (id, event_id, start_local, start_utc, end_local, doors_local, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id, start_utc) DO UPDATE SET
             end_local = COALESCE(excluded.end_local, end_local),
             doors_local = COALESCE(excluded.doors_local, doors_local),
             note = COALESCE(excluded.note, note)`,
        )
        .bind(
          crypto.randomUUID(),
          eventId,
          o.start.slice(0, 16),
          berlinLocalToUtc(o.start.slice(0, 16)),
          o.end?.slice(0, 16) ?? null,
          o.doorsAt?.slice(0, 16) ?? null,
          o.note ?? null,
        ),
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE events SET
           first_start_at = (SELECT MIN(start_utc) FROM occurrences WHERE event_id = ?1),
           last_start_at = (SELECT MAX(start_utc) FROM occurrences WHERE event_id = ?1)
         WHERE id = ?1`,
      )
      .bind(eventId),
    refreshNextDate(db, eventId, now),
  );

  stmts.push(...(await performerLinks(db, eventId, ev.performers)));

  stmts.push(
    db
      .prepare(
        `INSERT OR REPLACE INTO event_sources (event_id, raw_item_id, extracted, confidence, model, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(eventId, prov.rawItemId, JSON.stringify(ev), ev.confidence, prov.model, prov.promptVersion),
    // Keyword search row, rebuilt from the merged event so it also covers performers and venue from other sources.
    db.prepare('DELETE FROM events_fts WHERE event_id = ?').bind(eventId),
    db
      .prepare(
        `INSERT INTO events_fts (event_id, title, description, performers, venue)
         SELECT e.id, e.title, COALESCE(e.description, ''),
                COALESCE((SELECT group_concat(p.name, ' ') FROM event_performers ep
                          JOIN performers p ON p.id = ep.performer_id WHERE ep.event_id = e.id), ''),
                COALESCE(v.name, '')
           FROM events e LEFT JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`,
      )
      .bind(eventId),
  );

  await db.batch(stmts);
  return { eventId, created: !match };
}

async function uniqueSlug(db: D1Database, title: string, eventId: string): Promise<string> {
  const base = slugify(title);
  const taken = await db.prepare('SELECT 1 FROM events WHERE slug = ?').bind(base).first();
  return taken ? `${base}-${eventId.slice(0, 6)}` : base;
}

/** Links performers by case-insensitive name, creating the missing ones. */
async function performerLinks(
  db: D1Database,
  eventId: string,
  performers: ExtractedEvent['performers'],
): Promise<D1PreparedStatement[]> {
  const list = performers.slice(0, 20);
  if (!list.length) return [];
  const { results } = await db
    .prepare(`SELECT id, name FROM performers WHERE name COLLATE NOCASE IN (${list.map(() => '?').join(',')})`)
    .bind(...list.map((p) => p.name))
    .all<{ id: string; name: string }>();
  const known = new Map(results.map((r) => [r.name.toLowerCase(), r.id]));
  const stmts: D1PreparedStatement[] = [];
  list.forEach((p, position) => {
    let id = known.get(p.name.toLowerCase());
    if (!id) {
      id = crypto.randomUUID();
      known.set(p.name.toLowerCase(), id);
      stmts.push(db.prepare(`INSERT INTO performers (id, name, kind) VALUES (?, ?, 'artist')`).bind(id, p.name));
    }
    stmts.push(
      db
        .prepare('INSERT OR IGNORE INTO event_performers (event_id, performer_id, role, position) VALUES (?, ?, ?, ?)')
        .bind(eventId, id, p.role ?? null, position),
    );
  });
  return stmts;
}
