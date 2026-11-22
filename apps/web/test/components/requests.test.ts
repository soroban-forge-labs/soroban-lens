import { describe, expect, it } from 'vitest';
import { createLatestGate } from '../../src/requests.js';

/** A request whose response the test releases by hand, in any order. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('request versioning', () => {
  it('a slow response for an old filter cannot overwrite the newer one', async () => {
    const gate = createLatestGate();
    let shown = '';
    const load = async (response: Promise<string>): Promise<void> => {
      const isCurrent = gate.begin();
      const value = await response;
      if (isCurrent()) shown = value;
    };

    const slow = deferred<string>();
    const fast = deferred<string>();
    const first = load(slow.promise); // contract A typed first
    const second = load(fast.promise); // then the filter changed to B
    fast.resolve('results for B');
    await second;
    slow.resolve('results for A'); // A's response straggles in last
    await first;

    expect(shown).toBe('results for B');
  });

  it('the latest request is current until another begins', () => {
    const gate = createLatestGate();
    const a = gate.begin();
    expect(a()).toBe(true);
    const b = gate.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
});
