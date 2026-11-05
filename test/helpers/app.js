// -----------------------------------------------------------------------------
// AkuvoxApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), fake Akuvox devices on real loopback sockets, a memory
// store and a virtual clock: the timers only fire when the test advances the
// clock, and the monotonic clock moves 1 µs at each read (a decision that
// reads it twice is caught). Every wait is bounded: a test fails, never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AkuvoxApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { MAC_ID, PASSWORD, USER, startFakeAkuvox } from './fakeAkuvox.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'akuvox';
export const NOW = 1_800_000_000_000;
export const D = (mac = MAC_ID) => `ext:${SELECTOR}:akuvox:${mac}`;
export const F = (key, mac = MAC_ID) => `${D(mac)}:${key}`;

/** Waits (real time, bounded) until `condition()` holds; the I/O is real. */
export async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${condition}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that rejects after `ms` (real time): no test waits without end. */
export function within(promise, ms = 5000, what = 'promise') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} not settled in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A logger that keeps every line. */
export function memoryLogger() {
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => lines.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  return { logger, lines };
}

export async function setup(
  t,
  { config = {}, fakes, fake: fakeOptions, store, devices = [], start = true, timings = {} } = {},
) {
  const list = fakes ?? [await startFakeAkuvox(fakeOptions)];
  t.after(() => Promise.all(list.map((f) => f.close())));
  const fullConfig = {
    hosts: list.map((f) => f.host).join(', '),
    auth: 'digest',
    username: USER,
    password: PASSWORD,
    allow_open: true,
    ...config,
  };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices });
  const { clock, timers, advance, pending } = createFakeClock(NOW);
  let drift = 0;
  const { logger, lines } = memoryLogger();
  const kept = store ?? new MemoryStore(undefined, { now: () => clock.now });
  const app = new AkuvoxApp({
    gladys,
    logger,
    store: kept,
    timers,
    now: () => clock.now,
    monotonic: () => clock.now + (drift += 0.001),
    timings: { readTimeout: 800, ...timings },
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(() => app.stop());
  if (start) {
    await within(gladys.connect(), 5000, 'connect');
    await until(() => app.config);
  }
  /** Runs the due timers, then waits (real time) for the I/O they started. */
  const step = async (ms = 0) => {
    await advance(ms);
    await sleep(5);
  };
  /** Moves the virtual clock step by step until `condition()` holds. */
  const advanceUntil = async (condition, { ms = 600_000, every = 1000 } = {}) => {
    for (let spent = 0; spent <= ms; spent += every) {
      if (condition()) return;
      await advance(every);
      await sleep(5);
    }
    if (!condition()) throw new Error(`condition not met in ${ms} virtual ms: ${condition}`);
  };
  const session = (i = 0) => [...app.sessions.values()][i];
  /** The first cycle of a device (its timer is due now): read in full. */
  const ready = async (i = 0) => {
    await step(0);
    await until(
      () =>
        session(i)?.state === 'ok' &&
        session(i)?.relays.size > 0 &&
        session(i)?.timer !== undefined,
    );
  };
  return {
    gladys,
    app,
    fake: list[0],
    fakes: list,
    lines,
    store: kept,
    clock,
    advance,
    pending,
    step,
    advanceUntil,
    session,
    ready,
  };
}

/** Creates every discovered device in the fake Gladys. */
export async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** A button press through the fake Gladys (the handler of the container): the ack. */
export function press(gladys, letter = 'a', { mac = MAC_ID, value = 1 } = {}) {
  const feature = { external_id: F(`relay-${letter}:open`, mac) };
  return within(gladys.fake.setValue({ external_id: D(mac) }, feature, value), 8000, 'ack');
}
