import {
  ScanConfirm,
  ScanPlaylist,
  ScanText,
  type ScanCreated,
  type ScanInsight,
  type ScanListItem,
  type ScanPlaylistResult,
} from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireUser, type AppEnv } from '../auth';
import { scanMore, scanPlaylist } from '../services/scan-insights';
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  confirmScan,
  createScan,
  deleteScan,
  getScan,
  listScans,
  rereadScan,
  scanImage,
} from '../services/scans';

/**
 * Scans for signed-in users: POST a photo (multipart `image`, optional `takenAt` and `note`) or JSON `{ text }`,
 * poll GET until `ready`, then POST the reviewed events to /confirm. Before that, /more/:i explains one event and
 * /playlist makes a Spotify playlist from the picked ones. GET / lists the user's scans; a scan can be read again
 * (/reread) or deleted.
 */
export const scansApi = new Hono<AppEnv>();

scansApi.post('/', async (c) => {
  const user = requireUser(c);
  let id: string;
  if (c.req.header('content-type')?.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('image');
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'Attach a photo.' });
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
      throw new HTTPException(415, { message: 'Use a JPG, PNG or WebP photo.' });
    }
    if (file.size > MAX_IMAGE_BYTES) throw new HTTPException(413, { message: 'That photo is too large.' });
    const takenAt = String(form.get('takenAt') ?? '');
    const note = String(form.get('note') ?? '')
      .trim()
      .slice(0, 300);
    id = await createScan(c.env, user.id, {
      kind: 'photo',
      bytes: await file.arrayBuffer(),
      contentType: file.type,
      ...(/^\d{4}-\d{2}-\d{2}$/.test(takenAt) ? { takenAt } : {}),
      ...(note ? { note } : {}),
    });
  } else {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Send a photo or JSON with text.' });
    }
    const p = ScanText.safeParse(raw);
    if (!p.success) throw new HTTPException(400, { message: p.error.issues[0]?.message ?? 'Invalid text' });
    id = await createScan(c.env, user.id, { kind: 'text', text: p.data.text });
  }
  return c.json({ id } satisfies ScanCreated, 201);
});

scansApi.get('/', async (c) => c.json((await listScans(c.env.DB, requireUser(c).id)) satisfies ScanListItem[]));

scansApi.get('/:id', async (c) => c.json(await getScan(c.env.DB, requireUser(c).id, c.req.param('id'))));

scansApi.get('/:id/image', async (c) => {
  const obj = await scanImage(c.env, requireUser(c).id, c.req.param('id'));
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg',
    'Cache-Control': 'private, max-age=86400',
  });
});

scansApi.post('/:id/confirm', async (c) => {
  const user = requireUser(c);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON.' });
  }
  const p = ScanConfirm.safeParse(raw);
  if (!p.success) throw new HTTPException(400, { message: p.error.issues[0]?.message ?? 'Invalid events' });
  return c.json(await confirmScan(c.env, user.id, c.req.param('id'), p.data.events));
});

scansApi.post('/:id/more/:i', async (c) => {
  const i = Number(c.req.param('i'));
  if (!Number.isInteger(i) || i < 0) throw new HTTPException(400, { message: 'Bad event number' });
  return c.json((await scanMore(c.env, requireUser(c).id, c.req.param('id'), i)) satisfies ScanInsight);
});

scansApi.post('/:id/playlist', async (c) => {
  const user = requireUser(c);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON.' });
  }
  const p = ScanPlaylist.safeParse(raw);
  if (!p.success) throw new HTTPException(400, { message: p.error.issues[0]?.message ?? 'Invalid events' });
  return c.json((await scanPlaylist(c.env, user.id, c.req.param('id'), p.data.indexes)) satisfies ScanPlaylistResult);
});

scansApi.post('/:id/reread', async (c) => {
  const user = requireUser(c);
  await rereadScan(c.env, user.id, c.req.param('id'));
  return c.json(await getScan(c.env.DB, user.id, c.req.param('id')), 202);
});

scansApi.delete('/:id', async (c) => {
  await deleteScan(c.env, requireUser(c).id, c.req.param('id'));
  return c.body(null, 204);
});
