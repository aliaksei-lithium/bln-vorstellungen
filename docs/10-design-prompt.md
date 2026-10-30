# 10 Prompt for the Design agent

Paste everything below the line into Claude Design (or any design agent). Attach `docs/01-functionality.md` and
`docs/07-ui.md` if the tool accepts files; the prompt is self-contained without them.

---

You are designing the UI for **BLN Vorstellungen**, a personal event-discovery web app for Berlin. Work in three
steps: research, propose options, then detail the chosen option. Do not skip to a single design.

## What the product is

Events in Berlin (theatre, opera, concerts, clubs, exhibitions, talks) are collected automatically from websites,
RSS, Telegram channels and newsletters, or added manually by photographing a poster. An AI scores each event
against a user's taste profile (0–100) and writes a one-line reason. There are three audiences:

- **Anonymous visitors** see a public, non-personalized, date-grouped list.
- **Signed-in users** (fewer than 20, friends and family) get an **Inbox** of ranked events to triage
  (interested / maybe / skip), an **Agenda** of what they marked, and a **Profile** with a free-text taste
  description, toggles (categories, max price, home district), and a Spotify import.
- **The owner** has admin pages: sources list with run status, a review queue for low-confidence extractions, and
  a usage page with free-tier counters.

Domain detail that matters for layout: a theatre production is **one event with many performance dates**
("Vorstellungen"). Lists show the event once with "next: Fr 10.10. · 20:00 (+11 dates)"; the detail page lists
all dates.

## Screens to design (mobile and desktop for each)

1. Public list `/` – sticky filter bar (date chips: today, tomorrow, weekend, this week, pick range; category;
   district; search), events grouped by day, row = time · title · venue · category chip · price. Quiet "sign in for
   your picks" hint.
2. Event detail `/e/:slug` – title, next dates with expand-all, venue card with map link, performers, price,
   official/ticket links, AI summary, a small "sources" footnote listing where it was found, similar events.
   Signed-in: score badge, reasons, action bar.
3. Inbox `/inbox` – ranked cards: score, one reason line, title, next date, venue, actions. Progress indicator
   ("12 of 40"). Keyboard shortcuts on desktop (j/k, i, m, x, enter); swipe on mobile.
4. Agenda `/agenda` – interested and maybe items by day, conflict badge when two overlap, "subscribe to calendar".
5. Profile `/me` – taste text with example chips, toggles, Spotify connect, private sources, API keys.
6. Add `/add` – tabs: photo (camera on mobile), paste text, URL. Then a confirmation card showing the extracted
   event with editable fields and a confidence indicator.
7. Admin: sources table, review queue (extracted vs. existing side by side; approve / merge / reject), usage page
   with daily counters as simple bars.
8. Empty, loading and error states for list, inbox and add.

## Step 1 – Research

Study these and summarise in a short table what each does well and what to borrow or avoid:
Resident Advisor (ra.co/events/de/berlin), Rausgegangen (rausgegangen.de/en), DICE (dice.fm), Luma (lu.ma/berlin),
Berlin Bühnen (berlin-buehnen.de/en/schedule), Songkick, Letterboxd, Readwise Reader, Linear. Also look at how
Berlin sites format dates and prices. Note common patterns for date-grouped lists, multi-date events, and triage
queues. Keep the research to one screen of text.

## Step 2 – Propose three directions

Present three distinct visual directions as low-fidelity mockups of the public list and the Inbox (mobile first),
each with a name, a one-paragraph rationale, a palette, a type pairing and the trade-offs. Suggested axes to
differentiate, pick your own if better:

- A. "Programme": editorial, text-first, newspaper-like density, strong day headers, almost no images.
- B. "Cards": softer, card-based, small thumbnails, friendlier for the Inbox swipe flow.
- C. "Tool": utilitarian, Linear-like, compact rows, strong keyboard affordances, monochrome with one accent.

Recommend one and say why, given the audience (a few power users, lots of theatre and concert listings, phone use
on the way home).

## Step 3 – Detail the recommended direction

Deliver high-fidelity screens for all eight items above, mobile (390 px) and desktop (1280 px), light and dark.
Then a compact design-system sheet: colour tokens (neutral scale, one accent, semantic colours for score bands
and category chips), type scale, spacing, radius, the event row and event card components with all states, the
score badge, the action bar, filter chips, day header, empty states, and the toast pattern.

## Constraints

- Clean and modern. Neutral palette, one accent colour. Category colours only as small chips.
- **Minimal animation**: only state changes (hover/press, a 150 ms fade for sheets and toasts, swipe follow on
  mobile cards). No parallax, no scroll-triggered effects, no decorative motion.
- Mobile-first; thumb-reachable actions at the bottom; nothing depends on hover.
- Dense but calm: the public list should show 8–10 events per phone screen without feeling cramped.
- Accessibility: WCAG AA contrast in both themes, visible focus rings, 44 px tap targets, no information carried by
  colour alone (score badge shows the number).
- Dates and prices the Berlin way: `Fr 10.10. · 20:00`, `ab 18 €`, `frei`. UI language is English.
- Implementation stack is React + Tailwind + shadcn/ui; prefer shadcn primitives (Button, Badge, Sheet, Tabs,
  Command, Toggle, Card) and name them in the spec so the handoff maps one-to-one. Use a Google font with
  variable weights (e.g. Inter, Geist or Source Sans 3) and a tabular-figure setting for times and prices.
- No illustrations or stock photos. Event images appear only on the detail page and as optional small thumbnails.

## Output format

1. Research table.
2. Three directions with low-fi mobile mockups and a recommendation.
3. High-fidelity screens for the recommended direction, mobile and desktop, light and dark.
4. Design-system sheet with tokens as CSS variables and a component list mapped to shadcn/ui.
5. A short "open questions" list for the product owner.
