// -----------------------------------------------------------------------------
// One request to the HTTP API of an Akuvox device, on node:http:
// - a new TCP connection per request (no keep-alive, as pylocal-akuvox's
//   `force_close`), so "connected" means "this request may now be written";
// - `beforeSend()`, called once the connection is up, right before the
//   request is written: anything but true withdraws it (nothing written);
// - the answer read up to `maxBody` bytes, then cut;
// - one budget for the whole request (`timeout`), the Digest exchange
//   included, and an AbortSignal (a command takes the device from a reading);
// - an error that tells whether the request may have reached the device
//   (`sent`): a refused or timed out connection never did, a 401 did nothing.
// Authentication: none, Basic (the password in every request, in clear on
// the local network), or Digest (RFC 7616, MD5 or SHA-256): with Digest the
// password never leaves; a device that asks for Basic while Digest is
// configured gets nothing. Neither the password nor the Authorization header
// is ever logged.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { LIMITS } from './constants.js';

/**
 * kind:
 * - `offline`: no connection (nothing sent);
 * - `withdrawn`: `beforeSend` said no (nothing sent);
 * - `aborted`: taken back by the caller (sent if `sent`);
 * - `timeout`: no (complete) answer in time;
 * - `lost`: the connection ended after the write;
 * - `refused`: the device refused the credentials (401), nothing done;
 * - `forbidden`: 403 (address not allowed), nothing done;
 * - `unsupported`: 404 or "api unsupported";
 * - `device`: 5xx or a negative retcode;
 * - `answer`: an answer that is not what was expected (or too large).
 */
export class AkuvoxError extends Error {
  constructor(message, kind, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
  }
}

const hash = (algorithm, text) =>
  createHash(algorithm.startsWith('SHA-256') ? 'sha256' : 'md5')
    .update(text)
    .digest('hex');

/**
 * The Digest challenge of a WWW-Authenticate header, or undefined. Node joins
 * several such headers with ", ": a parameter belongs to the last scheme seen.
 */
export function parseChallenges(header) {
  if (typeof header !== 'string' || header.length > 4096) return {};
  const schemes = {};
  let current;
  for (const [, name, value] of header.matchAll(
    /([A-Za-z][\w-]*)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*))?/g,
  )) {
    if (value === undefined) {
      const scheme = name.toLowerCase();
      current = schemes[scheme] = Object.create(null);
    } else if (current) {
      current[name.toLowerCase()] = value.startsWith('"')
        ? value.slice(1, -1).replace(/\\(.)/g, '$1')
        : value;
    }
  }
  return schemes;
}

const quote = (text) => `"${String(text).replace(/(["\\])/g, '\\$1')}"`;

