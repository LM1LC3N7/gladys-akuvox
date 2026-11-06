// -----------------------------------------------------------------------------
// The integration end to end: the fake Gladys of the SDK, the handlers of the
// container, fake Akuvox devices on loopback, a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as realRequest } from '../src/http.js';
import { MemoryStore } from '../src/store.js';
import { MAC_ID, PASSWORD, callEntry, doorEntry, startFakeAkuvox } from './helpers/fakeAkuvox.js';
import { D, F, createAll, press, setup, sleep, until, within } from './helpers/app.js';

const POLL = 10_000;

/** One full reading cycle of device `i` (its timer is due after the interval). */
async function cycle(s, i = 0, ms = POLL) {
  await s.advance(ms);
  await until(() => s.session(i).timer !== undefined && !s.session(i).currentRead, 4000);
  await sleep(5);
}

const triggers = (fake) =>
  fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/relay/trig');

test('discovery: the MAC address makes the ids, one state and one push button per relay', async (t) => {
  const s = await setup(t);
  await s.ready();
  const [device] = s.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, D());
  assert.equal(device.name, 'Akuvox X916S Entrée');
  const byId = Object.fromEntries(device.features.map((f) => [f.external_id, f]));
  assert.deepEqual(Object.keys(byId).sort(), [
    F('relay-a:open'),
    F('relay-a:state'),
    F('relay-b:open'),
    F('relay-b:state'),
  ]);
  for (const feature of device.features) {
    assert.notEqual(feature.category, 'switch', 'never a switch');
    assert.notEqual(feature.type, 'binary', 'never a binary');
    assert.equal(feature.supported_options, undefined);
  }
  assert.equal(byId[F('relay-a:open')].category, 'button');
  assert.equal(byId[F('relay-a:open')].type, 'push');
  assert.equal(byId[F('relay-a:state')].category, 'lock');
  assert.equal(byId[F('relay-a:state')].read_only, true);
  assert.match(byId[F('relay-a:open')].name, /Portail/);
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 1);
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 1);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /X916S, 2 relais/);
  // Released relay -> 0 (unlocked).
  s.fake.relays.RelayB = 'open';
  await cycle(s);
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 0);
});

test('the supported_options rule of the core holds for every published feature', async (t) => {
  const s = await setup(t);
  await s.ready();
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  const normalize = existsSync(core)
    ? createRequire(import.meta.url)(core).normalizeSupportedOptions
    : undefined;
  for (const feature of s.gladys.fake.discoveredDevices.flatMap((d) => d.features)) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    for (const option of options) {
      assert.equal(typeof option.label, 'string');
      assert.equal(option.label, option.label.trim());
      assert.ok(option.label);
    }
    assert.equal(new Set(options.map((o) => `${o.value}`)).size, options.length);
    if (normalize) assert.deepEqual(normalize(options, { allowStringValues: true }), options);
  }
});

test('opening off by default: refused, nothing sent', async (t) => {
  const s = await setup(t, { config: { allow_open: undefined } });
  await s.ready();
  await createAll(s.gladys);
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /ouverture désactivée/);
  assert.equal(triggers(s.fake).length, 0);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /ouverture désactivée/);
});

test('opening: identity read right before, automatic close, bounded duration, confirmed by a reading', async (t) => {
  const s = await setup(t, { config: { open_seconds: 99 } });
  await s.ready();
  const before = s.fake.requests.length;
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data, /confirmé/);
  const after = s.fake.requests.slice(before).filter((r) => r.authorized);
  assert.deepEqual(
    after.map((r) => `${r.method} ${r.path}`),
    [
      'GET /api/system/info',
      'GET /api/config/get',
      'POST /api/relay/trig',
      'GET /api/relay/status',
    ],
  );
  assert.deepEqual(after[2].json, {
    target: 'relay',
    action: 'trig',
    data: { num: 1, mode: 0, level: 0, delay: 30 },
  });
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 0);
  assert.ok(s.lines.some((l) => /Opening .* relay A: accepted/.test(l)));
});

test('opening: the level follows the relay type read on the device (NC)', async (t) => {
  const s = await setup(t);
  s.fake.config['Config.DoorSetting.RELAY.RelayBType'] = '1';
  s.fake.relays.RelayB = 1; // NC at rest
  await s.ready();
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 1);
  s.fake.releaseOnTrigger = false;
  await press(s.gladys, 'b');
  assert.deepEqual(triggers(s.fake)[0].json.data, { num: 2, mode: 0, level: 1, delay: 5 });
});

test('opening: a relay in manual (bistable) mode is refused, nothing sent', async (t) => {
  const s = await setup(t);
  s.fake.config['Config.DoorSetting.RELAY.RelayAMode'] = '1';
  await s.ready();
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /mode manuel/);
  assert.equal(triggers(s.fake).length, 0);
});

test('opening: another device at the address (MAC read right before) -> nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.mac = 'AA:BB:CC:DD:EE:99';
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /autre appareil/);
  assert.equal(triggers(s.fake).length, 0);
});

test('opening: the option unchecked while the command waits for the device -> withdrawn before the write', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/system/info'] = 300;
  const pending = press(s.gladys, 'a');
  await until(() => s.fake.requests.at(-1).path === '/api/system/info');
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config, allow_open: false });
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien envoyé \(ouverture désactivée/);
  await sleep(50);
  assert.equal(triggers(s.fake).length, 0);
});

