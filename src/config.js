// -----------------------------------------------------------------------------
// The configuration, normalized: every value bounded, every address checked.
// DEFAULT_CONFIG mirrors the manifest defaults (test/manifest.test.js).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, OPEN_SECONDS, POLL } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
  auth: 'digest',
  poll_interval: POLL.default,
  allow_open: false,
  open_seconds: OPEN_SECONDS.default,
  language: 'fr',
});

export const AUTH_MODES = ['none', 'basic', 'digest'];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** An IPv4 address that is not a device: any, broadcast, multicast, reserved. */
function unusableIpv4(address) {
  const [a] = address.split('.').map(Number);
  return a === 0 || a >= 224;
}

/**
 * "192.168.1.50" or "192.168.1.50:8080" or "doorphone.lan" -> { address, port, key }.
 * undefined when it is not a usable device address.
 */
export function parseHost(text) {
  if (typeof text !== 'string') return undefined;
  const value = text.trim();
  if (!value || value.length > 260 || CONTROL.test(value) || /[\s/@?#\\[\]]/.test(value)) {
    return undefined;
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return undefined;
  const address = match[1].toLowerCase();
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (isIP(address) === 4) {
    if (unusableIpv4(address)) return undefined;
  } else if (/^[\d.]+$/.test(address) || !HOSTNAME.test(address)) {
    return undefined;
  }
  return { address, port, key: port === 80 ? address : `${address}:${port}` };
}

const boundedInt = (value, { min, max, default: fallback }) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

const cleanSecret = (value) =>
  typeof value === 'string' && value !== '' && !CONTROL.test(value) ? value : '';

/**
 * -> { hosts: [{ address, port, key }], invalid (count, the text is never shown back), auth, username,
 *      password, pollMs, allowOpen, openSeconds, language, problem }
 * `problem` is a key of i18n (a configuration that cannot run), or undefined.
 */
export function normalizeConfig(raw = {}) {
  const config = raw ?? {};
  const hosts = [];
  let invalid = 0;
  const seen = new Set();
  const list = typeof config.hosts === 'string' ? config.hosts.split(/[,;\n]/) : [];
  for (const entry of list) {
    if (!entry.trim()) continue;
    const host = parseHost(entry);
    if (!host) {
      invalid += 1;
      continue;
    }
    if (seen.has(host.key)) continue;
    seen.add(host.key);
    hosts.push(host);
  }
  const auth = AUTH_MODES.includes(config.auth) ? config.auth : DEFAULT_CONFIG.auth;
  const rawUser = typeof config.username === 'string' ? config.username.trim() : '';
  const username = CONTROL.test(rawUser) || rawUser.includes(':') ? '' : rawUser;
  const password = cleanSecret(config.password);
  let problem;
  if (hosts.length === 0) problem = invalid ? 'hostsInvalid' : 'noHost';
  else if (hosts.length > LIMITS.hosts) problem = 'tooManyHosts';
  else if (auth !== 'none' && (!username || !password)) problem = 'credentialsMissing';
  return {
    hosts: hosts.slice(0, LIMITS.hosts),
    invalid,
    auth,
    username: auth === 'none' ? '' : username,
    password: auth === 'none' ? '' : password,
    pollMs: boundedInt(config.poll_interval, POLL) * 1000,
    allowOpen: bool(config.allow_open),
    openSeconds: boundedInt(config.open_seconds, OPEN_SECONDS),
    language: config.language === 'en' ? 'en' : 'fr',
    problem,
  };
}
