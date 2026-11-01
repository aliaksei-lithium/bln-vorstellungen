import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/services/events';
import { confirmScan, createScan, getScan, runScan, toBase64 } from '../src/services/scans';

/** Scans end to end with a stubbed model: photo in R2, the workflow's read step, review, confirm and merge. */

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

async function user(name: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`)
    .bind(id, name, `${id}@example.org`)
    .run();
  return id;
}

/** Claude through the AI binding, answering with these events; records what it was sent. */
function claudeEnv(events: unknown[], seen: unknown[] = []) {
  return {
    ...env,
    EXTRACT_MODEL: 'anthropic/claude-haiku-5.5',
    PHOTO_INGEST: { create: async () => ({ id: 'x' }) },
    AI: {
      run: async (_model: string, body: unknown) => {
        seen.push(body);
        return {
          content: [{ type: 'text', text: JSON.stringify({ events }) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3000, output_tokens: 500 },
        };
      },
    },
  } as unknown as Env;
}

const listing = (title: string, d: string, extra: Record<string, unknown> = {}) => ({
  title,
  lang: 'en',
  category: 'concert',
  dates: [{ start: `${d}T00:00` }],
  venue: 'Columbiahalle',
  confidence: 0.8,
  quote: `${title} · Columbiahalle`,
  ...extra,
});

describe('scans', () => {
  it('reads a photo with Claude, keeps it for review, and adds only what the user confirms', async () => {
    const uid = await user('Pia');
    const seen: unknown[] = [];
    const e = claudeEnv(
      [listing('Royal Blood', day(20)), listing('Old Show', day(-30)), listing('Hot Chip', day(40))],
      seen,
    );
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const id = await createScan(e, uid, { kind: 'photo', bytes: photo.buffer, contentType: 'image/jpeg' });
    expect((await getScan(env.DB, uid, id)).status).toBe('queued');

    expect(await runScan(e, id)).toEqual({ status: 'ready', events: 2 }); // the past date is dropped
    const sent = seen[0] as { messages: { content: { type: string; source?: { data: string } }[] }[] };
    expect(sent.messages[0]!.content[0]).toMatchObject({ type: 'image', source: { data: toBase64(photo) } });

    const scan = await getScan(env.DB, uid, id);
    expect(scan.candidates.map((c) => c.title)).toEqual(['Royal Blood', 'Hot Chip']);
    await expect(getScan(env.DB, await user('Other'), id)).rejects.toThrow('Scan not found');

    const r = await confirmScan(e, uid, id, [{ ...scan.candidates[0]!, title: 'Royal Blood (edited)' }]);
    expect(r).toMatchObject({ added: 1, merged: 0, events: [{ title: 'Royal Blood (edited)', created: true }] });
    const ev = await env.DB.prepare(
      `SELECT e.created_by, es.prompt_version FROM events e JOIN event_sources es ON es.event_id = e.id
        WHERE e.title = 'Royal Blood (edited)'`,
    ).first<{ created_by: string; prompt_version: string }>();
    expect(ev).toEqual({ created_by: `user:${uid}`, prompt_version: 'photo@1+extract@8' });
    await expect(confirmScan(e, uid, id, scan.candidates)).rejects.toThrow('already added');

    // The Browse source filter: added from photos & text, not from Telegram.
    const titles = async (via: 'scans' | 'telegram') => (await listEvents(env.DB, { via })).items.map((i) => i.title);
    expect(await titles('scans')).toContain('Royal Blood (edited)');
    expect(await titles('telegram')).not.toContain('Royal Blood (edited)');

    // The same show from another photo merges into the event instead of duplicating it.
    const again = await createScan(e, uid, { kind: 'text', text: 'Royal Blood (edited), Columbiahalle, soon.' });
    await runScan(claudeEnv([listing('Royal Blood (edited)', day(21))]), again);
    const second = await getScan(env.DB, uid, again);
    expect(await confirmScan(e, uid, again, second.candidates)).toMatchObject({ added: 0, merged: 1 });
  });

  it('explains an empty result and fails clearly without Claude', async () => {
    const uid = await user('Rio');
    const e = claudeEnv([listing('Vintage Paper Berlin', day(-40))]);
    const id = await createScan(e, uid, { kind: 'photo', bytes: new Uint8Array([1]).buffer, contentType: 'image/png' });
    await runScan(e, id);
    expect(await getScan(env.DB, uid, id)).toMatchObject({
      status: 'ready',
      candidates: [],
      error: 'Found an event, but no upcoming dates.',
    });

    // Tests pin EXTRACT_MODEL to Workers AI, which cannot read images.
    const noClaude = { ...env, PHOTO_INGEST: { create: async () => ({ id: 'x' }) } } as unknown as Env;
    const id2 = await createScan(noClaude, uid, {
      kind: 'photo',
      bytes: new Uint8Array([1]).buffer,
      contentType: 'image/png',
    });
    expect(await runScan(noClaude, id2)).toEqual({ status: 'failed', events: 0 });
    expect((await getScan(env.DB, uid, id2)).error).toMatch(/Reading photos needs Claude/);
  });
});
