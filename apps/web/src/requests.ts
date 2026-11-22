/**
 * "Latest request wins".
 *
 * Filters change faster than responses arrive: type a contract id, change a
 * topic, and two requests are in flight. If the first is slower, its response
 * lands last, and without a guard it overwrites the results for the filter the
 * user is actually looking at. Each request takes a ticket; only the newest
 * ticket's response may be applied.
 */
export interface LatestGate {
  /** Start a request. The returned check is true only while no newer request has started. */
  begin(): () => boolean;
}

export function createLatestGate(): LatestGate {
  let latest = 0;
  return {
    begin() {
      const ticket = ++latest;
      return () => ticket === latest;
    },
  };
}