test('opening: a slow reading never holds it; the reading is aborted first and never applied', async (t) => {
  const s = await setup(t);
  await s.ready();
  // The next cycle: the relay status answers in 2 s with the state of its departure.
  s.fake.relays.RelayB = 'open';
  s.fake.latency['/api/relay/status'] = 2000;
  await s.advance(POLL);
  await until(() => s.fake.requests.at(-1).path === '/api/relay/status');
  s.fake.relays.RelayB = 'closed';
  delete s.fake.latency['/api/relay/status'];
  const from = s.gladys.fake.states.length;
  const started = Date.now();
  const ack = await press(s.gladys, 'a');
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(ack.success, true, ack.error);
  // The reading was closed before the trigger left: one connection at a time.
  assert.equal(triggers(s.fake)[0].open, 1);
  await sleep(2200);
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 1, 'the old "open" never applied');
  assert.ok(
    s.gladys.fake.states
      .slice(from)
      .every((x) => x.device_feature_external_id !== F('relay-b:state')),
  );
});

test('a reading answered just before a command is not applied after it (epoch)', async (t) => {
  // The transport delivers a relay status answer only once a command started.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let hold = false;
  const request = async (options) => {
    const answer = await realRequest(options);
    if (hold && options.path === '/api/relay/status' && options.method === undefined) {
      hold = false;
      await held;
    }
    return answer;
  };
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], timings: {}, start: false });
  s.app.request = request;
  await within(s.gladys.connect(), 5000);
  await s.ready();
  fake.relays.RelayB = 'open';
  hold = true;
  const from = s.gladys.fake.states.length;
  await s.advance(POLL);
  await until(() => hold === false);
  fake.relays.RelayB = 'closed';
  const ack = press(s.gladys, 'a');
  await until(() => triggers(fake).length === 1);
  release();
  assert.equal((await ack).success, true);
  await sleep(50);
  const relayB = s.gladys.fake.states
    .slice(from)
    .filter((x) => x.device_feature_external_id === F('relay-b:state'));
  assert.deepEqual(relayB, [], 'the old "open" was never published');
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 1);
});

test('two relays of one device, one after the other, both opened; one identity reading', async (t) => {
  const s = await setup(t);
  await s.ready();
  const before = s.fake.requests.length;
  const [a, b] = await Promise.all([press(s.gladys, 'a'), press(s.gladys, 'b')]);
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(
    triggers(s.fake).map((r) => r.json.data.num),
    [1, 2],
  );
  const infos = s.fake.requests
    .slice(before)
    .filter((r) => r.authorized && r.path === '/api/system/info');
  assert.equal(infos.length, 1);
});

test('a scene opening 5 slow devices (600 ms per answer): all 5 opened', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) {
    fakes.push(await startFakeAkuvox({ auth: 'none', mac: `AA:BB:CC:DD:EE:1${i}` }));
  }
  const s = await setup(t, { fakes, config: { auth: 'none' } });
  await s.step(0);
  await until(
    () =>
      s.app.sessions.size === 5 &&
      [...s.app.sessions.values()].every((x) => x.state === 'ok' && x.timer),
    5000,
  );
  for (const fake of fakes) fake.latency['*'] = 600;
  const acks = await Promise.all(
    fakes.map((_, i) => press(s.gladys, 'a', { mac: `aabbccddee1${i}` })),
  );
  assert.equal(fakes.filter((f) => triggers(f).length === 1).length, 5);
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
});

test('one device down never stops another; all down is not "connected"', async (t) => {
  const a = await startFakeAkuvox();
  const b = await startFakeAkuvox({ mac: 'AA:BB:CC:DD:EE:02' });
  const s = await setup(t, { fakes: [a, b] });
  await s.step(0);
  await until(
    () =>
      s.session(0).state === 'ok' &&
      s.session(1).state === 'ok' &&
      s.session(0).timer &&
      s.session(1).timer,
  );
  await b.close();
  a.relays.RelayA = 'open';
  await cycle(s, 0);
  await until(() => s.session(1).state === 'down');
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 0);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /injoignable/);
  await a.close();
  await s.advance(POLL);
  await until(() => s.session(0).state === 'down');
  await sleep(10);
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
});

test('credentials refused: no more tries, kept across a restart, lifted by the test button or new credentials', async (t) => {
  const store = new MemoryStore();
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], store, config: { password: 'wrong' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  const count = fake.requests.length;
  assert.equal(count, 2, 'one challenge answered, then the refusal');
  for (let i = 0; i < 10; i += 1) await s.step(60_000);
  assert.equal(fake.requests.length, count, 'no automatic try');
  await until(() => store.saves === 1);
  assert.equal(Object.keys(store.data.refused).length, 1);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /identifiants refusés/);
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  // A restart with the same credentials: nothing sent.
  const again = await setup(t, { fakes: [fake], store, config: { password: 'wrong' } });
  await again.step(0);
  await sleep(50);
  assert.equal(fake.requests.length, count);
  assert.equal(again.session().state, 'refused');
  // The test button: one try per click.
  const test1 = await within(again.gladys.fake.action('test_connection'), 5000);
  assert.match(JSON.stringify(test1), /refusés/);
  assert.equal(fake.requests.length, count + 2);
  // New credentials: tried again, the refusal removed.
  await again.gladys.fake.configUpdated({ ...again.gladys.fake.config, password: PASSWORD });
  await until(() => Object.keys(store.data.refused).length === 0); // before any new try
  await again.step(0);
  await until(() => again.session().state === 'ok');
  await until(() => Object.keys(store.data.refused).length === 0);
  assert.equal(again.session().state, 'ok');
});

