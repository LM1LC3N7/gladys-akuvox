// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// fake devices on real loopback sockets: the readings really leave every
// interval, measured from the start of the previous cycle (time sped up 20
// times: 10 s is 0.5 s); openings go end to end on the real clock, not sped
// up, with slow devices (their budget is real time).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AkuvoxApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { startFakeAkuvox } from './helpers/fakeAkuvox.js';
import { sleep, until, within } from './helpers/app.js';

/** The app on the real clock, `speed` times faster. */
function realApp(t, fakes, speed, config = {}) {
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / speed);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'akuvox',
    config: {
      hosts: fakes.map((f) => f.host).join(','),
      auth: 'none',
      allow_open: true,
      ...config,
    },
  });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new AkuvoxApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers,
    now: () => Date.now() * speed,
    monotonic: () => performance.now() * speed,
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(() => app.stop());
  return { gladys, app, timersSet: () => timersSet };
}

test('real clock x20: a reading every 10 s, never sooner, never a cycle late', async (t) => {
  const fake = await startFakeAkuvox({ auth: 'none', latency: { '/api/relay/status': 30 } });
  t.after(() => fake.close());
  const at = [];
  const start = performance.now();
  const original = fake.requests.push.bind(fake.requests);
  fake.requests.push = (r) => {
    if (r.path === '/api/system/info') at.push(Math.round((performance.now() - start) * 20));
    return original(r);
  };
  const { gladys, timersSet } = realApp(t, [fake], 20);
  await within(gladys.connect(), 5000);
  const end = start + 65_000 / 20;
  while (performance.now() < end) await sleep(5);
  assert.ok(at.length >= 6 && at.length <= 8, `readings at ${at}`);
  for (let i = 1; i < at.length; i += 1) {
    const gap = at[i] - at[i - 1];
    assert.ok(gap >= 0.9 * 10_000, `never sooner than 10 s: ${at}`);
    assert.ok(gap < 1.5 * 10_000, `on time: ${at}`);
  }
  assert.ok(timersSet() < 50, `timers bounded: ${timersSet()}`);
});

test('real clock: 5 slow devices (600 ms per answer) opened by one scene, within the ack budget', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) {
    fakes.push(await startFakeAkuvox({ auth: 'none', mac: `AA:BB:CC:DD:EE:2${i}` }));
  }
  t.after(() => Promise.all(fakes.map((f) => f.close())));
  const { gladys, app } = realApp(t, fakes, 1);
  await within(gladys.connect(), 5000);
  await until(() => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer), 5000);
  for (const fake of fakes) fake.latency['*'] = 600;
  const started = performance.now();
  const acks = await within(
    Promise.all(
      fakes.map((_, i) =>
        gladys.fake.setValue(
          { external_id: `ext:akuvox:akuvox:aabbccddee2${i}` },
          { external_id: `ext:akuvox:akuvox:aabbccddee2${i}:relay-a:open` },
          1,
        ),
      ),
    ),
    8000,
  );
  const took = performance.now() - started;
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
  assert.ok(took < 3500, `${Math.round(took)} ms`);
  assert.equal(fakes.filter((f) => f.count('POST', '/api/relay/trig') === 1).length, 5);
});

test('real clock: a device answering in 4 s is never opened late ("nothing sent" in time)', async (t) => {
  const fake = await startFakeAkuvox({ auth: 'none' });
  t.after(() => fake.close());
  const { gladys, app } = realApp(t, [fake], 1);
  await within(gladys.connect(), 5000);
  await until(() => [...app.sessions.values()].every((s) => s.state === 'ok' && s.timer), 5000);
  fake.latency['/api/system/info'] = 4000;
  const started = performance.now();
  const ack = await within(
    gladys.fake.setValue(
      { external_id: 'ext:akuvox:akuvox:aabbccddee01' },
      { external_id: 'ext:akuvox:akuvox:aabbccddee01:relay-a:open' },
      1,
    ),
    6000,
  );
  assert.ok(performance.now() - started < 4000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé/);
  await sleep(200);
  assert.equal(fake.count('POST', '/api/relay/trig'), 0);
});
