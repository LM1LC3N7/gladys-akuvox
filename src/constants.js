// -----------------------------------------------------------------------------
// Keys, timings and limits. Every bound the integration applies lives here.
// -----------------------------------------------------------------------------

/** The manifest actions (Configuration screen buttons). */
export const ACTIONS = Object.freeze({ TEST: 'test_connection' });

/** The manifest scene triggers. Keys are forever. */
export const TRIGGERS = Object.freeze({
  OPENED: 'door_opened',
  DENIED: 'access_denied',
  CALL: 'call',
});

/** The device type in the external ids: ext:<selector>:akuvox:<mac>. */
export const DEVICE_TYPE = 'akuvox';

/** Feature keys of a relay (letter a to d). */
export const featureKey = (letter, kind) => `relay-${letter}:${kind}`;
export const FEATURE_RE = /^relay-([a-d]):(state|open)$/;

/** Opening duration sent to the device (seconds), the relay closes by itself after it. */
export const OPEN_SECONDS = Object.freeze({ min: 1, max: 30, default: 5 });

/** Reading interval (seconds). */
export const POLL = Object.freeze({ min: 5, max: 300, default: 10 });

export const TIMINGS = Object.freeze({
  /** Budget of one reading request, connection included. */
  readTimeout: 4000,
  /** Budget of one request of a command (identity, then the trigger). */
  commandStepTimeout: 1500,
  /** A command acks under this (Gladys stops waiting at 5 s). */
  commandBudget: 3300,
  /** The relay is read again after an opening, to confirm it. */
  confirmReads: [700, 2500],
  /** The relay configuration (mode, type, names) is read again after this. */
  relayConfigEvery: 10 * 60_000,
  /** An unreachable device: tried again after interval x 2^n, at most this. */
  downMax: 300_000,
  /** 403 (address not allowed by the device): tried again after this, doubled, at most 1 h. */
  forbiddenFirst: 60_000,
  forbiddenMax: 3_600_000,
  /** A log not read for longer than this: read again as a new baseline (nothing published). */
  logGapFactor: 3,
  logGapMin: 120_000,
  /** An opening from Gladys: the door log entry it makes, within this, is not an event. */
  ownOpenWindow: 30_000,
  /** The test button: once per address every this. */
  testEvery: 5000,
  /** getConfig() failed: tried again after these delays (the last one repeats). */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** /data: a read or a write never waits longer. */
  storeTimeout: 2000,
});

export const LIMITS = Object.freeze({
  /** Addresses in the configuration. */
  hosts: 8,
  /** Relays of a device (A to D). */
  relays: 4,
  /** Size of an answer of the device, cut beyond (bytes). */
  maxBody: 128 * 1024,
  /** The configuration dump of the device is larger. */
  maxConfigBody: 512 * 1024,
  /** Log entries read in one answer. */
  logItems: 200,
  /** New log entries published per log and per reading; the oldest extra ones are dropped. */
  eventsPerRead: 5,
  /** Scene events and states per minute, for the whole integration (Gladys: 300). */
  eventsPerMinute: 200,
  statesPerMinute: 250,
  /** Waiting commands per device. */
  commandQueue: 4,
  /** A text of the device (name, method) published at most this long. */
  text: 64,
  /** Connection status message. */
  status: 900,
  /** /data file. */
  storeBytes: 64 * 1024,
  /** Bits of the fingerprint kept for refused credentials. */
  refusedBits: 8,
});