test('the test button lifts a refusal when the device accepts, at most once every 5 s', async (t) => {
  const store = new MemoryStore();
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], store, config: { password: 'wrong' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  fake.password = 'wrong';
  const ok = await within(s.gladys.fake.action('test_connection'), 5000);
  assert.match(JSON.stringify(ok), /connexion réussie/);
  const tooSoon = await within(s.gladys.fake.action('test_connection'), 5000);
  assert.match(JSON.stringify(tooSoon), /moins de 5 s/);
  await s.step(0);
  await until(() => s.session().state === 'ok');
  await until(() => Object.keys(store.data.refused).length === 0);
});

test('403 (address not allowed) is not a refusal: tried again after 1 min, then 2', async (t) => {
  const fake = await startFakeAkuvox();
  fake.status['/api/system/info'] = 403;
  const s = await setup(t, { fakes: [fake] });
  await s.step(0);
  await until(() => s.session().state === 'forbidden');
  const n = () => fake.requests.filter((r) => r.authorized).length;
  const first = n();
  await s.step(59_000);
  assert.equal(n(), first);
  await s.step(1000);
  await until(() => n() === first + 1);
  await s.step(119_000);
  assert.equal(n(), first + 1);
  await s.step(1000);
  await until(() => n() === first + 2);
  assert.deepEqual(s.store.data.refused, {});
  assert.match(s.gladys.fake.connectionStatus.message.fr, /403/);
});

test('door log: a baseline first, then granted and denied accesses as events, never the code', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(40), doorEntry(41)];
  await s.ready();
  assert.equal(s.gladys.fake.sceneEvents.length, 0, 'old entries are no event');
  s.fake.doorLog = [
    doorEntry(42, { Name: 'Bob', Type: 'Card', Relay: '2' }),
    doorEntry(43, { Status: 'Failed', Name: '' }),
    doorEntry(44, { Status: '??' }),
    ...s.fake.doorLog,
  ];
  await cycle(s);
  assert.deepEqual(s.gladys.fake.sceneEvents, [
    { key: 'door_opened', data: { device: D(), relay: '2', method: 'Card', user: 'Bob' } },
    { key: 'access_denied', data: { device: D(), relay: '1', method: 'PIN', user: null } },
  ]);
  assert.ok(!JSON.stringify(s.gladys.fake.sceneEvents).includes('4321'));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 2, 'once');
});

test('door log: the entry of an opening from Gladys is no event (no loop); the next one is', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await press(s.gladys, 'a');
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'HTTP', Name: '' }));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
  s.fake.doorLog.unshift(doorEntry(3));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 1);
});

test('call log: new calls as events; logs failing never hold the relays', async (t) => {
  const s = await setup(t);
  s.fake.callLog = [callEntry(100)];
  await s.ready();
  s.fake.callLog.unshift(callEntry(101), callEntry(102, { Type: 'Missed', Name: 'Front Door' }));
  await cycle(s);
  assert.deepEqual(
    s.gladys.fake.sceneEvents.map((e) => e.data),
    [
      { device: D(), type: 'dialed', name: 'Appartement 12' },
      { device: D(), type: 'missed', name: 'Front Door' },
    ],
  );
  s.fake.status['/api/doorlog/get'] = 500;
  s.fake.retcode['/api/calllog/get'] = -1;
  s.fake.relays.RelayA = 'open';
  await cycle(s);
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 0);
  assert.equal(s.session().state, 'ok');
  assert.match(s.gladys.fake.connectionStatus.message.fr, /journaux non lus/);
  delete s.fake.status['/api/doorlog/get'];
  s.fake.status['/api/calllog/get'] = 404;
  s.fake.body['/api/doorlog/get'] = JSON.stringify({ retcode: 0, message: 'Api unsupported' });
  await cycle(s);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /journaux non pris en charge/);
  const reads = s.fake.count('GET', '/api/doorlog/get');
  await cycle(s);
  assert.equal(s.fake.count('GET', '/api/doorlog/get'), reads, 'not asked again for an hour');
});

test('an outage longer than the bound: the entries made meanwhile are no events', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  s.fake.status['/api/system/info'] = 500;
  for (let i = 0; i < 5; i += 1) await s.step(60_000);
  await until(() => s.session().state === 'down');
  s.fake.doorLog.unshift(doorEntry(2));
  delete s.fake.status['/api/system/info'];
  await s.advanceUntil(() => s.session().state === 'ok', { every: 10_000 });
  await until(() => s.session().timer !== undefined);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
  s.fake.doorLog.unshift(doorEntry(3));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 1);
});

test('another device at the same address: a new device, nothing of the old one republished', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(5)];
  await s.ready();
  s.fake.mac = 'AA:BB:CC:DD:EE:77';
  s.fake.relays.RelayA = 'open';
  s.fake.doorLog.unshift(doorEntry(6));
  await cycle(s);
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 1, 'the old device keeps its state');
  assert.equal(s.gladys.fake.lastState(F('relay-a:state', 'aabbccddee77')), 0);
  assert.deepEqual(
    s.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [D('aabbccddee77')],
  );
  assert.equal(s.gladys.fake.sceneEvents.length, 0, 'a new device starts with a baseline');
});

test('sent without an answer: "maybe opened", never sent again; refused by the device', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.silent.add('/api/relay/trig');
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans réponse/);
  for (let i = 0; i < 6; i += 1) await s.step(POLL);
  assert.equal(triggers(s.fake).length, 1);
  s.fake.silent.delete('/api/relay/trig');
  s.fake.retcode['/api/relay/trig'] = -1;
  const refused = await press(s.gladys, 'a');
  assert.match(refused.error, /refusée par l’appareil/);
  assert.match(
    s.gladys.fake.connectionStatus.message.fr,
    /dernière ouverture : relais A : refusée/,
  );
});

