// -----------------------------------------------------------------------------
// One request: Digest (RFC 2617/7616 vectors and the fake device), Basic, the
// refusals, the bounds (size, time), what counts as sent.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { digestHeader, parseChallenges, request } from '../src/http.js';
import { MAC, PASSWORD, USER, startFakeAkuvox } from './helpers/fakeAkuvox.js';
import { within } from './helpers/app.js';

const auth = (mode = 'digest', password = PASSWORD) => ({ mode, username: USER, password });
const hostOf = (fake) => ({ address: '127.0.0.1', port: fake.port });

test('Digest: the RFC 2617 vector, SHA-256, -sess, quoting', () => {
  const challenge = parseChallenges(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  ).digest;
  const header = digestHeader(
    { username: 'Mufasa', password: 'Circle Of Life' },
    challenge,
    'GET',
    '/dir/index.html',
    1,
    '0a4f113b',
  );
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  // RFC 7616 3.9.1, SHA-256.
  const sha = digestHeader(
    { username: 'Mufasa', password: 'Circle of Life' },
    {
      realm: 'http-auth@example.org',
      qop: 'auth',
      algorithm: 'SHA-256',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    },
    'GET',
    '/dir/index.html',
    1,
    'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  );
  assert.match(sha, /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
  assert.match(
    digestHeader({ username: 'a"b', password: 'p' }, { nonce: 'n' }, 'GET', '/', 1, 'c'),
    /username="a\\"b"/,
  );
  assert.ok(
    digestHeader(
      { username: 'u', password: 'p' },
      { nonce: 'n', algorithm: 'MD5-sess', qop: 'auth' },
      'GET',
      '/',
      1,
      'c',
    ),
  );
  assert.equal(
    digestHeader(
      { username: 'u', password: 'p' },
      { nonce: 'n', algorithm: 'SHA-512' },
      'GET',
      '/',
      1,
      'c',
    ),
    undefined,
  );
  assert.equal(
    digestHeader(
      { username: 'u', password: 'p' },
      { nonce: 'n', qop: 'auth-int' },
      'GET',
      '/',
      1,
      'c',
    ),
    undefined,
  );
  // Several schemes in one header; no prototype pollution.
  const both = parseChallenges('Basic realm="x", Digest realm="y", nonce="z", __proto__="w"');
  assert.equal(both.basic.realm, 'x');
  assert.equal(both.digest.nonce, 'z');
  assert.equal({}.w, undefined);
  assert.deepEqual(parseChallenges('x'.repeat(5000)), {});
});

test('Digest on the fake device: two exchanges the first time, one after; the password never travels', async (t) => {
  const fake = await startFakeAkuvox();
  t.after(() => fake.close());
  const session = {};
  const first = await request({
    host: hostOf(fake),
    path: '/api/system/info',
    auth: auth(),
    session,
    timeout: 2000,
  });
  assert.equal(first.status, 200);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  await request({
    host: hostOf(fake),
    path: '/api/relay/status',
    auth: auth(),
    session,
    timeout: 2000,
  });
  assert.equal(fake.requests.length, 3, 'the cached challenge is reused');
  // A new nonce (the device restarted): answered once more.
  fake.nonce = 'fresh-nonce';
  await request({
    host: hostOf(fake),
    path: '/api/relay/status',
    auth: auth(),
    session,
    timeout: 2000,
  });
  assert.equal(fake.requests.length, 5);
  for (const r of fake.requests) {
    assert.ok(!JSON.stringify(r.headers).includes(PASSWORD));
  }
  assert.ok(
    fake.requests.every(
      (r) => !r.headers.authorization || r.headers.authorization.startsWith('Digest '),
    ),
  );
});

test('Digest refused: a refusal after one answered challenge, nothing sent, no loop', async (t) => {
  const fake = await startFakeAkuvox();
  t.after(() => fake.close());
  await assert.rejects(
    request({
      host: hostOf(fake),
      path: '/api/system/info',
      auth: auth('digest', 'wrong'),
      session: {},
      timeout: 2000,
    }),
    (err) => err.kind === 'refused' && err.sent === false,
  );
  assert.equal(fake.requests.length, 2);
});

test('Digest configured, the device asks for Basic: the password is never sent', async (t) => {
  const fake = await startFakeAkuvox({ auth: 'basic' });
  t.after(() => fake.close());
  await assert.rejects(
    request({
      host: hostOf(fake),
      path: '/api/system/info',
      auth: auth(),
      session: {},
      timeout: 2000,
    }),
    { kind: 'basic-only' },
  );
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].headers.authorization, undefined);
});

