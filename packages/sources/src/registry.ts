import type { SourceAdapter } from './types';

/** Adapters register here; the SourceRun workflow looks them up by `sources.type`. Built-ins: see builtin.ts. */
const adapters = new Map<string, SourceAdapter<unknown>>();

export function registerAdapter<C>(adapter: SourceAdapter<C>): void {
  if (adapters.has(adapter.type)) throw new Error(`Adapter "${adapter.type}" is already registered`);
  adapters.set(adapter.type, adapter as SourceAdapter<unknown>);
}

export function getAdapter(type: string): SourceAdapter<unknown> {
  const a = adapters.get(type);
  if (!a) throw new Error(`No adapter for source type "${type}"`);
  return a;
}

export const hasAdapter = (type: string): boolean => adapters.has(type);

export const adapterTypes = (): string[] => [...adapters.keys()].sort();
