import { htmlAdapter } from './html';
import { icalAdapter } from './ical';
import { jsonldAdapter } from './jsonld';
import { hasAdapter, registerAdapter } from './registry';
import type { SourceAdapter } from './types';
import { rssAdapter } from './rss';

/** Registers the adapters that ship with the app. Safe to call more than once (each isolate calls it on start). */
export function registerBuiltinAdapters(): void {
  const builtins = [icalAdapter, jsonldAdapter, rssAdapter, htmlAdapter] as SourceAdapter<unknown>[];
  for (const a of builtins) if (!hasAdapter(a.type)) registerAdapter(a);
}