test('accepted but not released yet: not reported confirmed; read back later', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.releaseOnTrigger = false;
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore relue/);
  s.fake.relays.RelayA = 'open';
  await s.step(800);
  await until(() => /ouvert, confirmé/.test(s.gladys.fake.connectionStatus.message.fr));
});

test('commands that are not an opening, a wrong value, an unknown device: refused, nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  const device = { external_id: D() };
  const cases = [
    [{ external_id: F('relay-a:state') }, 1, /pas une commande/],
    [{ external_id: F('relay-a:open') }, 0, /valeur inattendue/],
    [{ external_id: F('relay-z:open') }, 1, /inconnu/],
    [{ external_id: F('relay-a:open', '112233445566') }, 1, /inconnu/],
    [{ external_id: 'ext:akuvox:other:x' }, 1, /inconnu/],
  ];
  for (const [feature, value, error] of cases) {
    const ack = await within(s.gladys.fake.setValue(device, feature, value), 5000);
    assert.equal(ack.success, false);
    assert.match(ack.error, error);
  }
  delete s.fake.relays.RelayB;
  await cycle(s);
  const ack = await press(s.gladys, 'b');
  assert.match(ack.error, /relais absent/);
  assert.equal(triggers(s.fake).length, 0);
});

test('too many commands waiting on one device: refused at once', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['*'] = 400;
  const acks = await Promise.all(Array.from({ length: 6 }, () => press(s.gladys, 'a')));
  assert.ok(acks.some((a) => /trop de commandes/.test(a.error ?? '')));
  assert.ok(triggers(s.fake).length <= 4);
});

test('getConfig failing on (re)connection: tried again with a status, then started', async (t) => {
  const s = await setup(t);
  await s.ready();
  let fail = 1;
  const original = s.gladys.getConfig.bind(s.gladys);
  s.gladys.getConfig = async () => {
    if (fail-- > 0) throw new Error('boom');
    return original();
  };
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config, poll_interval: 20 });
  assert.equal(s.app.config.pollMs, 20_000);
  s.gladys.emit('connected');
  await until(() => /Configuration illisible/.test(s.gladys.fake.connectionStatus?.message?.fr));
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  await s.step(5000);
  await until(() => s.gladys.fake.connectionStatus.connected === true);
  assert.equal(fail, -1);
});

test('secrets: the password is in no log, status, Discovery, event, /data', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  s.fake.doorLog.unshift(doorEntry(2));
  await press(s.gladys, 'a');
  await cycle(s);
  await within(s.gladys.fake.action('test_connection'), 5000);
  const everything = JSON.stringify([
    s.lines,
    s.gladys.fake.connectionStatuses,
    s.gladys.fake.discoveredDevices,
    s.gladys.fake.sceneEvents,
    s.gladys.fake.states,
    s.store.data,
  ]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes('sip-password-never-read'));
});

test('/data unreadable: never overwritten; a stuck disk holds nothing', async (t) => {
  const store = new MemoryStore(undefined, { state: 'unreadable' });
  const s = await setup(t, { store, config: { password: 'wrong' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  await sleep(20);
  assert.equal(store.saves, 0);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /\/data illisible/);
  // A stuck disk: a refusal is written in the background, a command answers at once.
  let unstick;
  const stuck = new MemoryStore();
  stuck.stuck = new Promise((resolve) => (unstick = resolve));
  t.after(() => unstick());
  const a = await startFakeAkuvox();
  const b = await startFakeAkuvox({ mac: 'AA:BB:CC:DD:EE:02', password: 'other' });
  const u = await setup(t, { fakes: [a, b], store: stuck });
  await u.step(0);
  await until(() => u.session(0).state === 'ok' && u.session(1).state === 'refused');
  const started = Date.now();
  const ack = await press(u.gladys, 'a');
  assert.equal(ack.success, true, ack.error);
  assert.ok(Date.now() - started < 1000);
});

test('configuration saved twice in a row: applied one by one, the last wins', async (t) => {
  const a = await startFakeAkuvox();
  const b = await startFakeAkuvox({ mac: 'AA:BB:CC:DD:EE:02' });
  const s = await setup(t, { fakes: [a, b] });
  await s.step(0);
  await Promise.all([
    s.gladys.fake.configUpdated({ ...s.gladys.fake.config, hosts: a.host }),
    s.gladys.fake.configUpdated({ ...s.gladys.fake.config, hosts: b.host }),
  ]);
  assert.deepEqual([...s.app.sessions.keys()], [b.host]);
});

test('stop: no timer, no request afterwards, even stopped in the middle of a cycle', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/relay/status'] = 200;
  await s.advance(POLL);
  await until(() => s.fake.requests.at(-1).path === '/api/relay/status');
  await s.app.stop();
  await sleep(300);
  const count = s.fake.requests.length;
  for (let i = 0; i < 5; i += 1) await s.step(POLL);
  assert.equal(s.fake.requests.length, count);
  assert.equal([...s.pending.values()].length, 0);
});

test('reconnection to Gladys: states republished from a fresh reading only', async (t) => {
  const s = await setup(t);
  await s.ready();
  const published = s.gladys.fake.states.length;
  s.gladys.emit('connected');
  await until(() => s.app.published.size === 0);
  await sleep(20);
  assert.equal(s.gladys.fake.states.length, published, 'nothing republished from memory');
  await cycle(s);
  assert.equal(s.gladys.fake.states.length, published + 2);
  assert.equal(MAC_ID.length, 12);
});

test('opening off: the reading in flight is not even touched; a command queued when it is unchecked sends nothing', async (t) => {
  const s = await setup(t, { config: { allow_open: false } });
  await s.ready();
  s.fake.relays.RelayB = 'open';
  s.fake.latency['/api/relay/status'] = 300;
  await s.advance(POLL);
  await until(() => s.fake.requests.at(-1).path === '/api/relay/status');
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  await until(() => s.session().timer !== undefined && !s.session().currentRead);
  assert.equal(s.gladys.fake.lastState(F('relay-b:state')), 0, 'the reading went on');
  // Allowed, a first opening waits for a slow device; the option is unchecked meanwhile.
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config, allow_open: true });
  await s.ready();
  s.fake.latency['/api/system/info'] = 300;
  const infos = () =>
    s.fake.requests.filter((r) => r.authorized && r.path === '/api/system/info').length;
  const first = press(s.gladys, 'a');
  await until(() => s.fake.requests.at(-1).path === '/api/system/info');
  const before = infos();
  const connections = s.fake.connections - s.fake.requests.length;
  const second = press(s.gladys, 'b');
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config, allow_open: false });
  await first;
  const ack2 = await second;
  assert.match(ack2.error, /ouverture désactivée/);
  await sleep(50);
  assert.equal(infos(), before, 'the queued command read nothing');
  // One connection opened and withdrawn: the first command's trigger (its option
  // went off while it waited); the queued one opened none.
  assert.equal(
    s.fake.connections - s.fake.requests.length,
    connections + 1,
    'not even a connection for the queued one',
  );
  assert.equal(triggers(s.fake).length, 0);
});

