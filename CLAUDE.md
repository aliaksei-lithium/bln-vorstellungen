# Instructions for the implementing model

Read `README.md` and `docs/08-execution-plan.md` first. The plan is the spec; `docs/09-decisions.md` lists what was
already decided and why. Do not re-open those decisions silently. If a decision turns out to be wrong, add a new entry
to `docs/09-decisions.md` that supersedes it, then change the code.

## Hard constraints

- Hosting: Cloudflare only. Everything must run on the **Workers Free plan** at hobby volume. Check
  `docs/02-architecture.md` for the per-product free limits before adding a binding. No Queues (paid). No Vectorize
  (paid). Keep CPU per invocation under 10 ms: offload HTML parsing to `env.AI.toMarkdown()` or external readers,
  never parse large HTML with a DOM library inside the Worker.
- Language: TypeScript everywhere (Worker, frontend, shared package). Strict mode. Zod schemas in `packages/shared`
  are the single source of truth for event shapes, API payloads and MCP tool inputs.
- Sourcing is pluggable: a new source type means adding one adapter module that implements the `SourceAdapter`
  interface in `docs/03-sourcing.md`, plus a config schema. Nothing else should change.
- Event vs. performance: a theatre production with 12 dates is **one event with 12 occurrences**. Never duplicate
  events per date.
- Secrets via `wrangler secret`; never commit them. Test values go in `.dev.vars.example`.
- Keep it free: prefer Workers AI models for bulk classification and embeddings; use Claude only where quality
  matters (photo extraction, final scoring). Budget per `docs/05-ai-pipeline.md`.

## Repo layout (target)

```
apps/worker/      Hono app: API, MCP, cron, email handler, Workflows, serves apps/web build as static assets
apps/web/         React 19 + Vite + TanStack Router/Query + Tailwind + shadcn/ui
packages/shared/  Zod schemas, types, pure helpers (date/time, dedup keys, scoring math)
packages/sources/ Source adapters, one file per adapter, plus a registry
docs/             The plan
```

pnpm workspaces. Vitest for unit tests, `@cloudflare/vitest-pool-workers` for Worker tests. Drizzle ORM for D1.

## Conventions

- Dates are stored as ISO-8601 strings in Europe/Berlin local time **plus** a UTC instant column. Berlin has DST.
- German and English content both appear; store the original language and a `lang` column, do not auto-translate on
  ingest.
- Every AI output that lands in the DB keeps its provenance: model id, prompt version, source item id.
- Commit messages: imperative, one topic per commit.
