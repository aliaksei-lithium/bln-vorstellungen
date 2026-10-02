# 06 MCP server

Goal: from Claude.ai, Claude Code, or any MCP client, be able to ask "what's on this weekend that I'd like?", "add
this poster", "pause the Telegram source", "why did you score this 82?".

## Transport and hosting

- Endpoint: `https://<domain>/mcp`, streamable HTTP. Implemented with the Cloudflare Agents SDK (`McpAgent` on a
  SQLite-backed Durable Object, free) or, for the stateless protocol (MCP 2026-07-28), the Agents SDK's
  `createMcpHandler` factory. Start with `McpAgent`; it supports both legacy and 2026-07-28 clients.
- Auth: OAuth 2.1. Two viable implementations; pick one in phase 3:
  1. **better-auth `mcp` plugin** – the app is already the authorization server for web login, so MCP clients get the
     same Google/GitHub consent screen. One auth system. Known to run on Workers + D1 with recent fixes.
  2. **`@cloudflare/workers-oauth-provider` v1** (Oct 2026) – the Cloudflare-blessed path, split authorization
     server / resource server API, full MCP 2026-07-28 support. More moving parts if the app already has
     better-auth.
  Plus **API keys** (`Authorization: Bearer blnv_…`) for scripts and Claude Code's header-based config. Keys map
  to a user and a scope set.
- Scopes: `events:read`, `events:write`, `sources:manage` (owner), `profile:write`.

## Tools

Read:
- `list_events({from, to, category?, district?, query?, minScore?, state?, limit})` → compact rows with score for the
  caller. Defaults: from=today, to=+14d, limit=30.
- `search_events({query, from?, to?})` → hybrid FTS + embedding search.
- `get_event({id | slug})` → full event with occurrences, venue, performers, sources, caller's score and state.
- `explain_score({eventId})` → reasons, rule hits, profile version, model.
- `my_agenda({from?, to?})` → interested/maybe occurrences, conflicts flagged.
- `list_sources()` (owner) and `get_source_run({runId})`.
- `usage_today()` (owner) → free-tier counters.

Write:
- `mark_event({eventId, state, rating?, note?})`.
- `add_event({extracted: ExtractedEvent, publish?: boolean})` → creates or merges, returns id + dedup info.
- `add_event_from_text({text, sourceHint?})` → runs extraction, returns candidates, optionally saves.
- `add_event_from_image({imageUrl | base64, note?})` → stores in R2, runs photo pipeline (Workflow), returns a job id;
  `get_job({id})` polls. (Elicitation can be used for clients that support it.)
- `update_event({id, patch})` with zod-validated partial.
- `update_profile({tasteTextAppend?, prefs?})`.
- `add_source({type, name, config, scheduleMinutes?, visibility?})`, `run_source({id})`, `set_source_enabled({id, enabled})` (owner or private sources).
- `resolve_review({id, action: "approve"|"merge"|"reject", mergeInto?})` (owner).

Resources:
- `event://{id}` (markdown rendering), `agenda://me/this-week`, `sources://` (owner).

Prompts:
- `weekend_picks` – "List my top 10 for the coming weekend grouped by day with one-line reasons."
- `triage_inbox` – walk through unscored/unseen events and ask me interested/skip.

## Design rules

- Tool results are compact markdown tables or small JSON; the client model pays for every token.
- Every write tool returns what changed and the resulting dedup decision.
- All tool input schemas come from `packages/shared` zod definitions, shared with the REST API.
- The REST API and MCP tools call the same service layer; neither contains business logic.