test('opening: the deadline is read again when the bytes would leave', async (t) => {
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], start: false });
  s.app.request = (options) => {
    if (options.path === '/api/relay/trig') s.clock.now += 5000; // the connection took long
    return realRequest(options);
  };
  await within(s.gladys.connect(), 5000);
  await s.ready();
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /délai dépassé/);
  await sleep(50);
  assert.equal(triggers(fake).length, 0);
});

test('a reading never runs beside a command (one connection at a time)', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/system/info'] = 200;
  const from = s.fake.requests.length;
  const pending = press(s.gladys, 'a');
  await until(() => s.fake.requests.length > from);
  s.session().schedule(0);
  await s.advance(0); // a cycle is due while the command runs
  await pending;
  await sleep(20);
  const during = s.fake.requests.slice(from).filter((r) => r.authorized);
  const trigAt = during.findIndex((r) => r.path === '/api/relay/trig');
  assert.deepEqual(
    during.slice(0, trigAt).map((r) => r.path),
    ['/api/system/info', '/api/config/get'],
  );
  assert.ok(
    during.every((r) => r.open === 1),
    JSON.stringify(during.map((r) => r.open)),
  );
});

test('identity read again for a command more than 2 s after the previous one', async (t) => {
  const s = await setup(t);
  await s.ready();
  assert.equal((await press(s.gladys, 'a')).success, true);
  s.fake.relays.RelayA = 'closed';
  await s.advance(3000);
  s.fake.mac = 'AA:BB:CC:DD:EE:99';
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /autre appareil/);
  assert.equal(triggers(s.fake).length, 1);
});

test('opening: mode and type read right before; manual, unknown, unreadable or refused -> nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  const cases = [
    [() => (s.fake.config['Config.DoorSetting.RELAY.RelayAMode'] = '1'), /mode manuel/],
    [() => delete s.fake.config['Config.DoorSetting.RELAY.RelayAMode'], /mode du relais illisible/],
    [
      () => (s.fake.config['Config.DoorSetting.RELAY.RelayAType'] = '7'),
      /mode du relais illisible/,
    ],
    [() => (s.fake.status['/api/config/get'] = 500), /configuration des relais illisible/],
    [() => (s.fake.status['/api/config/get'] = 404), /mode du relais illisible/],
    [() => (s.fake.status['/api/config/get'] = 403), /configuration des relais non autorisée/],
    [() => (s.fake.status['/api/config/get'] = 401), /configuration des relais non autorisée/],
  ];
  for (const [change, error] of cases) {
    const saved = { ...s.fake.config };
    change();
    const ack = await press(s.gladys, 'a');
    assert.match(ack.error ?? '', error);
    s.fake.config = saved;
    delete s.fake.status['/api/config/get'];
  }
  assert.equal(triggers(s.fake).length, 0);
  assert.equal(s.session().state, 'ok', 'a 401 on the configuration is no credentials refusal');
  assert.equal((await press(s.gladys, 'a')).success, true);
});

test('a device without the configuration API: integer states read as NO; never opened (mode unknown)', async (t) => {
  const s = await setup(t);
  s.fake.status['/api/config/get'] = 404;
  s.fake.relays = { RelayA: 0 };
  await s.ready();
  assert.equal(s.gladys.fake.lastState(F('relay-a:state')), 1);
  assert.match((await press(s.gladys, 'a')).error, /mode du relais illisible/);
  assert.equal(triggers(s.fake).length, 0);
});

test('a relay already released before the opening is never reported confirmed by it', async (t) => {
  const s = await setup(t);
  s.fake.relays.RelayA = 'open';
  await s.ready();
  const ack = await press(s.gladys, 'a');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore relue/);
});

