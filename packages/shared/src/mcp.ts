import { z } from 'zod';
import { Category, TASTE_MAX, UserState } from './schemas';

/**
 * MCP tool inputs (docs/06). Descriptions are what the client model reads, so they say how to fill each field.
 * Dates are Berlin calendar days; the server resolves them to instants.
 */

const day = (description: string) => z.iso.date().optional().describe(description);

export const McpListEvents = z.object({
  from: day('First day, YYYY-MM-DD in Berlin. Default: today.'),
  to: day('Last day, inclusive, YYYY-MM-DD in Berlin. Default: 14 days after `from`.'),
  category: Category.optional(),
  query: z.string().trim().max(100).optional().describe('Keywords matched against title, venue and performers.'),
  limit: z.number().int().min(1).max(50).default(30),
});
export type McpListEvents = z.infer<typeof McpListEvents>;

export const McpMyPicks = z.object({
  from: day('First day, YYYY-MM-DD in Berlin. Default: now.'),
  to: day('Last day, inclusive, YYYY-MM-DD in Berlin. Default: no limit.'),
  category: Category.optional(),
  minScore: z.number().int().min(0).max(100).default(40).describe('Leave out events scored below this (0-100).'),
  limit: z.number().int().min(1).max(50).default(15),
});
export type McpMyPicks = z.infer<typeof McpMyPicks>;

export const McpSearch = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .describe('What to look for, in any words or language: "something fun with kids", "Brecht", "jazz trio".'),
  limit: z.number().int().min(1).max(30).default(15),
});
export type McpSearch = z.infer<typeof McpSearch>;

const slug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The event slug: the last part of its link, as shown by the other tools.');

export const McpGetEvent = z.object({ slug });
export type McpGetEvent = z.infer<typeof McpGetEvent>;

export const McpMarkEvent = z.object({
  slug,
  state: z
    .union([UserState, z.literal('clear')])
    .describe(
      'interested or maybe put it on the agenda; skipped takes it out of the picks; hidden never shows it again; ' +
        'went records a past visit; clear undoes any of these.',
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
    .optional()
    .describe('Which performance, YYYY-MM-DD or YYYY-MM-DDTHH:MM in Berlin. Default: the next one.'),
});
export type McpMarkEvent = z.infer<typeof McpMarkEvent>;

export const McpSetTaste = z.object({
  tasteText: z
    .string()
    .trim()
    .max(TASTE_MAX)
    .describe(
      `What the user likes and avoids, in their own words (at most ${TASTE_MAX} characters). Replaces the current ` +
        'text, so start from get_taste and edit it. Every upcoming event is re-scored within a few minutes.',
    ),
});
export type McpSetTaste = z.infer<typeof McpSetTaste>;
