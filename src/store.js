// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data/akuvox.json (the one
// writable volume): the credentials a device REFUSED, as an 8-bit salted
// fingerprint per address (never a password, never a fingerprint of a
// password that works), so a restart never tries refused credentials again
// in a loop (a device may lock its API after a few failures). Removed at the
// first success; a changed password has 255 chances in 256 to look new, and
// the test button always tries once.
//
// Bounded: the file is read within TIMINGS.storeTimeout, at most
// LIMITS.storeBytes, and must be a regular file (a FIFO or a device is
// refused, never waited on). An unreadable file is not an empty one: it is
// never overwritten. Writes go one at a time, the latest data wins; nobody
// awaits them (a stuck disk never holds a command or a reading).
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHost } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';
import { isObject, safeJson } from './json.js';

export const newSalt = () => randomBytes(16).toString('hex');
export const emptyData = () => ({ salt: newSalt(), refused: {} });

const HEX_DIGITS = Math.ceil(LIMITS.refusedBits / 4);

/** The fingerprint of credentials, truncated: says "maybe the same", never the password. */
export function fingerprint(salt, hostKey, { auth, username, password }) {
  return createHmac('sha256', salt)
    .update(`${hostKey}\n${auth}\n${username}\n${password}`)
    .digest('hex')
    .slice(0, HEX_DIGITS);
}

/** What a file holds, checked: unknown keys dropped, dates never in the future. */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) return base;
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) base.salt = data.salt;
  if (isObject(data.refused)) {
    for (const [key, entry] of Object.entries(data.refused).slice(0, LIMITS.hosts * 4)) {
      if (parseHost(key)?.key !== key || !isObject(entry)) continue;
      if (typeof entry.fp !== 'string' || !new RegExp(`^[0-9a-f]{${HEX_DIGITS}}$`).test(entry.fp)) {
        continue;
      }
      const at = Number.isFinite(entry.at) && entry.at <= now ? entry.at : now;
      base.refused[key] = { fp: entry.fp, at };
    }
  }
  return base;
}

const withTimeout = (promise, ms, onLate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onLate?.();
      reject(new Error('timeout'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'akuvox.json',
    now = Date.now,
    openFile = open,
  } = {}) {
    this.openFile = openFile;
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
    this.chain = Promise.resolve();
    this.pending = undefined;
  }

  /** -> { data, state: 'ok' | 'empty' | 'unreadable' } within the bound. */
  async load() {
    let handle;
    const read = async () => {
      // O_NONBLOCK: opening a FIFO never waits for a writer.
      handle = await this.openFile(
        this.path,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > LIMITS.storeBytes) throw new Error('too large');
      const buffer = Buffer.alloc(LIMITS.storeBytes + 1);
      let bytesRead = 0;
      for (;;) {
        let n;
        try {
          ({ bytesRead: n } = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            null,
          ));
        } catch (err) {
          if (err?.code === 'EAGAIN') break; // nothing more for now
          throw err;
        }
        if (n === 0) break;
        bytesRead += n;
        if (bytesRead >= buffer.length) break;
      }
      if (bytesRead > LIMITS.storeBytes) throw new Error('too large');
      return buffer.subarray(0, bytesRead).toString('utf8');
    };
    try {
      const text = await withTimeout(read(), TIMINGS.storeTimeout);
      return { data: sanitize(safeJson(text), this.now()), state: 'ok' };
    } catch (err) {
      if (err?.code === 'ENOENT') return { data: emptyData(), state: 'empty' };
      return { data: emptyData(), state: 'unreadable' };
    } finally {
      handle?.close().catch(() => {});
    }
  }

  /**
   * Writes `data` (a copy is taken now). Resolves true when written, false
   * otherwise; one write at a time, a later call replaces a waiting one.
   */
  save(data) {
    const text = JSON.stringify(data);
    const waiting = this.pending;
    this.pending = { text, resolvers: [] };
    const job = this.pending;
    if (waiting) {
      // The waiting write is replaced: its callers learn the outcome of this one.
      job.resolvers.push(...waiting.resolvers);
      waiting.replaced = true;
    }
    const result = new Promise((resolve) => job.resolvers.push(resolve));
    if (!waiting) {
      this.chain = this.chain.then(async () => {
        const current = this.pending;
        this.pending = undefined;
        let ok;
        try {
          await mkdir(this.dir, { recursive: true });
          const temporary = `${this.path}.${process.pid}.tmp`;
          await writeFile(temporary, current.text, { mode: 0o600 });
          await rename(temporary, this.path);
          ok = true;
        } catch {
          ok = false;
        }
        for (const resolve of current.resolvers) resolve(ok);
      });
    }
    return result;
  }
}

/** For the tests: in memory, with failures and delays on demand. */
export class MemoryStore {
  constructor(data = emptyData(), { state = 'ok', now = Date.now } = {}) {
    this.data = structuredClone(data);
    this.state = state;
    this.saves = 0;
    this.now = now;
    this.failing = false;
    /** A promise the next writes wait for (a stuck disk). */
    this.stuck = undefined;
  }

  async load() {
    if (this.state === 'unreadable') return { data: emptyData(), state: 'unreadable' };
    return { data: sanitize(structuredClone(this.data), this.now()), state: this.state };
  }

  async save(data) {
    if (this.stuck) await this.stuck;
    if (this.failing) return false;
    this.data = structuredClone(data);
    this.saves += 1;
    return true;
  }
}
