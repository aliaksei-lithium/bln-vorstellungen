import { describe, expect, it } from 'vitest';
import { stripPresenter } from '../src/common';
import { chunkMarkdown, compactMarkdown, HtmlConfig, htmlAdapter } from '../src/html';
import type { SourceContext } from '../src/types';

describe('html adapter', () => {
  it('chunks Markdown at paragraph boundaries', () => {
    const md = ['# Spielplan', 'A'.repeat(50), 'B'.repeat(50), 'C'.repeat(50)].join('\n\n');
    const chunks = chunkMarkdown(md, 120);
    expect(chunks).toHaveLength(2);
    expect(chunks.join('\n\n')).toBe(md);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
  });

  it('drops images and empty links before chunking', () => {
    expect(compactMarkdown('Hamlet ![poster](x.jpg)\n\n\n\n[ ](y)Fr 13.11.  \n')).toBe('Hamlet\n\nFr 13.11.');
  });

  it('converts the page off-Worker and stores chunks for LLM extraction', async () => {
    const seen: { html: string; sel?: string }[] = [];
    const ctx: SourceContext = {
      fetch: (async () => new Response('<main>…</main>')) as unknown as typeof fetch,
      toMarkdown: async (html, opts) => {
        seen.push({ html, ...(opts?.cssSelector ? { sel: opts.cssSelector } : {}) });
        return ['Fr 13.11. 19:30 Hamlet', 'Sa 14.11. 20:00 Faust'].join('\n\n');
      },
      today: '2026-10-31',
      log: () => {},
    };
    const config = HtmlConfig.parse({ url: 'https://theatre.example/spielplan', cssSelector: 'main' });
    const r = await htmlAdapter.fetch(ctx, config, null);
    expect(seen).toEqual([{ html: '<main>…</main>', sel: 'main' }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'markdown', externalId: 'https://theatre.example/spielplan#1' });
    expect(htmlAdapter.mapItem).toBeUndefined();
  });
});

describe('stripPresenter', () => {
  it('removes "<venue> präsentiert" openers, case-insensitively', () => {
    expect(stripPresenter('A-TRANE PRÄSENTIERT · Shuteen Erdenebaatar Quartet', 'A-Trane')).toBe(
      'Shuteen Erdenebaatar Quartet',
    );
    expect(stripPresenter('A-Trane presents: Lily Dahab', 'A-Trane')).toBe('Lily Dahab');
    expect(stripPresenter('Hamlet', 'A-Trane')).toBe('Hamlet');
    expect(stripPresenter('A-Trane Jam', undefined)).toBe('A-Trane Jam');
  });
});
