import { icalAdapter } from './ical';
import { jsonldAdapter } from './jsonld';
import { hasAdapter, registerAdapter } from './registry';
import { rssAdapter } from './rss';

/** Registers the adapters that ship with the app. Safe to call more than once (each isolate calls it on start). */
export function registerBuiltinAdapters(): void {
  for (const a of [icalAdapter, jsonldAdapter, rssAdapter]) if (!hasAdapter(a.type)) registerAdapter(a);
}
