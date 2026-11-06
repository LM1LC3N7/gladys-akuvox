// -----------------------------------------------------------------------------
// The pure parts: configuration, the API answers of the device, the logs and
// the rate limits. Fixtures from pylocal-akuvox 1.7.0's tests.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHost } from '../src/config.js';
import {
  callType,
  cleanText,
  doorSuccess,
  normalizeMac,
  parseAnswer,
  parseInfo,
  parseLog,
  parseRelayConfig,
  parseRelayStatus,
  relayTriggered,
  triggerBody,
} from '../src/akuvox.js';
import { LIMITS } from '../src/constants.js';
import { LogTracker, RateLimiter } from '../src/events.js';
import { CREDENTIAL } from '../src/session.js';

const ok = (data, extra = {}) => ({
  status: 200,
  text: JSON.stringify({ retcode: 0, action: 'get', message: 'OK', data, ...extra }),
});

test('addresses: IPv4 or host name, optional port; never any, broadcast, multicast or junk', () => {
  assert.deepEqual(parseHost('192.168.1.50'), {
    address: '192.168.1.50',
    port: 80,
    key: '192.168.1.50',
  });
  assert.deepEqual(parseHost(' 192.168.1.50:8080 '), {
    address: '192.168.1.50',
    port: 8080,
    key: '192.168.1.50:8080',
  });
  assert.equal(parseHost('DoorPhone.lan').key, 'doorphone.lan');
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.1.2.3',
    '192.168.1.50:0',
    '192.168.1.50:65536',
    '192.168.1.256',
    'http://192.168.1.50',
    '192.168.1.50/api',
    'user@192.168.1.50',
    '192.168.1.50\r\nX: y',
    '-bad.lan',
    '',
    '   ',
    undefined,
    42,
    '[::1]',
  ]) {
    assert.equal(parseHost(bad), undefined, String(bad));
  }
});

test('configuration: bounded, deduplicated, a password never without a user', () => {
  const c = normalizeConfig({
    hosts: '192.168.1.50, 192.168.1.50:80; bad host, 192.168.1.51:8080',
    auth: 'digest',
    username: 'gladys',
    password: 'pw',
    poll_interval: 1,
    open_seconds: 999,
    allow_open: 'true',
  });
  assert.deepEqual(
    c.hosts.map((h) => h.key),
    ['192.168.1.50', '192.168.1.51:8080'],
  );
  assert.equal(c.invalid, 1);
  assert.equal(c.pollMs, 5000);
  assert.equal(c.openSeconds, 30);
  assert.equal(c.allowOpen, true);
  assert.equal(c.problem, undefined);
  assert.equal(normalizeConfig({ hosts: '192.168.1.50', open_seconds: 0 }).openSeconds, 1);
  assert.equal(normalizeConfig({ hosts: '192.168.1.50', poll_interval: '' }).pollMs, 10_000);
  assert.equal(normalizeConfig({ hosts: '192.168.1.50', poll_interval: 'x' }).pollMs, 10_000);
  // Defaults: opening off, Digest.
  const d = normalizeConfig({ hosts: '192.168.1.50', username: 'u', password: 'p' });
  assert.equal(d.allowOpen, false);
  assert.equal(d.auth, 'digest');
  assert.equal(d.openSeconds, DEFAULT_CONFIG.open_seconds);
  assert.equal(normalizeConfig({ hosts: '192.168.1.50', allow_open: 'yes' }).allowOpen, false);
  // Problems.
  assert.equal(normalizeConfig({}).problem, 'noHost');
  assert.equal(normalizeConfig({ hosts: 'nope nope' }).problem, 'hostsInvalid');
  assert.equal(
    normalizeConfig({ hosts: '192.168.1.50', password: 'p' }).problem,
    'credentialsMissing',
  );
  assert.equal(
    normalizeConfig({ hosts: '192.168.1.50', username: 'u' }).problem,
    'credentialsMissing',
  );
  assert.equal(
    normalizeConfig({ hosts: '192.168.1.50', auth: 'basic', username: 'u', password: 'p\n' })
      .problem,
    'credentialsMissing',
  );
  assert.equal(
    normalizeConfig({ hosts: '192.168.1.50', username: 'a:b', password: 'p' }).problem,
    'credentialsMissing',
  );
  const none = normalizeConfig({
    hosts: '192.168.1.50',
    auth: 'none',
    username: 'u',
    password: 'p',
  });
  assert.equal(none.problem, undefined);
  assert.equal(none.password, '', 'no password kept without authentication');
  const many = Array.from({ length: 10 }, (_, i) => `192.168.1.${i + 1}`).join(',');
  const capped = normalizeConfig({ hosts: many, auth: 'none' });
  assert.equal(capped.hosts.length, LIMITS.hosts);
});

