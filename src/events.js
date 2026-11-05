// -----------------------------------------------------------------------------
// The door and call logs of the device, turned into events, and the rate
// limit of what is published to Gladys. Pure, clock given by the caller.
//
// A log entry becomes an event only if it appeared between two readings of
// the same session, close in time: the device dates its entries in its own
// local time, which the integration cannot compare to its clock, so an entry
// found at the first reading, after a restart, or after a gap longer than
// the bound, is a baseline and never an event ("nothing stale published as
// new"). An entry is new when its numeric ID is above the highest one seen;
// a log whose highest ID went down was cleared: new baseline, no event.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

export class LogTracker {
  constructor() {
    this.max = undefined;
    this.readAt = undefined;
  }

  /** Forget the baseline (new session, other device, log not read for long). */
  reset() {
    this.max = undefined;
    this.readAt = undefined;
  }

  /**
   * A successful reading at `mono`; `gap` the longest time between two
   * readings for their entries to count. -> { fresh: entries (oldest first),
   * dropped: count, baseline: bool }.
   */
  update(entries, mono, gap) {
    const ids = entries.map((e) => e.id);
    const top = ids.length ? Math.max(...ids) : undefined;
    const stale = this.readAt === undefined || mono - this.readAt > gap || mono < this.readAt;
    this.readAt = mono;
    if (this.max === undefined || stale) {
      // An empty answer is no baseline (a glitch would make every old entry
      // new at the next reading): the first non-empty one is.
      this.max = top;
      return { fresh: [], dropped: 0, baseline: true };
    }
    if (top === undefined) return { fresh: [], dropped: 0, baseline: false };
    if (top < this.max) {
      this.max = top;
      return { fresh: [], dropped: 0, baseline: true };
    }
    const fresh = entries.filter((e) => e.id > this.max).sort((a, b) => a.id - b.id);
    this.max = top;
    const dropped = Math.max(0, fresh.length - LIMITS.eventsPerRead);
    return { fresh: fresh.slice(dropped), dropped, baseline: false };
  }
}

/** At most `limit` items per sliding minute (monotonic clock). */
export class RateLimiter {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.times = [];
    this.refusedCount = 0;
  }

  take(mono, count = 1) {
    while (this.times.length && (mono - this.times[0] >= this.windowMs || mono < this.times[0])) {
      this.times.shift();
    }
    if (this.times.length + count > this.limit) {
      this.refusedCount += count;
      return false;
    }
    for (let i = 0; i < count; i += 1) this.times.push(mono);
    return true;
  }
}
