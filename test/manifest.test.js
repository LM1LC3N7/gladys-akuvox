// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTH_MODES, DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, OPEN_SECONDS, POLL, TRIGGERS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics, one version everywhere, never pinned by hand twice', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-akuvox:${manifest.version}`);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Akuvox|sans\s+lien\s+avec\s+Akuvox/i);
    assert.match(docs, /never tested with a real device|jamais testé avec un vrai appareil/i);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no network capture, no extra container, no webhook', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.webhooks, undefined);
});

test('the configuration matches the code; opening is off; the secret has no default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.default, undefined);
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.equal(field.default, undefined, field.key);
  }
  assert.ok(manifest.config_schema.every((f) => !f.key.toLowerCase().startsWith('gladys_')));
  assert.equal(fields.allow_open.default, false);
  assert.equal(fields.allow_open.type, 'boolean');
  assert.deepEqual(fields.auth.options.map((o) => o.value).sort(), [...AUTH_MODES].sort());
  assert.deepEqual(
    [fields.open_seconds.min, fields.open_seconds.max, fields.open_seconds.default],
    [OPEN_SECONDS.min, OPEN_SECONDS.max, OPEN_SECONDS.default],
  );
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL.min, POLL.max, POLL.default],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr'])
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  // Option labels: plain non-empty text, no space around, unique values.
  for (const field of manifest.config_schema.filter((f) => f.options)) {
    for (const option of field.options) {
      for (const lang of ['en', 'fr']) {
        assert.equal(typeof option.label[lang], 'string');
        assert.equal(option.label[lang], option.label[lang].trim());
        assert.ok(option.label[lang]);
      }
    }
    assert.equal(new Set(field.options.map((o) => o.value)).size, field.options.length);
  }
});

test('the actions and scene triggers are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((s) => s.key).sort(),
    Object.values(TRIGGERS).sort(),
  );
  for (const trigger of manifest.scene_triggers) {
    assert.ok(trigger.variables.length <= 30);
    for (const field of trigger.fields) {
      assert.ok(!field.required, `${trigger.key}.${field.key}: optional filter`);
      for (const option of field.options ?? []) {
        assert.equal(option.label.fr, option.label.fr.trim());
      }
    }
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});
