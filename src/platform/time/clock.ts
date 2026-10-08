/**
 * The current time, injectable. Code that compares against "now" (token
 * expiry, the refresh grace window, rate-limit windows) takes a Clock, so
 * tests can move time forward instead of sleeping.
 */
export type Clock = { now(): Date }

export const systemClock: Clock = { now: () => new Date() }

/** For tests: a clock that only moves when told to. */
export function fixedClock(start = new Date("2026-10-09T08:00:00.000Z")) {
  let current = start.getTime()
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms
    },
  }
}
