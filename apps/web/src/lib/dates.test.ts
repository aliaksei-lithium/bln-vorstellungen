import { describe, expect, it } from 'vitest';
import { addDays, relativeDay, whenRange } from './dates';

describe('date ranges', () => {
  it('finds the coming weekend', () => {
    expect(whenRange('weekend', '2026-10-30')).toEqual({ from: '2026-10-31', to: '2026-11-01' }); // Fr
    expect(whenRange('weekend', '2026-10-31')).toEqual({ from: '2026-10-31', to: '2026-11-01' }); // Sa
    expect(whenRange('weekend', '2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-01' }); // So
  });

  it('crosses month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(whenRange('week', '2026-12-29')).toEqual({ from: '2026-12-29', to: '2027-01-04' });
  });

  it('labels today and tomorrow', () => {
    expect(relativeDay('2026-10-31', '2026-10-30')).toBe('Tomorrow');
    expect(relativeDay('2026-11-02', '2026-10-30')).toBe('');
  });
});
