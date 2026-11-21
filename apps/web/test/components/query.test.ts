import { describe, expect, it } from 'vitest';
import { buildEventPath } from '../../src/api.js';

// The topic-prefix query builder: positional, with null as the wildcard.
describe('topic-prefix query builder', () => {
  const topics = (path: string): string[] => new URL(path, 'http://x').searchParams.getAll('topic');

  it('sends topics in order, as a prefix', () => {
    expect(topics(buildEventPath({ topics: ['transfer', 'GABC'] }))).toEqual(['transfer', 'GABC']);
  });

  it('keeps a wildcard in place, so later segments do not shift left', () => {
    expect(topics(buildEventPath({ topics: ['transfer', null, 'GXYZ'] }))).toEqual(['transfer', '*', 'GXYZ']);
  });

  it('puts a contract in the path and its topics in the query', () => {
    const path = buildEventPath({ contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', topics: ['mint'] });
    expect(path).toMatch(/^\/contracts\/CDLZ\w+\/events\?/);
    expect(topics(path)).toEqual(['mint']);
  });

  it('sends no topic parameter at all without a filter', () => {
    expect(buildEventPath({})).toBe('/events');
  });
});
