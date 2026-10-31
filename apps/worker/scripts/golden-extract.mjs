// Golden examples for the extraction prompt (docs/05). Runs against the real model through a running dev server:
//   pnpm --filter @bln/worker dev          (in one terminal)
//   RUN_AI_TESTS=1 pnpm --filter @bln/worker golden
//   RUN_AI_TESTS=1 PROVIDER=anthropic/claude-haiku-5.5 pnpm --filter @bln/worker golden   (compare models)
// Costs about 100 neurons of the daily Workers AI allowance. Token from apps/worker/.dev.vars.
import { readFileSync } from 'node:fs';

if (process.env.RUN_AI_TESTS !== '1') {
  console.log('Skipped: set RUN_AI_TESTS=1 to run the golden extraction examples against Workers AI.');
  process.exit(0);
}
const base = process.env.BASE_URL ?? 'http://localhost:8787';
const token = (process.env.ADMIN_TOKEN ?? readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')).match(
  /(?:ADMIN_TOKEN=)?([0-9a-f]{16,})/,
)?.[1];
const cases = JSON.parse(readFileSync(new URL('../test/ai/extract.golden.json', import.meta.url), 'utf8'));

// {{DM+n}} → "13.11." and {{EN+n}} → "Sat 14 Nov", n days from today, so the examples never expire.
const day = (n) => new Date(Date.now() + n * 86_400_000);
const fill = (s) =>
  s
    .replace(
      /\{\{DM\+(\d+)\}\}/g,
      (_, n) =>
        day(+n).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' }) + '.',
    )
    .replace(/\{\{EN\+(\d+)\}\}/g, (_, n) =>
      day(+n).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'Europe/Berlin',
      }),
    );

let failed = 0;
let neurons = 0;
let usd = 0;
let model = '';
for (const c of cases) {
  const res = await fetch(`${base}/api/admin/extract`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: fill(c.text),
      sourceName: 'golden',
      ...(c.venue ? { venue: c.venue } : {}),
      ...(process.env.PROVIDER ? { provider: process.env.PROVIDER } : {}),
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`${c.name}: ${out.error}`);
  neurons += out.neurons;
  usd += out.usd ?? 0;
  model = out.model;
  const problems = [];
  if (out.events.length !== c.expect.length)
    problems.push(`expected ${c.expect.length} events, got ${out.events.length}`);
  for (const want of c.expect) {
    const got = out.events.find((e) => e.title.toLowerCase().includes(want.title.toLowerCase()));
    if (!got) {
      problems.push(`missing "${want.title}"`);
      continue;
    }
    if (!want.category.includes(got.category)) problems.push(`${want.title}: category ${got.category}`);
    if (got.occurrences.length !== want.dates) problems.push(`${want.title}: ${got.occurrences.length} dates`);
    if (want.doors && !got.occurrences[0].doorsAt) problems.push(`${want.title}: no doors time`);
    if (want.free && !got.price?.free) problems.push(`${want.title}: not marked free`);
    for (const [k, v] of Object.entries(want.price ?? {}))
      if (got.price?.[k] !== v) problems.push(`${want.title}: price.${k} ${got.price?.[k]} ≠ ${v}`);
  }
  failed += problems.length ? 1 : 0;
  console.log(`${problems.length ? '✗' : '✓'} ${c.name}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
  if (problems.length)
    console.log('    got:', JSON.stringify(out.events.map((e) => [e.title, e.category, e.occurrences.length])));
}
console.log(
  `\n${model}: ${cases.length - failed}/${cases.length} passed · ${neurons.toFixed(1)} neurons · $${usd.toFixed(4)}`,
);
process.exit(failed ? 1 : 0);
