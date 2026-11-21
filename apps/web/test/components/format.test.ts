import { describe, expect, it } from 'vitest';
import { summarise, truncate } from '../../src/format.js';

describe('truncate()', () => {
  it('leaves a string that already fits alone', () => {
    expect(truncate('CDLZFC3SYJYDZT7K')).toBe('CDLZFC3SYJYDZT7K');
    // head + tail + 1 is the cut-off: an ellipsis must actually save space.
    expect(truncate('a'.repeat(17))).toBe('a'.repeat(17));
  });

  it('keeps the head and tail of a long id around one ellipsis', () => {
    expect(truncate('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')).toBe('CDLZFC3S…2HHGCYSC');
    expect(truncate('c7e2ba28f4f4e4ac3fcd7ef0a98d558f', 6, 6)).toBe('c7e2ba…8d558f');
  });
});

describe('summarise()', () => {
  it('shows scalars as text', () => {
    expect(summarise({ type: 'symbol', value: 'transfer' })).toBe('transfer');
    expect(summarise({ type: 'i128', value: '11000000' })).toBe('11000000');
    expect(summarise({ type: 'bool', value: false })).toBe('false');
  });

  it('summarises structures by shape, so a row stays one line', () => {
    expect(summarise({ type: 'vec', value: ['1', '2', '3'] })).toBe('vec[3]');
    expect(summarise({ type: 'map', value: { amount: '1', to: 'G…' } })).toBe('map{2}');
  });

  it('cuts long text at 60 characters', () => {
    const out = summarise({ type: 'string', value: 'x'.repeat(100) });
    expect(out).toHaveLength(58);
    expect(out.endsWith('…')).toBe(true);
  });

  it('renders null rather than throwing on an empty value', () => {
    expect(summarise({ type: 'void', value: null })).toBe('null');
  });
});