test('envelope: retcode, unsupported markers, HTTP statuses; prototype keys dropped', () => {
  assert.deepEqual(parseAnswer(ok({ a: 1 })), { a: 1 });
  assert.deepEqual(parseAnswer({ status: 200, text: '{"retcode":0}' }), {});
  const kind = (answer) => {
    try {
      parseAnswer(answer);
    } catch (err) {
      return err.kind;
    }
    return 'ok';
  };
  assert.equal(kind(ok({}, { retcode: -1 })), 'device');
  assert.equal(kind(ok({}, { message: 'Api unsupported' })), 'unsupported');
  assert.equal(kind({ status: 200, text: '{"retcode":"0"}' }), 'answer');
  assert.equal(kind({ status: 200, text: '<html>' }), 'answer');
  assert.equal(kind({ status: 403, text: '' }), 'forbidden');
  assert.equal(kind({ status: 404, text: '' }), 'unsupported');
  assert.equal(kind({ status: 500, text: '' }), 'device');
  assert.equal(kind({ status: 302, text: '' }), 'answer');
  const data = parseAnswer({
    status: 200,
    text: '{"retcode":0,"data":{"__proto__":{"x":1},"y":2}}',
  });
  assert.equal(data.x, undefined);
  assert.equal({}.x, undefined);
});

test('identity: the MAC address, unicast, else unreadable', () => {
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:01'), 'aabbccddee01');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-01'), 'aabbccddee01');
  assert.equal(normalizeMac('AABBCCDDEE01'), 'aabbccddee01');
  for (const bad of [
    '00:00:00:00:00:00',
    'FF:FF:FF:FF:FF:FF',
    '01:00:5E:00:00:01',
    'AA:BB:CC:DD:EE',
    'AA:BB-CC:DD:EE:01',
    42,
    undefined,
  ]) {
    assert.equal(normalizeMac(bad), undefined, String(bad));
  }
  assert.deepEqual(
    parseInfo({
      Status: { Model: 'X916S', MAC: 'AA:BB:CC:DD:EE:FF', FirmwareVersion: '916.30.10.114' },
    }),
    { mac: 'aabbccddeeff', model: 'X916S', firmware: '916.30.10.114' },
  );
  assert.throws(() => parseInfo({ Status: { Model: 'X916S' } }), { kind: 'answer' });
  assert.throws(() => parseInfo({}), { kind: 'answer' });
  assert.equal(
    parseInfo({ Status: { MAC: 'AA:BB:CC:DD:EE:FF', Model: 'x\u0000y'.repeat(30) } }).model.length,
    32,
  );
});

test('relays: A to D only; strings, and integers only with a known type', () => {
  const relays = parseRelayStatus({ RelayA: 'open', RelayB: 'closed', RelayE: 'open', relayC: 1 });
  assert.deepEqual([...relays.keys()], ['a', 'b']);
  assert.equal(relayTriggered('open'), true);
  assert.equal(relayTriggered('Active'), true);
  assert.equal(relayTriggered('closed'), false);
  assert.equal(relayTriggered('inactive'), false);
  assert.equal(relayTriggered('weird'), undefined);
  assert.equal(relayTriggered(1, 0), true);
  assert.equal(relayTriggered(0, 0), false);
  assert.equal(relayTriggered(0, 1), true);
  assert.equal(relayTriggered(1, 1), false);
  assert.equal(relayTriggered('1', 0), true);
  assert.equal(relayTriggered(1, undefined), undefined, 'an integer without its type is unknown');
  assert.equal(relayTriggered(2, 0), undefined);
  assert.equal(relayTriggered(null, 0), undefined);
  // Wrapped in an object (as the reference reads it).
  assert.equal(relayTriggered({ state: 1 }, 0), true);
  assert.equal(relayTriggered({ state: 'closed' }), false);
  assert.equal(relayTriggered({}, 0), undefined);
});

test('relay configuration: mode, type, names, location; nothing else kept', () => {
  const config = parseRelayConfig({
    'Config.DoorSetting.RELAY.RelayAMode': '1',
    'Config.DoorSetting.RELAY.RelayAType': 0,
    'Config.DoorSetting.RELAY.NameA': 'Portail\n',
    'Config.DoorSetting.RELAY.RelayBMode': '7',
    'Config.DoorSetting.RELAY.RelayBType': '',
    'Config.DoorSetting.DEVICENODE.Location': 'Entrée',
    'Config.Account1.GENERAL.Password': 'secret',
  });
  assert.deepEqual(config.relays.get('a'), { mode: 1, type: 0, name: 'Portail' });
  assert.deepEqual(config.relays.get('b'), { mode: undefined, type: undefined, name: '' });
  assert.equal(config.location, 'Entrée');
  assert.ok(!JSON.stringify([...config.relays.values()]).includes('secret'));
});

