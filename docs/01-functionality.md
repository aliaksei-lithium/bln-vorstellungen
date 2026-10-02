# 01 Functionality

## Who it is for

- **Owner** (you): configures sources, triages the feed, uploads posters, chats with the data via MCP.
- **A few friends/family accounts**: each gets their own taste profile and ranked feed. Expect fewer than 20 users.
- **Anonymous visitors**: see the public, non-personalized list of sourced events. No sign-up needed.

## Core loop

```
sources ──▶ raw items ──▶ extraction ──▶ events (+ occurrences) ──▶ enrichment ──▶ per-user scoring ──▶ feed / MCP
   ▲                                                                                      │
   └──────────────────── feedback (interested / skip / went / rating) ◀───────────────────┘
```

Every stage is idempotent and re-runnable. A re-run of a source never creates duplicate events.

## Feature list

### Sourcing (automatic)

- Scheduled polling of configured sources: websites (static or JS-rendered), RSS/Atom, iCal feeds, public Telegram
  channels, newsletters received by email, structured APIs (Resident Advisor GraphQL, Eventbrite, Bandsintown).
- Per-source schedule, enabled flag, last run status, item counts, error log.
- Dedup within a source (content hash) and across sources (fuzzy match on title + venue + date).
- Facebook: no reliable automated path exists any more without violating ToS. Supported only via manual input
  (share a screenshot/photo or paste the text). See [03 Sourcing](03-sourcing.md).

### Sourcing (manual)

- **Photo upload**: poster, flyer, magazine page, wall ad. Vision model extracts title, date(s), venue, performers,
  price, URL; a web research step confirms and fills gaps; result is proposed for review.
- **Paste text / URL**: same pipeline, text input.
- **Via MCP**: `add_event`, `add_event_from_image`, `add_source` from a chat.
- All manual inputs land in a **review queue** when extraction confidence is below a threshold.

### Enrichment

- Canonical venue record with address, coordinates, district, website (geocoded once, cached).
- Performer/artist records linked to MusicBrainz / Spotify IDs where possible; genres, popularity.
- Web research per event (bounded): official page, ticket link, price, sold-out status, description in DE and EN.
- Tagging: category (concert, club, theatre, opera, dance, exhibition, talk, cinema, festival, market, other),
  genres, audience hints (family, English-friendly, free entry).

### Personalization

- Taste profile per user: free-text preferences ("I like chamber music, contemporary dance, avoid techno"),
  structured toggles (categories, max price, home district, max travel), imported Spotify top artists/genres,
  and implicit signals from feedback.
- Scoring per (user, event): 0–100 score, short "why this matches" explanation, "why not" when below threshold.
- Feedback actions: interested, maybe, skip, hide forever, went, rate 1–5, note. Feedback refines the profile.
- Notifications (phase 2): weekly digest email, "something you'd like was just added".

### Public view

- Date-grouped list (today, tomorrow, this week, later), category and district filters, text search, map toggle.
- Event detail: when/where/who/how much, source links, AI summary, similar events.
- Calendar export (iCal) of the public list and per-user "interested" list.

### Personal view (signed in)

- **Inbox**: newly scored events ranked for you, triage with keyboard or swipe. This is the main screen.
- **Agenda**: everything you marked interested, by date, with conflicts flagged.
- **Explore**: the public list with your scores overlaid.
- **Profile**: taste text, toggles, Spotify import, connected sources, API keys for MCP.

### Admin (owner only)

- Sources: add/edit/run now/disable, see raw items and extraction results.
- Review queue: approve/merge/reject extracted events.
- Merge tool for duplicate events, venue and performer aliases.
- Usage dashboard: D1 rows read/written today, AI neurons used, Claude spend, cron and workflow runs.

### MCP (for Claude, Claude Code, other agents)

Full read/write over the same model: list, search, get, add, update, mark, run source, explain score. Details in
[06 MCP](06-mcp.md).

## Non-goals (for now)

- Ticket purchase. We link out.
- Social features between users.
- Native mobile apps. The web app must be excellent on a phone instead.
- Cities other than Berlin. The model is city-agnostic, but sources, geocoding bounds and UI copy assume Berlin.