test('Basic and none', async (t) => {
  const basic = await startFakeAkuvox({ auth: 'basic' });
  const none = await startFakeAkuvox({ auth: 'none' });
  t.after(() => Promise.all([basic.close(), none.close()]));
  const answer = await request({
    host: hostOf(basic),
    path: '/api/system/info',
    auth: auth('basic'),
    timeout: 2000,
  });
  assert.equal(answer.status, 200);
  assert.equal(basic.requests.length, 1);
  await assert.rejects(
    request({
      host: hostOf(basic),
      path: '/api/system/info',
      auth: auth('basic', 'bad'),
      timeout: 2000,
    }),
    { kind: 'refused' },
  );
  assert.equal(
    (await request({ host: hostOf(none), path: '/api/system/info', timeout: 2000 })).status,
    200,
  );
  assert.equal(none.requests[0].headers.authorization, undefined);
});

test('an answer too large is cut before it is read in full (declared or streamed)', async (t) => {
  const server = createServer((socket) => {
    socket.once('data', (data) => {
      const declared = data.toString().includes('/declared');
      socket.write(
        declared
          ? 'HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n'
          : 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
      );
      if (!declared) {
        const chunk = 'x'.repeat(16384);
        const timer = setInterval(() => {
          if (socket.destroyed) return clearInterval(timer);
          socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        }, 1);
        socket.on('close', () => clearInterval(timer));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = { address: '127.0.0.1', port: server.address().port };
  for (const path of ['/declared', '/streamed']) {
    await assert.rejects(
      within(request({ host, path, timeout: 5000, maxBody: 64 * 1024 }), 4000),
      (err) => err.kind === 'answer' && err.sent === true,
    );
  }
});

test('bounds and "sent": silent device, closed port, abort, withdrawn before the write', async (t) => {
  const fake = await startFakeAkuvox({ auth: 'none' });
  t.after(() => fake.close());
  fake.silent.add('/api/relay/status');
  const started = Date.now();
  await assert.rejects(
    request({ host: hostOf(fake), path: '/api/relay/status', timeout: 300 }),
    (err) => err.kind === 'timeout' && err.sent === true,
  );
  assert.ok(Date.now() - started < 1500);
  // A closed port: never sent.
  const closed = await startFakeAkuvox();
  const port = closed.port;
  await closed.close();
  await assert.rejects(
    request({ host: { address: '127.0.0.1', port }, path: '/api/system/info', timeout: 1000 }),
    (err) => err.kind === 'offline' && err.sent === false,
  );
  // Aborted by the caller.
  const controller = new AbortController();
  const pending = request({
    host: hostOf(fake),
    path: '/api/relay/status',
    timeout: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(within(pending, 2000), (err) => err.kind === 'aborted' && err.sent === true);
  // Withdrawn: not a byte of the request written.
  const before = fake.count('POST', '/api/relay/trig');
  await assert.rejects(
    request({
      host: hostOf(fake),
      method: 'POST',
      path: '/api/relay/trig',
      json: { a: 1 },
      timeout: 1000,
      beforeSend: () => false,
    }),
    (err) => err.kind === 'withdrawn' && err.sent === false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.count('POST', '/api/relay/trig'), before);
  assert.equal(MAC.length, 17);
});