test('an unreachable device is tried again after 10 s, 20 s, 40 s… at most 5 minutes', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.status['/api/system/info'] = 500;
  const tries = () =>
    s.fake.requests.filter((r) => r.authorized && r.path === '/api/system/info').length;
  const at = [];
  let last = tries();
  for (let ms = 0; ms <= 1_200_000; ms += 1000) {
    await s.advance(1000);
    if (s.pending.size === 0 || [...s.pending.values()].some((p) => p.at <= s.clock.now)) {
      await until(() => s.session().timer !== undefined, 2000);
    }
    await sleep(1);
    if (tries() !== last) {
      last = tries();
      at.push(ms + 1000);
    }
  }
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  assert.deepEqual(gaps.slice(0, 6), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  assert.ok(
    gaps.slice(5).every((g) => g === 300_000),
    `${gaps}`,
  );
});

test('Discovery keeps a created relay the device does not show this time; created devices get fresh states', async (t) => {
  const s = await setup(t);
  await s.ready();
  await createAll(s.gladys);
  delete s.fake.relays.RelayB;
  await cycle(s);
  await within(s.gladys.fake.scanRequest(), 5000);
  const ids = s.gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(ids.includes(F('relay-b:open')) && ids.includes(F('relay-b:state')));
  const published = s.gladys.fake.states.length;
  await within(s.gladys.fake.deviceUpdated(s.gladys.fake.devices[0]), 5000);
  await cycle(s);
  assert.equal(s.gladys.fake.states.length, published + 1, 'relay A again, from a fresh reading');
});

test('rate limits: 200 scene events and 250 states per minute at most', async (t) => {
  const s = await setup(t);
  await s.ready();
  const before = s.gladys.fake.sceneEvents.length;
  for (let i = 0; i < 260; i += 1)
    s.app.sceneEvent('call', { device: D(), type: 'dialed', name: null });
  await until(() => s.gladys.fake.sceneEvents.length >= before + 200);
  await sleep(50);
  assert.equal(s.gladys.fake.sceneEvents.length, before + 200);
  const states = s.gladys.fake.states.length;
  for (let i = 0; i < 300; i += 1) s.app.publishRelay(s.session(), 'a', i % 2);
  await sleep(200);
  assert.ok(s.gladys.fake.states.length - states <= 250);
  await s.advance(60_000);
  s.app.sceneEvent('call', { device: D(), type: 'dialed', name: null });
  await until(() => s.gladys.fake.sceneEvents.length === before + 201);
});

test('an invalid address is counted in the status, never shown back', async (t) => {
  const s = await setup(t);
  await s.ready();
  await s.gladys.fake.configUpdated({
    ...s.gladys.fake.config,
    hosts: `${s.fake.host}, evil<script>`,
  });
  await until(() => /ignorée/.test(s.gladys.fake.connectionStatus.message.fr));
  assert.ok(!JSON.stringify(s.gladys.fake.connectionStatuses).includes('evil'));
});

// --- review r1 ----------------------------------------------------------------

test('401/403 on a log or the configuration: "not allowed" for it alone, never a refusal; relays read on', async (t) => {
  const s = await setup(t, { config: { poll_interval: 5 } });
  await s.ready();
  s.fake.status['/api/calllog/get'] = 401;
  s.fake.status['/api/doorlog/get'] = 403;
  await cycle(s, 0, 5000);
  assert.equal(s.session().state, 'ok');
  assert.match(s.gladys.fake.connectionStatus.message.fr, /journal des appels non autorisé/);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /journal des portes non autorisé/);
  const relays = () => s.fake.count('GET', '/api/relay/status');
  const logs = () => s.fake.count('GET', '/api/doorlog/get');
  const [r0, l0] = [relays(), logs()];
  for (let i = 0; i < 10; i += 1) await cycle(s, 0, 5000);
  assert.ok(relays() >= r0 + 10, 'the relays are read at every interval');
  assert.equal(logs(), l0, 'the refused log waits 1 minute');
  await cycle(s, 0, 5000);
  await cycle(s, 0, 5000);
  assert.equal(logs(), l0 + 1, 'asked again after 1 minute');
  assert.deepEqual(s.store.data.refused, {});
  // The configuration refused in a cycle: relays still read.
  delete s.fake.status['/api/calllog/get'];
  delete s.fake.status['/api/doorlog/get'];
  s.fake.status['/api/config/get'] = 401;
  s.session().relayConfig.at -= 11 * 60_000;
  await cycle(s, 0, 5000);
  assert.equal(s.session().state, 'ok');
  assert.match(s.gladys.fake.connectionStatus.message.fr, /configuration non autorisée/);
  assert.deepEqual(s.store.data.refused, {});
});

for (const interval of [60, 300]) {
  test(`own opening at a ${interval} s interval: its log entry is no event, a badge right after is`, async (t) => {
    const s = await setup(t, { config: { poll_interval: interval } });
    s.fake.doorLog = [doorEntry(1)];
    await s.ready();
    assert.equal((await press(s.gladys, 'a')).success, true);
    s.fake.doorLog.unshift(doorEntry(2, { Type: 'HTTP', Name: '' }));
    s.fake.doorLog.unshift(doorEntry(3, { Type: 'Card', Name: 'Bob' }));
    await cycle(s, 0, interval * 1000);
    assert.deepEqual(
      s.gladys.fake.sceneEvents.map((e) => e.data.user),
      ['Bob'],
      'the badge is published, the opening by Gladys is not',
    );
  });
}

test('own opening: kept across a failed door log reading; dropped after two readings without it', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await press(s.gladys, 'a');
  s.fake.status['/api/doorlog/get'] = 500;
  await cycle(s);
  delete s.fake.status['/api/doorlog/get'];
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'HTTP', Name: '' }));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
  // Another opening whose entry never comes: after two readings, a later
  // remote opening is an event again.
  await press(s.gladys, 'a');
  await cycle(s);
  await cycle(s);
  assert.equal(s.session().ownOpens.length, 0);
  s.fake.doorLog.unshift(doorEntry(3, { Type: 'Remote', Name: '' }));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 1);
});

