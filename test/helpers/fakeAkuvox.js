// -----------------------------------------------------------------------------
// A fake Akuvox door phone on a real loopback HTTP server, built from the
// pylocal-akuvox 1.7.0 test fixtures (envelopes, /api/system/info,
// /api/relay/status, logs, /api/relay/trig) and RFC 7616 for Digest (checked
// here by an implementation of its own, not the integration's).
//
// Knobs (all live): `auth`, `latency` (per path, ms), `silent` (paths that
// never answer), `status` (path -> HTTP status), `retcode` (path -> retcode),
// `body` (path -> raw text), `relays`, `config`, `doorLog`, `callLog`, `mac`.
// Records: `requests` [{ method, path, query, headers, json }], `connections`.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const USER = 'gladys';
export const PASSWORD = 'S3cret-Pass_9!';
export const MAC = 'AA:BB:CC:DD:EE:01';
export const MAC_ID = 'aabbccddee01';

const md5 = (text) => createHash('md5').update(text).digest('hex');

function digestParams(header) {
  const params = {};
  for (const [, key, quoted, plain] of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[key] = quoted ?? plain;
  }
  return params;
}

export async function startFakeAkuvox(options = {}) {
  const fake = {
    auth: 'digest',
    username: USER,
    password: PASSWORD,
    realm: 'HTTPAPI',
    nonce: randomBytes(8).toString('hex'),
    mac: MAC,
    model: 'X916S',
    firmware: '916.30.10.114',
    relays: { RelayA: 'closed', RelayB: 'closed' },
    config: {
      'Config.DoorSetting.RELAY.RelayAMode': '0',
      'Config.DoorSetting.RELAY.RelayAType': '0',
      'Config.DoorSetting.RELAY.NameA': 'Portail',
      'Config.DoorSetting.RELAY.RelayBMode': '0',
      'Config.DoorSetting.RELAY.RelayBType': '0',
      'Config.DoorSetting.DEVICENODE.Location': 'Entrée',
      'Config.Account1.GENERAL.Password': 'sip-password-never-read',
    },
    doorLog: [],
    callLog: [],
    latency: {},
    silent: new Set(),
    drop: new Set(),
    status: {},
    retcode: {},
    body: {},
    /** The relay a trigger releases, unless false. */
    releaseOnTrigger: true,
    requests: [],
    connections: 0,
    openSockets: new Set(),
    ...options,
  };

  const checkAuth = (req) => {
    if (fake.auth === 'none') return true;
    const header = req.headers.authorization ?? '';
    if (fake.auth === 'basic') {
      const expected = `Basic ${Buffer.from(`${fake.username}:${fake.password}`).toString('base64')}`;
      return header === expected;
    }
    if (!header.startsWith('Digest ')) return false;
    const p = digestParams(header.slice(7));
    if (p.username !== fake.username || p.nonce !== fake.nonce || p.realm !== fake.realm)
      return false;
    if (p.uri !== req.url) return false;
    const ha1 = md5(`${fake.username}:${fake.realm}:${fake.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return p.response === expected;
  };

  const envelope = (path, data) =>
    JSON.stringify({ retcode: fake.retcode[path] ?? 0, action: 'get', message: 'OK', data });

  const answer = (path, json) => {
    switch (path) {
      case '/api/system/info':
        return envelope(path, {
          Status: {
            Model: fake.model,
            MAC: fake.mac,
            FirmwareVersion: fake.firmware,
            HardwareVersion: '1.0',
            Uptime: '1d',
          },
        });
      case '/api/relay/status':
        return envelope(path, { ...fake.relays });
      case '/api/config/get':
        return envelope(path, { ...fake.config });
      case '/api/doorlog/get':
        return envelope(path, { num: fake.doorLog.length, curPageNum: 1, item: fake.doorLog });
      case '/api/calllog/get':
        return envelope(path, { num: fake.callLog.length, curPageNum: 1, item: fake.callLog });
      case '/api/relay/trig': {
        const num = json?.data?.num;
        if (fake.releaseOnTrigger && Number.isInteger(num) && num >= 1 && num <= 4) {
          const key = `Relay${'ABCD'[num - 1]}`;
          if (key in fake.relays) fake.relays[key] = 'open';
        }
        return JSON.stringify({
          retcode: fake.retcode[path] ?? 0,
          action: 'trig',
          message: 'OK',
          data: {},
        });
      }
      default:
        return undefined;
    }
  };

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size < 65536) chunks.push(chunk);
    });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://fake');
      const path = url.pathname;
      let json;
      try {
        json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        json = undefined;
      }
      const authorized = checkAuth(req);
      fake.requests.push({
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        json,
        authorized,
        // Connections open when this request arrived (itself included).
        open: fake.openSockets.size,
      });
      if (fake.silent.has(path)) return; // never answers
      if (fake.drop.has(path)) {
        // Received (and acted on), then the connection is cut without an answer.
        if (path === '/api/relay/trig') answer(path, json);
        req.socket.destroy();
        return;
      }
      // The answer is what the device holds when the request ARRIVES (a slow
      // answer carries an old state), the trigger acts at once.
      const text =
        authorized && !fake.status[path] ? (fake.body[path] ?? answer(path, json)) : undefined;
      const wait = fake.latency[path] ?? fake.latency['*'] ?? 0;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!authorized) {
        const challenge =
          fake.auth === 'basic'
            ? `Basic realm="${fake.realm}"`
            : `Digest realm="${fake.realm}", qop="auth", nonce="${fake.nonce}", algorithm=MD5`;
        res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'text/html' });
        res.end('<html>401</html>');
        return;
      }
      if (fake.status[path]) {
        res.writeHead(fake.status[path], { 'Content-Type': 'text/html' });
        res.end('error');
        return;
      }
      if (text === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(text);
    });
  });
  server.on('connection', (socket) => {
    fake.connections += 1;
    fake.openSockets.add(socket);
    socket.on('close', () => fake.openSockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.host = `127.0.0.1:${fake.port}`;
  fake.count = (method, path) =>
    fake.requests.filter((r) => r.method === method && r.path === path).length;
  fake.close = () =>
    new Promise((resolve) => {
      for (const socket of fake.openSockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}

/** A door log entry as pylocal-akuvox's fixtures show it. */
export const doorEntry = (id, extra = {}) => ({
  ID: String(id),
  Date: '2026-11-05',
  Time: '09:30:00',
  Name: 'Alice',
  Code: '4321',
  Type: 'PIN',
  Relay: '1',
  Status: 'Succ',
  ...extra,
});

export const callEntry = (id, extra = {}) => ({
  ID: String(id),
  Date: '2026-11-05',
  Time: '14:30:00',
  Name: 'Appartement 12',
  Type: 'Dialed',
  LocalIdentity: 'sip:100@192.168.1.1',
  Num: '1',
  ...extra,
});