/** The Authorization header of a Digest challenge (RFC 7616). */
export function digestHeader({ username, password }, challenge, method, uri, nc, cnonce) {
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  if (!['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm)) return undefined;
  const qops = (challenge.qop ?? '').split(',').map((q) => q.trim().toLowerCase());
  const qop = qops.includes('auth') ? 'auth' : undefined;
  if (challenge.qop && !qop) return undefined; // auth-int only: not supported
  let ha1 = hash(algorithm, `${username}:${challenge.realm ?? ''}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(algorithm, `${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = hash(algorithm, `${method}:${uri}`);
  const ncText = nc.toString(16).padStart(8, '0');
  const response = qop
    ? hash(algorithm, `${ha1}:${challenge.nonce}:${ncText}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm ?? '')}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `algorithm=${challenge.algorithm ?? 'MD5'}`,
    `response=${quote(response)}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncText}`, `cnonce=${quote(cnonce)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

/** One HTTP exchange on a new connection. Resolves { status, headers, text, sent: true }. */
function exchange({ host, method, path, headers, body, signal, beforeSend, maxBody }) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const req = httpRequest({
      host: host.address,
      port: host.port,
      method,
      path,
      agent: false,
      headers: {
        Accept: 'application/json',
        ...headers,
        Connection: 'close',
        ...(body !== undefined
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : {}),
      },
    });
    const onAbort = () => {
      done(reject, new AkuvoxError('Taken back', 'aborted', { sent: connected }));
      req.destroy();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('socket', (socket) => {
      const ready = () => {
        if (settled) return;
        const veto = beforeSend();
        if (veto !== true) {
          done(
            reject,
            veto instanceof AkuvoxError ? veto : new AkuvoxError('Withdrawn', 'withdrawn'),
          );
          req.destroy();
          return;
        }
        connected = true;
        req.end(body);
      };
      if (socket.connecting) socket.once('connect', ready);
      else ready();
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBody) {
        done(reject, new AkuvoxError('Answer too large', 'answer', { sent: true }));
        req.destroy();
        return;
      }
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBody) {
          done(reject, new AkuvoxError('Answer too large', 'answer', { sent: true }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        done(resolve, {
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', () =>
        done(reject, new AkuvoxError('Connection lost', 'lost', { sent: true })),
      );
      res.on('aborted', () =>
        done(reject, new AkuvoxError('Connection lost', 'lost', { sent: true })),
      );
    });
    req.on('error', (err) =>
      done(
        reject,
        new AkuvoxError(
          connected ? 'Connection lost' : (err.code ?? 'Connection failed'),
          connected ? 'lost' : 'offline',
          {
            sent: connected,
          },
        ),
      ),
    );
  });
}

/**
 * A request with its authentication and its budget. `session` keeps the last
 * Digest challenge of the device (and its counter), so a reading needs one
 * exchange, not two.
 * Resolves { status, text }; rejects an AkuvoxError.
 */
export async function request({
  host,
  method = 'GET',
  path,
  json,
  auth = { mode: 'none' },
  session = {},
  timeout,
  signal,
  beforeSend = () => true,
  maxBody = LIMITS.maxBody,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  const body = json === undefined ? undefined : JSON.stringify(json);
  let sentOnce = false;
  try {
    for (let round = 0; round < 2; round += 1) {
      const headers = {};
      if (auth.mode === 'basic') {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      } else if (auth.mode === 'digest' && session.challenge) {
        session.nc = (session.nc ?? 0) + 1;
        const value = digestHeader(
          auth,
          session.challenge,
          method,
          path,
          session.nc,
          randomBytes(8).toString('hex'),
        );
        if (value) headers.Authorization = value;
      }
      let answer;
      try {
        answer = await exchange({
          host,
          method,
          path,
          headers,
          body,
          signal: controller.signal,
          beforeSend,
          maxBody,
        });
      } catch (err) {
        if (err.kind === 'aborted' && timedOut) {
          throw new AkuvoxError(
            err.sent ? 'No answer in time' : 'Connection timed out',
            err.sent ? 'timeout' : 'offline',
            { sent: err.sent },
          );
        }
        throw err;
      }
      sentOnce = true;
      if (answer.status !== 401) return answer;
      // 401: nothing was done. With Digest, a first or stale challenge is
      // answered once; anything else is a refusal.
      const challenges = parseChallenges(answer.headers['www-authenticate']);
      const digest = challenges.digest;
      const fresh =
        auth.mode === 'digest' &&
        digest?.nonce &&
        (!session.challenge ||
          String(digest.stale).toLowerCase() === 'true' ||
          digest.nonce !== session.challenge.nonce);
      if (round === 0 && fresh) {
        session.challenge = digest;
        session.nc = 0;
        continue;
      }
      if (auth.mode === 'digest') session.challenge = undefined;
      const basicOnly = auth.mode === 'digest' && !digest && challenges.basic;
      throw new AkuvoxError(
        basicOnly ? 'The device asks for Basic' : 'Credentials refused',
        basicOnly ? 'basic-only' : 'refused',
        { status: 401 },
      );
    }
    throw new AkuvoxError('Credentials refused', 'refused', { status: 401 });
  } catch (err) {
    if (err instanceof AkuvoxError) {
      // A 401 round reached the device but did nothing: only the last round counts.
      if (err.kind === 'refused' || err.kind === 'basic-only') err.sent = false;
      throw err;
    }
    throw new AkuvoxError('Request failed', 'offline', { sent: sentOnce });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