test('own opening sent without an answer: its log entry is no event either', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  s.fake.silent.add('/api/relay/trig');
  assert.match((await press(s.gladys, 'a')).error, /envoyée, sans réponse/);
  s.fake.silent.delete('/api/relay/trig');
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'HTTP', Name: '' }));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('trigger written, then the connection cut: "maybe opened", never "nothing sent"', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.drop.add('/api/relay/trig');
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /envoyée, sans réponse/);
  assert.equal(triggers(s.fake).length, 1);
});

test('credentials refused during an opening: no automatic try afterwards, the queued one sends nothing', async (t) => {
  const s = await setup(t, { config: { poll_interval: 5 } });
  await s.ready();
  s.fake.password = 'changed-on-the-device';
  s.fake.latency['/api/system/info'] = 100;
  const from = s.fake.requests.length;
  const [a, b] = await Promise.all([press(s.gladys, 'a'), press(s.gladys, 'b')]);
  assert.equal(s.fake.requests.length - from, 1, 'the queued one sent nothing at all');
  assert.match(a.error, /identifiants refusés/);
  assert.match(b.error, /identifiants refusés/);
  const count = s.fake.requests.length;
  for (let i = 0; i < 10; i += 1) await s.step(5000);
  await sleep(50);
  assert.equal(s.fake.requests.length, count, 'not one more request');
  assert.equal(triggers(s.fake).length, 0);
});

test('the 403 wait doubles up to 1 hour, never beyond', async (t) => {
  const s = await setup(t);
  await s.ready();
  const waits = Array.from({ length: 9 }, () => s.session().readFailed({ kind: 'forbidden' }));
  assert.deepEqual(waits, [60e3, 120e3, 240e3, 480e3, 960e3, 1920e3, 3600e3, 3600e3, 3600e3]);
});

test('the deadline passed while reading the configuration: "too late", no trigger, no connection', async (t) => {
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], start: false });
  s.app.request = async (options) => {
    const answer = await realRequest(options);
    if (
      options.path === '/api/config/get' &&
      options.signal === s.session().stopController.signal
    ) {
      s.clock.now += 3250; // 50 ms left
    }
    return answer;
  };
  await within(s.gladys.connect(), 5000);
  await s.ready();
  const connections = fake.connections;
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /délai dépassé/);
  await sleep(50);
  assert.equal(triggers(fake).length, 0);
  assert.equal(fake.connections, connections + 2, 'identity and configuration only');
});

test('the option unchecked while Discovery is slow applies at once', async (t) => {
  const s = await setup(t);
  await s.ready();
  let release;
  s.gladys.publishDiscoveredDevices = () => new Promise((resolve) => (release = resolve));
  t.after(() => release?.());
  await within(s.gladys.fake.configUpdated({ ...s.gladys.fake.config, poll_interval: 20 }), 3000);
  await within(s.gladys.fake.configUpdated({ ...s.gladys.fake.config, allow_open: false }), 3000);
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /ouverture désactivée/);
  assert.equal(triggers(s.fake).length, 0);
});

test('a refusal kept from before a restart: saving the configuration tries once more', async (t) => {
  const store = new MemoryStore();
  const fake = await startFakeAkuvox();
  const first = await setup(t, { fakes: [fake], store, config: { password: 'wrong' } });
  await first.step(0);
  await until(() => Object.keys(store.data.refused).length === 1);
  await first.app.stop();
  // The password fixed on the device meanwhile: same fingerprint, refused at start.
  fake.password = 'wrong';
  const s = await setup(t, { fakes: [fake], store, config: { password: 'wrong' } });
  await s.step(0);
  assert.equal(s.session().state, 'refused');
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config });
  await s.ready();
  await until(() => Object.keys(store.data.refused).length === 0);
});

test('the true cause of a refused opening: 403, Basic asked', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.status['/api/system/info'] = 403;
  assert.match((await press(s.gladys, 'a')).error, /accès refusé par l’appareil \(403\)/);
  delete s.fake.status['/api/system/info'];
  s.fake.auth = 'basic';
  s.session().digest.challenge = undefined;
  assert.match((await press(s.gladys, 'a')).error, /demande Basic/);
  assert.equal(triggers(s.fake).length, 0);
});

test('own opening whose entry shows one reading late: still no event', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await press(s.gladys, 'a');
  await cycle(s);
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'HTTP', Name: '' }));
  await cycle(s);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('the deadline passed while reading the identity: "too late", the configuration not even read', async (t) => {
  const fake = await startFakeAkuvox();
  const s = await setup(t, { fakes: [fake], start: false });
  s.app.request = async (options) => {
    const answer = await realRequest(options);
    if (
      options.path === '/api/system/info' &&
      options.signal === s.session().stopController.signal
    ) {
      s.clock.now += 3250;
    }
    return answer;
  };
  await within(s.gladys.connect(), 5000);
  await s.ready();
  const configs = fake.count('GET', '/api/config/get');
  const ack = await press(s.gladys, 'a');
  assert.match(ack.error, /délai dépassé/);
  await sleep(50);
  assert.equal(fake.count('GET', '/api/config/get'), configs);
  assert.equal(triggers(fake).length, 0);
});

test('own opening the device did not log: a badge right after on that relay is still published', async (t) => {
  const s = await setup(t);
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await press(s.gladys, 'a');
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'Card', Name: 'Dave' }));
  await cycle(s);
  assert.deepEqual(
    s.gladys.fake.sceneEvents.map((e) => e.data.user),
    ['Dave'],
  );
});