test('trigger: automatic close (mode 0), the level and the duration given', () => {
  assert.deepEqual(triggerBody({ num: 2, level: 1, delay: 5 }), {
    target: 'relay',
    action: 'trig',
    data: { num: 2, mode: 0, level: 1, delay: 5 },
  });
});

test('logs: numeric IDs only, bounded, the PIN or card code never read', () => {
  const door = parseLog(
    {
      item: [
        { ID: '42', Name: 'Alice', Code: '1234', Type: 'PIN', Relay: '1', Status: 'Succ' },
        { ID: 'x', Name: 'Bob' },
        { ID: '43.5', Name: 'Bob' },
        { ID: 44, Name: 'Carol\u0007', Code: '9999', Type: 'Card', Relay: '2', Status: 'Failed' },
        'junk',
        null,
      ],
    },
    'door',
  );
  assert.deepEqual(
    door.map((e) => e.id),
    [42, 44],
  );
  assert.ok(!JSON.stringify(door).includes('1234') && !JSON.stringify(door).includes('9999'));
  assert.equal(door[1].name, 'Carol');
  assert.deepEqual(parseLog({ item: 'x' }, 'door'), []);
  assert.deepEqual(parseLog({}, 'call'), []);
  const many = parseLog(
    { item: Array.from({ length: 500 }, (_, i) => ({ ID: String(i) })) },
    'call',
  );
  assert.equal(many.length, LIMITS.logItems);
  assert.equal(cleanText('a'.repeat(100)).length, LIMITS.text);
  assert.equal(doorSuccess('Succ'), true);
  assert.equal(doorSuccess('Failed'), false);
  assert.equal(doorSuccess('?'), undefined);
  assert.equal(callType('Dialed'), 'dialed');
  assert.equal(callType('Received'), 'received');
  assert.equal(callType('Missed'), 'missed');
  assert.equal(callType('Conference'), 'other');
});

test('log tracker: a baseline first, then only new IDs; cleared log, gap, bounded', () => {
  const tracker = new LogTracker();
  const e = (...ids) => ids.map((id) => ({ id }));
  assert.deepEqual(tracker.update(e(1, 2, 3), 0, 1000), { fresh: [], dropped: 0, baseline: true });
  assert.deepEqual(
    tracker.update(e(4, 2, 3), 100, 1000).fresh.map((x) => x.id),
    [4],
  );
  assert.deepEqual(tracker.update(e(4, 3), 200, 1000).fresh, []);
  // Cleared: the top went down -> new baseline, nothing published.
  assert.equal(tracker.update(e(1), 300, 1000).baseline, true);
  assert.deepEqual(
    tracker.update(e(1, 2), 400, 1000).fresh.map((x) => x.id),
    [2],
  );
  // An empty answer keeps the baseline.
  assert.deepEqual(tracker.update([], 500, 1000).fresh, []);
  assert.deepEqual(
    tracker.update(e(3), 600, 1000).fresh.map((x) => x.id),
    [3],
  );
  // A gap longer than the bound: baseline again.
  assert.equal(tracker.update(e(9), 1601, 1000).baseline, true);
  // At most LIMITS.eventsPerRead, the newest ones.
  const burst = tracker.update(e(10, 11, 12, 13, 14, 15, 16, 17), 1700, 1000);
  assert.deepEqual(
    burst.fresh.map((x) => x.id),
    [13, 14, 15, 16, 17],
  );
  assert.equal(burst.dropped, 3);
  // A first answer that is empty is no baseline: the next one is.
  const empty = new LogTracker();
  assert.equal(empty.update([], 0, 1000).baseline, true);
  assert.deepEqual(empty.update(e(5, 6), 100, 1000), { fresh: [], dropped: 0, baseline: true });
  assert.deepEqual(
    empty.update(e(7), 200, 1000).fresh.map((x) => x.id),
    [7],
  );
  // A clock that went back is a gap.
  assert.equal(empty.update(e(8), 100, 1000).baseline, true);
});

test('rate limiter: a sliding minute', () => {
  const limiter = new RateLimiter(3, 60_000);
  assert.ok(limiter.take(0) && limiter.take(1) && limiter.take(2));
  assert.equal(limiter.take(3), false);
  assert.equal(limiter.take(59_999), false);
  assert.equal(limiter.take(60_000), true);
});

test('credential methods: whole words only', () => {
  for (const method of [
    'PIN',
    'Private PIN',
    'Card',
    'RF Card',
    'RFID',
    'Face',
    'Fingerprint',
    'QR Code',
    'NFC',
    'BLE',
    'Bluetooth',
    'License Plate',
    'Password',
    'Temp Key',
    'TempKey',
  ]) {
    assert.match(method, CREDENTIAL, method);
  }
  for (const method of [
    'HTTP',
    'Remote',
    'Interface',
    'Cable',
    'Button',
    'Exit',
    'API',
    'Call',
    '',
  ]) {
    assert.doesNotMatch(method, CREDENTIAL, method);
  }
});
