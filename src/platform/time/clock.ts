/**
 * The current time, injectable. Code that compares against "now" (token
 * expiry, the refresh grace window, rate-limit windows) takes a Clock, so
 * tests can move time forward instead of sleeping.
 */
export type Clock = { now(): Date }

export const systemClock: Clock = { now: () => new Date() }
