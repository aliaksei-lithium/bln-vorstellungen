import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adapterTypes, getAdapter, registerAdapter } from '../src/registry';
import { contentHash } from '../src/hash';

describe('registry', () => {
  it('registers and looks up adapters by type', () => {
    registerAdapter({
      type: 'test',
      configSchema: z.object({ url: z.url() }),
      defaultScheduleMinutes: 360,
      fetch: async () => ({ items: [], cursor: null, stats: { fetched: 0, skipped: 0 } }),
    });
    expect(getAdapter('test').type).toBe('test');
    expect(adapterTypes()).toContain('test');
    expect(() => getAdapter('nope')).toThrow(/No adapter/);
  });

  it('hashes content ignoring whitespace differences', async () => {
    expect(await contentHash('Peer Gynt\n  20:00')).toBe(await contentHash('Peer Gynt 20:00'));
  });
});
