import { berlinToday } from '@bln/shared';
import { dispatchScoring } from '../ai/score';
import { claimTasteRebuild } from './review';

/**
 * Who is around (docs/09, 2026-11-04): the daily AI work (scoring new events with the model, the daily review and its
 * Discover edition) is done for users seen in the last ACTIVE_DAYS only. Someone back after longer is caught up on
 * their first visit: re-scored, then a fresh review, while For you shows the last one.
 */
export const ACTIVE_DAYS = 7;
/** `users.last_seen_at` is written at most this often per user. */
const SEEN_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const activeSince = (now = new Date()): string => new Date(now.getTime() - ACTIVE_DAYS * DAY_MS).toISOString();

/**
 * Records a signed-in request. Returns the work to do in the background, or null when the user was seen within the
 * hour: the write, and the catch-up when they had been away.
 */
export function seen(env: Env, userId: string, lastSeenAt: string | null, now = new Date()): Promise<void> | null {
  if (lastSeenAt && now.getTime() - Date.parse(lastSeenAt) < SEEN_EVERY_MS) return null;
  // No visit recorded: a new account, scored as soon as it has a taste. Only a known, older visit means "away".
  const away = !!lastSeenAt && lastSeenAt < activeSince(now);
  return (async () => {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now.toISOString(), userId).run();
    if (away) await welcomeBack(env, userId, now);
  })();
}

/** The same for a request that knows only the user id (MCP, from Claude). */
export async function seenById(env: Env, userId: string, now = new Date()): Promise<void> {
  const row = await env.DB.prepare('SELECT last_seen_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ last_seen_at: string | null }>();
  if (row) await seen(env, userId, row.last_seen_at, now);
}

/** Back after a while: re-score with the model, then rebuild Discover and For you, unless today's is already there. */
export async function welcomeBack(env: Env, userId: string, now = new Date()): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM user_reviews WHERE user_id = ?1 AND day = ?2) AS fresh,
            EXISTS (SELECT 1 FROM user_profiles p WHERE p.user_id = ?1 AND trim(p.taste_text) != '')
              OR EXISTS (SELECT 1 FROM user_artists a WHERE a.user_id = ?1) AS taste`,
  )
    .bind(userId, berlinToday(now))
    .first<{ fresh: number; taste: number }>();
  if (!row || row.fresh || !row.taste) return false;
  const rebuild = await claimTasteRebuild(env, userId, now);
  await dispatchScoring(env, userId, now, { rebuild });
  return rebuild;
}
