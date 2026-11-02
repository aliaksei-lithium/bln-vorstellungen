# 09 Decisions

Format: date · decision · why · alternatives rejected. Newer entries supersede older ones on the same topic.

- **2026-10-02 · TypeScript, not Kotlin, for the backend.** Cloudflare's runtime and every binding/SDK we need are
  JS-first; Kotlin would run only via Wasm or Kotlin/JS with hand-written shims and no tooling. Rejected: Kotlin/Wasm
  on Workers; Ktor on a VPS (breaks "Cloudflare, free"). Kotlin stays an option for a future KMP mobile client.
- **2026-10-02 · One Worker for API, static site, MCP, cron, email.** Simplest deploy and cheapest. Rejected:
  separate Pages project + API Worker (Pages is in maintenance mode in favour of Workers static assets); separate
  MCP Worker (can be split later behind the OAuth provider's split API if needed).
- **2026-10-02 · Workflows instead of Queues.** Queues require Workers Paid; Workflows are free and give retries and
  step state. Rejected: DO alarms as a job queue (works but reinvents retries).
- **2026-10-02 · No Vectorize.** Paid-plan only. Embeddings stored in D1, cosine computed over the upcoming-events
  candidate set. Revisit if upcoming events exceed ~10k.
- **2026-10-02 · D1 over DO-SQLite as the main store.** D1 gives one shared relational DB with migrations, FTS5 and
  the dashboard; DO SQLite is per-object. DO still used for MCP sessions and locks.
- **2026-10-02 · HTML parsing happens off-Worker.** The 10 ms CPU cap on the free plan makes DOM parsing of large
  pages risky. Use `env.AI.toMarkdown` with `cssSelector`, Browser Rendering `/markdown`, or JSON-LD. Rejected:
  cheerio/linkedom in-Worker (fine for small pages; allowed only behind a size guard).
- **2026-10-02 · Event vs. occurrence model.** Theatre and opera are the core use case; one production has many
  Vorstellungen. Rejected: one row per date (duplicates in lists and scoring).
- **2026-10-02 · better-auth for web and MCP auth.** One system, social login, D1 adapter, `mcp` plugin for OAuth
  and `apiKey` plugin for tokens. Alternative kept open: `@cloudflare/workers-oauth-provider` v1 for MCP if the
  better-auth plugin proves unreliable on Workers.
- **2026-10-02 · Claude Haiku 4.5 as the default extraction/scoring model; Opus 5.5 for interactive, judgment-heavy
  calls.** Driven by the "keep it free" constraint; per-source model override allowed.
- **2026-10-02 · Facebook has no automated adapter.** No public events API, scraping violates ToS and breaks
  constantly. Manual photo/text input only.
- **2026-10-02 · Telegram via `t.me/s/<channel>` HTML preview.** No bot or API credentials; works for public
  channels. Rejected: MTProto client (needs a phone session; not free-tier friendly on Workers).
- **2026-10-30 · Design direction D ("strict cards", Moss accent, TV-tower background).** Chosen by the owner
  over A–C after a clickable mockup (`design/mockup-d`, deployed as the separate Worker
  `bln-vorstellungen-mockup`). Square 1px ink frames, Figtree, see-through rows over the tower; shadcn tokens are
  mapped onto D's palette in `apps/web/src/index.css`.
- **2026-10-30 · Phase 0 tooling, verified while scaffolding.** `@cloudflare/vitest-pool-workers` is deprecated and
  renamed to `@cloudflare/vitest-plugin` (Vitest 4; `env`/`exports` now come from `cloudflare:workers`); CLAUDE.md's
  mention means this package. TypeScript pinned to 6.0 because typescript-eslint does not support 7 yet. Node 25 no
  longer ships corepack, so pnpm is installed globally. better-auth core tables are created up front with plural
  names (`users`, `sessions`, `accounts`, `verifications`); configure better-auth with `usePlural: true` in phase 2.
  FTS5 (`events_fts`) is maintained by the resolve step, not by triggers, because it needs venue and performer names.
- **2026-10-31 · Resolve matches on title + venue, not on the first date.** docs/04's `dedup_key` includes the
  first date, which would split a production whose 12 Vorstellungen arrive as 12 feed items (Gorki publishes it
  that way). The key keeps the docs/04 format, but resolve looks up its `title|venue|` prefix and merges into the
  most recent such event if its last date is at most 90 days ago. A band returning to the same club after a
  longer gap becomes a new event. The 0.6–0.9 similarity review (`possible_duplicate`) is deferred to phase 3,
  where LLM-extracted titles make it worth it.
- **2026-10-31 · Public list pages through `events.next_start_*`.** Scanning occurrences cost up to 2,400 rows
  per page (measured, 120 events × 6 dates). `events` now carries `next_start_utc`, `next_start_local` and
  `upcoming_count`, refreshed by resolve and by a sweep in the 15-min cron (only events whose next date passed).
  "All upcoming" pages through `events_next_idx` with a cursor; date windows (today/weekend/week) still scan
  occurrences, with the index forced (`INDEXED BY` + `CROSS JOIN`) because the planner otherwise starts from all
  events. Measured rows read per page: 82 default, 80 category, 160 district, 120 search, 164 week window
  (`test/list-budget.test.ts` fails above 500). Rejected: a plain `GROUP BY event` over occurrences.
- **2026-10-31 · Workers Caching instead of the Cache API.** The Cache API does nothing on `workers.dev`. Workers
  Caching (`cache.enabled` in wrangler.jsonc) caches by `Cache-Control`, also on `workers.dev`, keyed by Worker
  version. Public event responses: `public, max-age=60, s-maxage=120` + `Cache-Tag: events`; every other `/api`
  response defaults to `no-store` (otherwise heuristic caching would apply). Trade-off: with caching on, static
  asset requests count as Worker requests (fine against 100k/day at hobby volume). A purge after each source run
  needs a call from the fetch entrypoint (purges are per entrypoint); not worth it at a 2-min TTL.
- **2026-10-31 · Admin API gated by `Authorization: Bearer <ADMIN_TOKEN>`** until owner sign-in (phase 2). The
  `Authorization` header also makes Workers Caching bypass, so admin responses are never cached.
- **2026-10-31 · Structured adapters, no LLM.** `ical` (minimal RRULE: DAILY/WEEKLY with COUNT/UNTIL/BYDAY/EXDATE
  on wall-clock time; DTSTAMP/SEQUENCE dropped before hashing so unchanged events stay unchanged) and `jsonld`
  (indexOf scan for blocks, so 1 MB pages stay cheap; tolerant of sloppy offsets like `+1:00` and of raw line
  breaks in JSON). Both send `If-None-Match`/`If-Modified-Since` from the cursor. Category: item type → title
  keywords → source default → description keywords → `other`. `rss` stores entries as `pending` raw items for
  LLM extraction in phase 3. Closing-day placeholders ("HEUTE GESCHLOSSEN") are skipped.
- **2026-10-31 · Starter sources (`apps/worker/seed/sources.sql`).** Verified on this date: The Left Berlin
  (iCal), Luma Berlin discover feed (iCal), Maxim Gorki Theater, A-Trane, Privatclub, Bar jeder Vernunft
  (JSON-LD). Checked and not usable without the `html` adapter: berlin-buehnen.de (403), Berliner Ensemble,
  Staatsoper, Deutsches Theater, Volksbühne, Konzerthaus, SO36, Berghain, Lido, Astra and others (no feed, no
  JSON-LD). Komische Oper links one `.ics` per performance; a `sitemap`-style adapter could follow those.
- **2026-10-31 · Workflow step budget.** Workers Free allows 3,000 Workflow steps per day and 1,024 per instance.
  A SourceRun is start + fetch + one step per 8 new items + finish; unchanged feeds cost 3 steps (most answer
  304). Six sources at 6–12 h intervals use well under 100 steps a day after the first import (~50 steps).
- **2026-10-31 · Extraction runs on Workers AI until a Claude key exists.** docs/05 names Claude Haiku 4.5 for
  extraction; there is no Anthropic key yet, and Workers AI is free within 10k neurons a day. Model:
  `@cf/google/gemma-4-26b-a4b-it` with thinking off (`chat_template_kwargs.enable_thinking=false`: 2 s and
  3 neurons instead of 16 s and 18 on the same answer). Output via `json_object` mode with the schema in the
  prompt: strict `json_schema` mode looped on whitespace until max_tokens in 2 of 12 golden runs and tripled
  output tokens. Requiring every schema field made the model invent end times and doors, so only essentials are
  required and `extract.ts` backfills doors, single prices and free entry from the quoted text. Costs measured
  on real pages: ~65–200 neurons per 16k-character chunk, ~60 s. Spend is metered in `usage_counters` and capped
  at 8,000 neurons/day (`DAILY_NEURON_BUDGET`); items left over stay `pending` for the next run. All calls go
  through the auto-created `default` AI Gateway. Swapping in Claude later = a second provider in `ai/models.ts`.
- **2026-10-31 · Golden examples run through the dev server, not Vitest.** The Worker tests have no remote
  bindings, so `pnpm --filter @bln/worker golden` (with `RUN_AI_TESTS=1`) posts `test/ai/extract.golden.json` to
  the admin dry-run endpoint and checks titles, categories, date counts, doors and prices. ~80 neurons per run.
- **2026-10-31 · Embeddings: bge-m3, int8, one KV index.** `@cf/baai/bge-m3` (multilingual, ~0.01 neurons per
  event). Vectors are L2-normalized and quantized to int8 (1 KB per event) in `event_embeddings`; the cron embeds
  new upcoming events and packs all upcoming vectors into one KV value, rebuilt when stale or every 6 h. "More
  like this" and search by meaning scan it in memory: zero D1 rows, one KV read per isolate per 10 min. Floors
  checked by hand: related events score 0.45–0.6, unrelated below 0.4. Revisit (Vectorize on a paid plan, or
  per-category shards) past ~5k upcoming events.
- **2026-10-31 · `html` adapter = Markdown chunks.** Page → `env.AI.toMarkdown` (optional `cssSelector`) →
  images and empty links stripped → chunks of 16k characters at paragraph boundaries, at most `maxChunks` per
  page. With a single-venue source the venue comes from the config; the model's venue (often the room) becomes
  the date's note. Starter html sources: Berliner Ensemble, Deutsches Theater, Staatsoper (daily).
- **2026-10-31 · Claude goes through AI Gateway with a stored key (BYOK), not a Worker secret.** The same `env.AI`
  binding calls `anthropic/claude-haiku-5.5` in Anthropic Messages format; AI Gateway takes the Anthropic key
  stored under Provider Keys with alias `default`, so the Worker never holds it, and adds logs, cost analytics,
  caching, retries and dollar spend limits for free. Without a stored key the gateway answers "Insufficient AI
  Gateway credits" (verified), so extraction falls back to Workers AI per item. Opt-in via `EXTRACT_MODEL` in
  wrangler.jsonc vars; our own cap `CLAUDE_DAILY_USD` (default $0.50) is metered in `usage_counters`. Haiku 5.5
  ($0.10/$0.50 per M tokens, cheaper than the Haiku 4.5 docs/05 planned for) uses structured outputs
  (`output_config.format`, closed schema), effort `low`, thinking off, cacheable system prompt. Rejected: a
  `ANTHROPIC_API_KEY` Worker secret calling api.anthropic.com directly (no gateway logs/limits, key in the Worker).
- **2026-11-01 · Extraction switched to Claude Haiku 5.5** (owner's Anthropic key stored on the gateway). Same
  6/6 golden examples on both models; on a real Deutsches Theater chunk Claude took 16 s against 58 s, kept per-date
  notes (room, premiere, "nur noch wenige Karten") and cost $0.003 (15 events against Gemma's 17). Expected spend
  for the three theatre pages: ~$0.025/day. Workers AI stays the per-item fallback and still runs embeddings.
- **2026-11-01 · Pre-defined users with one-time login links; supersedes "better-auth for web and MCP auth"
  (2026-10-02) for the web.** The owner wants invite-only accounts, no Google/GitHub, no registration. The owner
  creates users (`POST /api/admin/users`) and gets a login link; opening it signs in for 180 days (sliding). Links
  work once, expire after 7 days and are redeemed by a POST from the page, so chat-app link previews cannot use
  them up. A signed-in user can mint a link for another device. Passwords were rejected: PBKDF2/scrypt costs more
  CPU than the free plan's 10 ms per request, and there would be resets to build. Only SHA-256 hashes of link,
  session and calendar tokens are stored (reusing the `verifications`, `sessions` and `api_keys` tables). The admin
  API accepts an owner session or the `ADMIN_TOKEN` bearer. Cross-site writes are refused on Origin mismatch.
  MCP auth (API keys) stays as planned for phase 3.
- **2026-11-01 · Scoring as built.** Stage 1 per user: category/price filters from prefs, then cosine(taste
  embedding, event embedding) mapped linearly from 0.30-0.60 to 0-60 (hand-checked: taste-to-event cosines sit lower
  than event-to-event ones). Stage 2: the 60 best candidates with base >= 15 go to `SCORE_MODEL` (Claude Haiku 5.5)
  in batches of 20, numbered rather than by id so the model cannot invent ids; reply must cover at least half the
  batch or it is retried. Every score row stores the profile version; saving the taste bumps it and re-scores in the
  background. The cron dispatches a run per user when new events were embedded. Measured locally with a real taste
  text: 233 events scored, 60 by Claude, top matches with concrete reasons, about $0.01. Spotify boosts and feedback
  learning are still to come.
- **2026-11-01 · 00:00 means "no time known".** Date-only sources store midnight. The UI shows only the day for
  those, Agenda skips them in clash checks, and the calendar feed writes all-day entries. Clubs are the exception:
  a club night can really start at 00:00. `hasTime()` in `packages/shared` is the one place this rule lives.
- **2026-11-01 · MCP: stateless handler + OAuth in the same Worker; supersedes the MCP parts of "better-auth for
  web and MCP auth" and of docs/06 "Transport".** `createMcpHandler` (Agents SDK, MCP SDK v2) instead of `McpAgent`,
  which is now deprecated and feature-frozen; no Durable Object is needed, so the `McpAgent` class is deleted.
  Authorization is `@cloudflare/workers-oauth-provider` (`OAuthAuthorizationServer` + `OAuthResourceServer`, both in
  this Worker, issuer = the site's origin, resource = `<origin>/mcp`). Grants live in a separate `OAUTH_KV`
  namespace (a handful of writes per connection and per hourly token refresh). The `/authorize` page is a consent
  page for the already signed-in user (same login link + session cookie as the site); no new identity provider.
  Clients register by Client ID Metadata Document or by DCR. Scopes: `mcp:read` (lists, search, agenda) and
  `mcp:write` (triage, taste). Static API keys are deferred: Claude.ai and Claude Code both do OAuth. Tools call
  `src/services/*`, the same functions as the REST API.
- **2026-11-01 · Opt-in category for sex-positive and kink parties.** New category `kink` ("Sex-positive & kink"),
  off by default for everyone: left out of public lists, search (keyword and meaning), "more like this" and MCP
  results, and scored 0 in the inbox, unless a signed-in user turns it on in Me (`prefs.categoriesOn`). A separate
  opt-in list rather than a default in `categoriesOff`, so users who saved prefs before stay opted out. Public list
  responses stay user-independent and cacheable: an explicit `category=kink` request returns them, and the web app
  only offers that filter to users who opted in. Event pages stay reachable by link. Classified by keywords
  (fetish, BDSM, sex-positive, play party…) before `club`, and by the extraction prompt (extract@6).
- **2026-11-01 · Scans: photo and pasted text, reviewed before anything is added.**
  The browser resizes photos to at most 2400 px on the long edge (JPEG) before upload, so the Worker never decodes
  images. `POST /api/me/scans` stores the image in R2 (`uploads` + `raw_items` kind `image`, or kind `text`) and a
  `scans` row (new table: user, kind, status queued/reading/ready/failed/done, candidates JSON, model, prompt
  version), then starts `PhotoIngestWorkflow`. The workflow sends the image to Claude Haiku 5.5 through AI Gateway
  (base64 via `Buffer`, native), with the extract@6 rules plus photo rules (`photo@1`: every entry of a listing,
  year headings such as "2027", day-only dates, multi-day fairs with opening hours as one event per day, presenter
  lines are not titles). Output is mapped with `toExtracted`. The review page `/scan/$id` polls, lists candidates
  with checkboxes and inline edits; confirming runs `resolveEvent` with `createdBy: user:<id>`, so duplicates merge.
  No Workers AI vision fallback: when the Claude budget is spent the scan fails with a clear message. Test set: five
  photos from 2026-11-01 (magazine kink calendar, two concert listing pages, a promoter list into 2027, a poster):
  8/8, 42/42, 56/56 and 12/12 events read, the past poster explained as "no upcoming dates", about $0.003 a photo.
  One wrong performer (copied from the next entry) is why the review page edits performers too.
- **2026-11-01 · Price is neutral in ranking unless the user set a limit (score@2).** An empty "At most … €" meant no
  limit for the rules, but the scoring model still saw prices and rewarded free events on its own ("Free small art
  exhibition…"). The prompt now says price counts only against a stated limit. Scores keep their prompt version;
  a score from an older prompt counts as stale, and the cron re-scores everyone once per new prompt version (KV
  flag `rescored:<version>`).
- **2026-11-01 · Optional passwords; supersedes "No passwords" in "Pre-defined users with one-time login links".**
  Opening a new link on every device was too much friction. Users still start from a login link; signed in, they
  can set a password on the Me page and then sign in with email and password. Hash: PBKDF2-SHA256 through
  WebCrypto, 30,000 iterations and a 16-byte salt per password, stored as `pbkdf2-sha256$<iterations>$<salt>$<hash>`
  in `accounts.password` (provider `credential`). That is far below OWASP's 600k, chosen because 100k took 13.5 ms of
  CPU and the free plan allows 10 ms per request. The difference is made up by at least 10 characters, 5 wrong tries
  per account per 15 minutes (rows in `verifications`), the same answer and a dummy hash for unknown emails, and a
  stored cost that is raised on the next sign-in if the constant goes up. Passkeys (one signature check, under 1
  ms) remain the better long-term option.
- **2026-11-01 · How often per category, and a mixed inbox.** Too much theatre: four of nine sources are theatres
  with nightly programmes, and a category was only on or off. `prefs.frequency` adds `less` (inbox and picks only
  from score 60) and `rarely` (from 75); `often` is the default and off stays `categoriesOff`. Applied at read time in
  the inbox query and its counts, so changing a level needs no re-scoring. The inbox order then goes through
  `mixCategories`: no category holds more than a third of the places so far, but an event only jumps ahead when it
  scores within 15 points of the best one left, so mixing never lifts a weak match over a strong one; none is
  dropped. Browse is unchanged except for off. Rejected for now: weekly caps per category (harder to explain,
  needs per-week counting). The lasting fix is more non-theatre sources.
- **2026-11-01 · Telegram adapter as built, and a Browse filter by source kind.** `telegram` reads
  `t.me/s/<channel>` (about 20 latest posts), split by plain string matching (no DOM, well under the CPU limit).
  Cursor = highest post number, so a run hands over only new posts. Text posts are bundled into ~10k-character
  items, one LLM call per bundle instead of per post (tested: 20 posts became 2 calls); a post with a photo and
  under 280 characters of text is a flyer and goes through photo reading (at most 5 per run). Relative dates are
  read from each post's published date (extract@7). Browse gets a Source filter by kind, not by single venue:
  Telegram channels, Added from photos & text, and Spotify once it exists (`EventsQuery.via`, from provenance).
  After the first real channels (2026-11-01): a photo post whose text has no date is read from the flyer however
  long the text; channels can carry a `venueHint` (a soft default, unlike `venue`); one night with several acts is
  one event (extract@8); the same night under another title merges on same venue + start + a shared act (concert-
  type categories only, company credits ignored); a flyer the image host refuses with 5xx stays pending for the next
  run instead of failing. We fetch as ourselves (our user agent), never as a browser.
- **2026-11-01 · Spotify: artists, not listening history.** Authorization code flow on the server (client secret as
  a Worker secret), scopes `user-top-read user-follow-read` only. We keep the refresh token (`accounts`, provider
  `spotify`) and store top (6 months) then followed artists in `user_artists`. An event by one of them (same
  performer name; for concert-type events also a title that is or starts with the name) scores 92 in the rule
  stage with "You listen to … on Spotify", no model call; the scoring model also sees the top 15 names, so similar
  acts rank higher. "My Spotify artists" is a Browse source filter (per user, never cached publicly). The app is in
  Spotify's development mode: up to 25 users, each added by email in Spotify's dashboard.
  Music taste from Spotify is used implicitly: genres of the user's artists (weighted by rank) and the leading
  artists join the taste embedding and the scoring prompt, never the user's own taste text; the Me page shows what
  was added. Spotify as a concert source is not possible (no public concerts API); Bandsintown's artist events,
  fed with these artists, is the candidate for later (needs an app id).
- **2026-11-01 · The inbox is a short round, not a queue.** Opening it fixes a round of the 5 best picks plus 2
  "something different" (best-scored events from categories none of the five has, score 25-70); sorting removes
  one, "Show more picks" starts another round. No counts, no progress bar, no badge on the nav. Supersedes the
  "12 of 40" triage queue of docs/07.
- **2026-11-01 · Filters add up; meetups count as talks; installable app.** Within a Browse filter group the choices
  add up (any of them matches): `category`, `district` and `via` take comma lists in the API and the address.
  Luma's feed is mostly tech meetups, hackathons and barcamps, which the keyword classifier left as `other`, so a
  switched-off Talk did not hide them: those words now mean `talk`, Luma's source falls back to `talk`, and the inbox
  leaves out switched-off categories at read time (not only through scores). The site is a PWA: manifest, icons
  (192/512, maskable), iOS home-screen tags, and a service worker that only keeps the app shell (network first,
  never the API).
- **2026-11-01 · Sources can be switched off per user.** `prefs.sourcesOff` (set only through
  `PUT /api/me/sources/:id`, so saving the taste never undoes it). An event leaves a user's Browse, inbox and picks
  when every source that lists it is off; events added by people from photos and text are never hidden this way, and
  the agenda and event pages keep everything. List rows carry their source ids (public, cacheable), the inbox filters
  at read time; no re-scoring.
- **2026-11-01 · Saved default Browse filters.** `prefs.browseDefault` holds an address query (filter keys only,
  via `PUT /api/me/browse-default`). Browse applies it when it opens with no filters in the address, once per visit,
  so "Clear all" still shows everything until the next visit. Separate from the category levels on Me: a user can
  keep theatre out of Browse while strong theatre picks still reach the inbox.
- **2026-11-01 · Source links, and "Close to my Spotify taste".** Sources show a link to the page behind them (an
  explicit `config.link`, the Telegram channel, or the URL without feed parameters). The taste filter
  (`via=spotifylike`) matches concert-type events whose text mentions a genre of the user's Spotify artists (whole
  genres plus distinctive words; broad ones like "pop" or "indie" left out), or whose meaning is at least 0.5 close
  to the music-taste line (vector cached in KV until the artists change). Meaning alone was tried first and rejected:
  from 0.38 it returned jazz trios and R&B for a shoegaze/punk taste, the scores being flat (0.39-0.48).
  @berlingigs can't be read: its public web preview is off, and reading it would need a Telegram account.
- **2026-11-01 · Scan insights: ranked by taste with genres, "More", "Listen", playlists.** Reading a scan also ranks
  its candidates for the user (`scanRank@1`: score, one reason, 0-3 genres; batches of 20 in parallel; best effort,
  falling back to the extractor's genres). They are stored in `scans.insights`, one entry per candidate with model
  and prompt version. The review page sorts best first ("As read" switches back) and marks up to 5 top picks (score 60
  or more). "More" is on demand, never in bulk on read, so a 50-event listing costs one ranking call per 20 events
  and nothing else until asked. It looks the acts up on Spotify (exact name only; app token, cached per name for a
  week) and writes a 2-3 sentence note (`scanMore@1`) kept on the scan; "Explain top 5" asks for them one after
  another. "Listen" (`/spotify/listen?artist=`) redirects to the artist page, else to Spotify's search. Playlists:
  scope `playlist-modify-private` added (older connections must reconnect), two tracks per act by exact artist name,
  first acts of every ticked event first, at most 25 events and 40 acts (the free plan's 50 subrequests). Spotify's
  2026 API changes shape this: no top-tracks endpoint, so tracks come from search; playlist items go to
  `/playlists/{id}/items`; artist genres may be empty; and a development-mode app serves at most 5 users.
- **2026-11-02 · Visitors get source switches; event pages name their sources and add dates to calendars.**
  `GET /api/sources` lists public, enabled sources for everyone; a new `sources.default_off` marks the ones a visitor
  starts without (Privatclub, A-Trane, The Left Berlin, Bar jeder Vernunft). A visitor's switches live in their
  browser (localStorage); until they touch one, the defaults apply. Signed-in users keep `prefs.sourcesOff` and are not
  affected by the defaults. Event pages list their public sources with links, or "Added from a photo or text". Each
  date offers "Add to calendar": a Google Calendar link built in the browser, or `GET /api/events/:slug/ics?date=`
  (one VEVENT, Berlin wall-clock with TZID, all-day when the source gave no time). Both work without signing in.
- **2026-11-02 · Daily highlights; Inbox becomes "For you".** Each morning (cron, first tick after 05:00 Berlin) a
  `DailyReviewWorkflow` per user with a taste, plus one public edition. Step 1, free: candidates from the user's
  scores for the next 6 months (public: members' average score as a sign of interest, nudged by sold-out dates,
  several sources, far ahead; events only listed by venues visitors start without stay out), each with facts the
  score does not show: days ahead, dates left, sold-out dates, sources, a clash with the agenda. Step 2: Claude Haiku
  with the web search tool (`web_search_20250305`, at most 4 searches, ~$0.04; skipped when the day's Claude budget
  is short) looks up reviews and demand for the strongest few. Step 3: one structured call (`review@1`) picks at most
  10 events in at most 4 category sections, each with a kind (book early, made for you, last chance, critics, check
  your plan, something new) and a one-line why; "book early" closer than 3 weeks is relabelled in code. Stored in
  `user_reviews` / `public_reviews` with model and prompt versions; read back without events that passed or were
  hidden or skipped since. The Inbox tab is renamed "For you" (`/for-you`, `/inbox` redirects): Highlights and Quick
  picks (the old deck). Visitors see the public edition. Users may ask for today's highlights once a day; the owner
  can start runs at `POST /api/admin/reviews/run`. MCP gets `my_highlights`.
- **2026-11-02 · Invite requests; visitor opt-ins.** Visitors can ask for an invite (name, email, what they like;
  honeypot field, 30 requests a day site-wide, one pending per email). The owner answers on the Me page or through
  MCP (`list_invite_requests`, `invite_requester`, `decline_invite_request`, owner only): inviting creates the account
  with the note as a first taste and returns a one-time login link to send. Nothing is emailed: Cloudflare Email
  Sending needs a domain onboarded to the account, and the site lives on workers.dev; with a domain, a `send_email`
  binding can notify the owner. Deutsches Theater joins the venues visitors start without. Visitors can switch on the
  opt-in "Sex-positive & kink" category in their browser (off by default), which adds its Browse filter.
- **2026-11-02 · Event images, kept only while the event is on.** Resolve keeps the source's image URL
  (`events.image_src`: JSON-LD `image`, iCal `ATTACH`, a Telegram flyer when the post has one event). Events from HTML
  pages get their official page's `og:image`, else the first photo in the page (largest srcset entry up to 1600 px;
  logos, icons and blur placeholders skipped). The cron takes 10 a run, soonest first: fetch, shrink once with the
  Images binding to one WebP of at most 800 px (q72), store in R2 under `events/<id>/<hash of URL>.webp`, served at
  `/api/img/…` as immutable. A failed image is tried again a day later; past events (2 days after their last date),
  merged and cancelled ones lose theirs. Shown on the event page (whole, on the hatch) and in highlights.
  Measured on the local copy of production (298 upcoming events): 240 got an image (80%; the misses are DT pages
  without a photo and events from photos or text), 37 KB on average, 147 KB at most, 8.7 MB in all. Cost: R2 holds
  only the live programme, ~10–100 MB of the 10 GB free; one transformation per new event, ~1–3k a month of the 5,000
  free (over the limit, Images returns 9422 on the free plan and charges nothing; the event waits a day); R2 writes
  and deletes ~2 per event of 1M free; reads one per image view of 10M free, fewer with Workers Caching. $0 a month.
  Keeping past images would grow R2 by ~50 MB a month for pages nobody opens, so they are dropped. Rows in lists show it
  as their 48 px thumbnail (lazy; the hatch stays behind it and without one).
- **2026-11-02 · Discover: a daily editorial page.** A new tab `/discover` (between Browse and For you) reads like a
  magazine page instead of a list: a headline and lede, the lead story beside a short "Focus on" list (two or three
  concrete things to do, each linking to its story), then stories laid out by what they are: rails for dates (this
  weekend, just added, free), a programme strip for a place (a venue, a district), and framed cards in two columns
  for ideas (a scene, a theme, book ahead, art, beyond your usual). On wide screens the page widens to 1080 px; other
  tabs keep 600 px. The stories are computed, not chosen by a model: from the user's scored events for the next 120
  days (public: the members' average score plus demand, events only default-off sources list left out), claimed in
  order so each event appears once: book ahead (6+ weeks, strong or sold out), up to two scenes (genres, minus words
  like "Premiere" that name a format), a venue (not one that already carries a scene), the weekend, art, beyond the
  usual (outside the reader's two most common strong categories), just added (7 days), free (14 days), a district
  (this week). Each pick carries one fact (sold-out dates, dates left, free, new). Then one structured Claude Haiku
  call (`discover@1`, ~4k tokens in, ~1k out, about $0.001 an edition, metered as `ai_discover_calls`) writes the
  titles, blurbs, headline, lede and focus, and may group 3 to 5 loose events into a theme; on any failure the
  template copy stands, so a page always exists. It runs as the first step of `DailyReviewWorkflow` (its own step,
  so it never holds up the highlights); a user's first edition is built on the spot from the template. Stored in
  `discover_editions` (audience = user id or `public`, one per Berlin day, 14 days kept); read back like the
  highlights (passed, hidden, skipped and switched-off-source events drop out; visitors' own switches apply in the
  browser). `GET /api/discover` (public, cached 5 min), `GET /api/me/discover`, `POST /api/admin/discover/run`.
  The copy uses the review's model (`SCORE_MODEL`, Haiku): at a tenth of a cent an edition, editorial copy is where
  quality shows; Workers AI stays the automatic fallback inside `callJson`. Rejected: clustering live per request
  (the copy would no longer match the stories).
- **2026-11-02 · Fifteen more sources; each source says where its images are.** Found by a research pass that
  fetched every candidate (Berlin Gig Guide and The Next Day on Substack, field notes, Madame Claude, Badehaus,
  SO36, Index Berlin, Cassiopeia, KM28, HAU, Radialsystem, Siegessäule's sex calendar, Lab.oratory, RAZAM,
  @standupberlin). Bot walls ruled out berlin-buehnen.de, Rausgegangen, Resident Advisor, Stressfaktor and Radar;
  JavaScript-only pages ruled out the Philharmonie and tip. Each candidate page was dry-run through
  `/api/admin/extract` from production before it was added. SO36's shop publishes `tickets.json`, read by a new
  `ticketshop` adapter without an LLM; RAZAM's iCal also lists Munich and online events, so iCal sources take a
  `city`; RSS cleans only the entries it keeps (`maxItems`), since a Substack feed carries every post in full (1 MB).
  Images: a source's `image_mode` (`auto`: its own image, else the event's page; `feed`: its own only; `none`) is set
  once per source, so pages that never have an image are not fetched for each new event. Luma and Berliner Ensemble
  start on `feed` (their pages gave nothing for 47 and 19 events).
- **2026-11-02 · Community filters, starting with Belarusian.** Browse's filter sheet gets a Community group; the first
  chip is "Belarusian", marked with the white-red-white flag (drawn: there is no emoji for it, and 🇧🇾 is the
  official flag). `via=belarusian` lists events from sources marked `community = 'belarusian'` (RAZAM) and any event
  whose text mentions Belarus in English, German, Belarusian or Russian, or Minsk (FTS prefix match). A community is
  a column on the source, not a hardcoded id, so another community is one value and one chip.
- **2026-11-02 · The kink category is labelled "XXX".** "Sex-positive & kink" overflowed the category chip in event
  rows. The id stays `kink`; where someone switches it on (Me), a hint says what it covers.
- **2026-10-02 · React + Vite + TanStack + Tailwind + shadcn/ui.** Best coverage by design tools and implementing
  models. Rejected: SvelteKit (good, but weaker design-tool output), Next.js on Workers via OpenNext (heavier than
  needed; no SSR requirement since public pages can be cached JSON + client render; revisit if SEO matters).
