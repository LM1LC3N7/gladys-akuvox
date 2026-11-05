// -----------------------------------------------------------------------------
// /data: bounded reads (size, time, regular file only), an unreadable file is
// not an empty one, writes in order, the latest wins; the fingerprint of
// refused credentials says almost nothing about them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, emptyData, fingerprint, sanitize } from '../src/store.js';
import { within } from './helpers/app.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'akuvox-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('missing: empty; garbage, too large, a FIFO, a link: unreadable, within the bound', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path });
  assert.equal((await store.load()).state, 'empty');
  await writeFile(store.path, '{not json');
  assert.equal((await store.load()).state, 'unreadable');
  await writeFile(store.path, 'x'.repeat(70 * 1024));
  assert.equal((await store.load()).state, 'unreadable');
  await rm(store.path);
  execFileSync('mkfifo', [store.path]);
  const started = Date.now();
  assert.equal((await within(store.load(), 5000, 'FIFO load')).state, 'unreadable');
  assert.ok(Date.now() - started < 3000);
  // A FIFO holding valid data is refused too (never a regular file).
  const writer = await open(store.path, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => writer.close().catch(() => {}));
  await writer.write(JSON.stringify(emptyData()));
  assert.equal((await within(store.load(), 5000, 'FIFO load')).state, 'unreadable');
  await writer.close();
  await rm(store.path);
  await writeFile(join(path, 'real.json'), JSON.stringify(emptyData()));
  await symlink(join(path, 'real.json'), store.path);
  assert.equal((await store.load()).state, 'unreadable', 'a symbolic link is not followed');
});

test('round trip; the latest write wins; the file is private', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path });
  const data = emptyData();
  data.refused['192.168.1.50'] = { fp: 'ab', at: 1000 };
  const a = store.save({ ...data, refused: {} });
  const b = store.save(data);
  const c = store.save(data);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  const loaded = await store.load();
  assert.equal(loaded.state, 'ok');
  assert.deepEqual(loaded.data.refused, data.refused);
  assert.equal(loaded.data.salt, data.salt);
  const text = await readFile(store.path, 'utf8');
  assert.ok(!text.includes('password'));
});

test('sanitize: unknown keys, bad addresses, bad fingerprints and future dates dropped', () => {
  const clean = sanitize(
    {
      salt: 'f'.repeat(32),
      refused: {
        '192.168.1.50': { fp: 'a1', at: 5 },
        '192.168.1.51': { fp: 'zz', at: 5 },
        'bad host': { fp: 'a1', at: 5 },
        '192.168.1.52': { fp: 'a1', at: 9e15 },
        __proto__: { fp: 'a1' },
      },
      extra: 1,
    },
    1000,
  );
  assert.deepEqual(Object.keys(clean.refused).sort(), ['192.168.1.50', '192.168.1.52']);
  assert.equal(clean.refused['192.168.1.52'].at, 1000);
  assert.equal(clean.extra, undefined);
  assert.notEqual(sanitize({ salt: 'short' }).salt, 'short');
  assert.deepEqual(sanitize(null).refused, {});
});

test('fingerprint: 8 bits, salted, per address; brute force finds hundreds of passwords', () => {
  const salt = 'a'.repeat(32);
  const config = { auth: 'digest', username: 'gladys', password: 'S3cret' };
  const fp = fingerprint(salt, '192.168.1.50', config);
  assert.match(fp, /^[0-9a-f]{2}$/);
  assert.notEqual(fingerprint('b'.repeat(32), '192.168.1.50', config), undefined);
  // Out of 100 000 candidates, about 390 share it: the fingerprint names no password.
  let matches = 0;
  for (let i = 0; i < 100_000; i += 1) {
    if (fingerprint(salt, '192.168.1.50', { ...config, password: `p${i}` }) === fp) matches += 1;
  }
  assert.ok(matches > 200, `${matches}`);
});

test('memory store: failures and a stuck disk on demand', async () => {
  const store = new MemoryStore();
  store.failing = true;
  assert.equal(await store.save(emptyData()), false);
  assert.equal(
    (await new MemoryStore(undefined, { state: 'unreadable' }).load()).state,
    'unreadable',
  );
});

test('a disk that never answers: unreadable within the bound, never awaited for ever', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, openFile: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal((await within(store.load(), 5000, 'stuck load')).state, 'unreadable');
  assert.ok(Date.now() - started < 3000);
});