// --- review r2 ----------------------------------------------------------------

test('configuration refused (401): not asked again before 1 minute, then asked; relays read meanwhile', async (t) => {
  const s = await setup(t, { config: { poll_interval: 5 } });
  await s.ready();
  s.fake.status['/api/config/get'] = 401;
  s.session().relayConfig.at -= 11 * 60_000;
  const configs = () => s.fake.count('GET', '/api/config/get');
  const c0 = configs();
  const r0 = s.fake.count('GET', '/api/relay/status');
  for (let i = 0; i < 8; i += 1) await cycle(s, 0, 5000);
  assert.equal(configs(), c0 + 1, 'once in 40 s');
  assert.ok(s.fake.count('GET', '/api/relay/status') >= r0 + 8);
  for (let i = 0; i < 3; i += 1) await cycle(s, 0, 5000);
  assert.equal(configs(), c0 + 1, 'still not at 55 s');
  for (let i = 0; i < 2; i += 1) await cycle(s, 0, 5000);
  assert.equal(configs(), c0 + 2, 'asked again after 1 minute');
});

test('a reconnection to Gladys never tries refused credentials again', async (t) => {
  const s = await setup(t, { config: { password: 'wrong' } });
  await s.step(0);
  await until(() => s.session().state === 'refused');
  const count = s.fake.requests.length;
  s.gladys.emit('connected');
  await until(() => s.app.published.size === 0);
  for (let i = 0; i < 3; i += 1) await s.step(10_000);
  await sleep(50);
  assert.equal(s.fake.requests.length, count);
  assert.equal(s.session().state, 'refused');
});

test('a refused endpoint read again with success: its next refusal waits 1 minute again', async (t) => {
  const s = await setup(t, { config: { poll_interval: 5 } });
  await s.ready();
  s.fake.status['/api/doorlog/get'] = 403;
  await cycle(s, 0, 5000);
  assert.equal(s.session().logWait.door, 60_000);
  delete s.fake.status['/api/doorlog/get'];
  for (let i = 0; i < 12; i += 1) await cycle(s, 0, 5000);
  assert.equal(s.session().logState.door, 'ok');
  s.fake.status['/api/doorlog/get'] = 403;
  await cycle(s, 0, 5000);
  assert.equal(s.session().logWait.door, 60_000, 'not 2 minutes');
  // Same for the configuration.
  s.fake.status['/api/config/get'] = 403;
  s.session().relayConfig.at -= 11 * 60_000;
  await cycle(s, 0, 5000);
  assert.equal(s.session().configWait, 60_000);
  delete s.fake.status['/api/config/get'];
  for (let i = 0; i < 12; i += 1) await cycle(s, 0, 5000);
  assert.equal(s.session().configState, 'ok');
  s.fake.status['/api/config/get'] = 403;
  s.session().relayConfig.at -= 11 * 60_000;
  await cycle(s, 0, 5000);
  assert.equal(s.session().configWait, 60_000, 'not 2 minutes');
});

test('own opening marks: 8 at most', async (t) => {
  const s = await setup(t);
  await s.ready();
  for (let i = 0; i < 12; i += 1) s.session().markOwnOpen('a', i);
  assert.equal(s.session().ownOpens.length, 8);
  assert.equal(s.session().ownOpens[0].at, 4, 'the oldest go first');
});

test('own opening mark older than 30 minutes (log unreadable meanwhile): no longer swallows an entry', async (t) => {
  const s = await setup(t, { config: { poll_interval: 300 } });
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await press(s.gladys, 'a');
  s.fake.status['/api/doorlog/get'] = 500;
  for (let i = 0; i < 7; i += 1) await cycle(s, 0, 300_000);
  delete s.fake.status['/api/doorlog/get'];
  // 35 minutes later: the log is read again as a baseline (long gap), the mark dropped by its age.
  await cycle(s, 0, 300_000);
  assert.equal(s.session().ownOpens.length, 0);
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'Remote', Name: '' }));
  await cycle(s, 0, 300_000);
  assert.equal(s.gladys.fake.sceneEvents.length, 1);
});

test('stopped while an opening reads the configuration: "integration stopped", nothing sent', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.latency['/api/config/get'] = 300;
  const pending = press(s.gladys, 'a');
  await until(() => s.fake.requests.at(-1).path === '/api/config/get');
  await s.app.stop();
  const ack = await pending;
  assert.match(ack.error, /intégration arrêtée/);
  await sleep(50);
  assert.equal(triggers(s.fake).length, 0);
});

test('own opening mark past 30 minutes at the reading that brings its entry: the entry is an event', async (t) => {
  const s = await setup(t, { config: { poll_interval: 300 } });
  s.fake.doorLog = [doorEntry(1)];
  await s.ready();
  await s.advance(1000); // the opening 1 s after the reading
  await press(s.gladys, 'a');
  s.fake.status['/api/doorlog/get'] = 500;
  for (let i = 0; i < 5; i += 1) await cycle(s, 0, i === 0 ? 299_000 : 300_000);
  delete s.fake.status['/api/doorlog/get'];
  await cycle(s, 0, 300_000); // 30 min: a baseline, the mark still young enough
  assert.equal(s.session().ownOpens.length, 1);
  s.fake.doorLog.unshift(doorEntry(2, { Type: 'Remote', Name: '' }));
  await cycle(s, 0, 300_000); // 35 min
  assert.equal(s.gladys.fake.sceneEvents.length, 1);
});
