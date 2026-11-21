import { describe, expect, it } from 'vitest';
import { pageOf } from './track';

describe('pageOf', () => {
  it('names a page by its kind, never by what it shows', () => {
    expect(pageOf('/')).toBe('browse');
    expect(pageOf('/e/some-show-2026')).toBe('event');
    expect(pageOf('/venue/abc')).toBe('venue');
    expect(pageOf('/scan/123')).toBe('scan');
    expect(pageOf('/scans')).toBe('scans');
    expect(pageOf('/for-you')).toBe('for-you');
    expect(pageOf('/inbox')).toBe('for-you');
    expect(pageOf('/login/secret-token')).toBe('other');
  });
});
